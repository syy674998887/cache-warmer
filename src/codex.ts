import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, readLinesReverse } from "./jsonl.js";

export interface CodexThreadState {
  model: string;
  /** Input tokens of the last request (Codex counts cached tokens inside input). */
  contextTokens: number;
  /** Present when the session runs on a ChatGPT plan. */
  planType: string | undefined;
  /** When the last request started; the cache lifetime counts from here. */
  lastRequestStart: Date;
  /** A compaction happened after the last request, so its cached prefix is gone. */
  compactedSinceLastRequest: boolean;
}

type TokenCountInfo = { last_token_usage?: { input_tokens?: number } };

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Every rollout on disk, compressed ones and archived threads included. */
export function allRollouts(): string[] {
  return ["sessions", "archived_sessions"].flatMap((dir) => {
    const root = join(codexHome(), dir);
    if (!existsSync(root)) return [];
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("rollout-") && /\.jsonl(\.zst)?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      // Codex compresses rollouts left alone for a week; both files exist for a moment, and the plain one is current.
      .filter((path) => !path.endsWith(".zst") || !existsSync(path.slice(0, -".zst".length)));
  });
}

/** Rollout files are named `rollout-<timestamp>-<thread id>.jsonl` under `sessions/YYYY/MM/DD/`. */
export function findRollout(threadId: string): string | undefined {
  const root = join(codexHome(), "sessions");
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`)) {
      return join(entry.parentPath, entry.name);
    }
  }
  return undefined;
}

export function readCodexThread(rolloutPath: string): CodexThreadState {
  let info: TokenCountInfo | undefined;
  let responseAt: Date | undefined;
  let requestStart: Date | undefined;
  let planType: string | undefined;
  let model: string | undefined;
  let compacted = false;

  for (const line of readLinesReverse(rolloutPath)) {
    const record = parseLine(line);
    if (!record || typeof record.timestamp !== "string") continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const at = new Date(record.timestamp);

    if (record.type === "compacted" && !info) compacted = true;
    if (record.type === "turn_context" && !model && typeof payload.model === "string") model = payload.model;
    if (record.type === "event_msg" && payload.type === "token_count") {
      const rateLimits = payload.rate_limits as { plan_type?: string } | undefined;
      if (!planType && rateLimits?.plan_type) planType = rateLimits.plan_type;
      const candidate = payload.info as TokenCountInfo | undefined;
      if (!info && candidate?.last_token_usage) {
        info = candidate;
        responseAt = at;
      }
    }
    if (info && !requestStart && record.type === "response_item" && triggersRequest(payload)) {
      requestStart = at;
    }
    if (info && requestStart && model && planType) break;
  }

  if (!info || !responseAt) throw new Error("本会话还没有完成过一次请求，读不到用量。先发一条消息，再执行 $cache-warmer:start。");
  return {
    model: model ?? "unknown",
    contextTokens: info.last_token_usage?.input_tokens ?? 0,
    planType,
    lastRequestStart: requestStart ?? responseAt,
    compactedSinceLastRequest: compacted,
  };
}

/** User messages and tool outputs are what start the next model request. */
function triggersRequest(payload: Record<string, unknown>): boolean {
  if (payload.type === "message") return payload.role === "user";
  return typeof payload.type === "string" && payload.type.endsWith("_output");
}
