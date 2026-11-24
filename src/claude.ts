import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLine, readLinesReverse } from "./jsonl.js";
import type { TtlTier } from "./pricing.js";

export interface RequestUsage {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

export interface ClaudeSessionState {
  model: string;
  /** Tokens the last main-conversation request sent: cache read + cache write + uncached input. */
  contextTokens: number;
  /** When the last request started; the cache lifetime counts from here. */
  lastRequestStart: Date;
  /** TTL tier of the most recent cache write, if any write is recorded. */
  ttl: TtlTier | undefined;
  lastUsage: RequestUsage;
}

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
};

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** Session IDs are UUIDs, so the transcript is `projects/<any>/<id>.jsonl`. */
export function findTranscript(sessionId: string): string | undefined {
  const projects = join(claudeConfigDir(), "projects");
  if (!existsSync(projects)) return undefined;
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(projects, entry.name, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function readClaudeSession(transcriptPath: string): ClaudeSessionState {
  let last: { model: string; usage: Usage; at: Date } | undefined;
  let requestStart: Date | undefined;
  let ttl: TtlTier | undefined;

  for (const line of readLinesReverse(transcriptPath)) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
    const record = parseLine(line);
    if (!record || record.isSidechain === true || typeof record.timestamp !== "string") continue;
    const at = new Date(record.timestamp);

    if (record.type === "assistant") {
      const message = record.message as { model?: string; usage?: Usage } | undefined;
      const usage = message?.usage;
      if (!usage || !message?.model || message.model === "<synthetic>") continue;
      if (!last) last = { model: message.model, usage, at };
      if (!ttl) ttl = writeTier(usage);
    } else if (record.type === "user" && last && !requestStart) {
      // The newest user-side record before the last response is what triggered that request.
      requestStart = at;
    }
    if (last && requestStart && ttl) break;
  }

  if (!last) throw new Error(`transcript 里没有找到带 usage 的主会话请求：${transcriptPath}`);
  const usage = toRequestUsage(last.usage);
  return {
    model: last.model,
    contextTokens: usage.cacheRead + usage.cacheWrite + usage.input,
    lastRequestStart: requestStart ?? last.at,
    ttl,
    lastUsage: usage,
  };
}

/**
 * When the user first typed a prompt after `since`, judged from record metadata rather than message text.
 * Typed and queued prompts carry `origin.kind: "human"` and a `promptSource`. Slash commands, including the
 * start command whose own record lands just after `since`, carry no `promptSource`; monitor notifications
 * and tool results carry no human origin.
 */
export function userReturnedAt(transcriptPath: string, since: Date): Date | undefined {
  let earliest: Date | undefined;
  for (const line of readLinesReverse(transcriptPath)) {
    if (!line.includes('"type":"user"')) continue;
    const record = parseLine(line);
    if (!record || record.type !== "user" || typeof record.timestamp !== "string") continue;
    const at = new Date(record.timestamp);
    if (at <= since) break;
    if ((record.origin as { kind?: unknown } | undefined)?.kind === "human" && record.promptSource !== undefined) earliest = at;
  }
  return earliest;
}

/** Start times of the main-conversation requests after `since`, newest first. */
export function requestStartsSince(transcriptPath: string, since: Date): Date[] {
  const starts: Date[] = [];
  let answered = false;
  for (const line of readLinesReverse(transcriptPath)) {
    if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
    const record = parseLine(line);
    if (!record || record.isSidechain === true || typeof record.timestamp !== "string") continue;
    const at = new Date(record.timestamp);
    if (at <= since) break;
    const message = record.message as { model?: string; usage?: Usage } | undefined;
    if (record.type === "assistant") {
      if (message?.usage && message.model && message.model !== "<synthetic>") answered = true;
    } else if (answered) {
      // Reading backwards, the newest user-side record before a response is what triggered that request.
      starts.push(at);
      answered = false;
    }
  }
  return starts;
}

function writeTier(usage: Usage): TtlTier | undefined {
  const creation = usage.cache_creation;
  if ((creation?.ephemeral_1h_input_tokens ?? 0) > 0) return "1h";
  if ((creation?.ephemeral_5m_input_tokens ?? 0) > 0) return "5m";
  return undefined;
}

function toRequestUsage(usage: Usage): RequestUsage {
  return {
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
  };
}
