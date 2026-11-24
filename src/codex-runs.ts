import { readFileSync } from "node:fs";
// A default import: Node before 22.15 has no zstd, and a named import would keep every command from loading at all.
import zlib from "node:zlib";
import { allRollouts } from "./codex.js";
import { parseLine, readLinesReverse } from "./jsonl.js";
import { MIN_HIT_RATIO } from "./monitor.js";
import { coldResumeBp, lookupModel, type PricingTable } from "./pricing.js";
import { codexSleepMs, codexTtlMinutes } from "./session.js";
import { effectiveExpiry, netSavingScaled, returnOutcome, type RunRecord } from "./state.js";

interface Usage {
  /** Counts the cached tokens too. */
  input: number;
  cached: number;
  output: number;
}

/** One keep-warm run. Codex keeps warm inside a turn and no plugin process watches it, so the rollout is the only record. */
export interface CodexRun {
  threadId: string;
  cwd: string;
  model: string;
  /** Present when the session runs on a ChatGPT plan. */
  planType: string | undefined;
  /** The turn the model slept in. */
  turnId: string;
  startedAt: Date;
  /** Input tokens of the request that began the sleeping: what a cold resume would have processed again. */
  contextTokens: number;
  /** A sleep ending is what starts each refresh request. */
  requestStarts: Date[];
  refreshes: Usage[];
  /** When the user was first there again: a message, or Esc ending the turn. */
  presentAt: Date | undefined;
  /** The turn of the user's first message after the run began, whose end is when they get the summary. */
  returnTurn: string | undefined;
}

type Payload = {
  type?: string;
  id?: string;
  source?: { subagent?: unknown };
  cwd?: string;
  model?: string;
  turn_id?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  rate_limits?: { plan_type?: string };
  item?: { type?: string };
};

/** Only a call has this, escaped inside its arguments: every rollout also lists the tools, sleep among them, under `additional_tools`. */
const SLEEP_CALL = '\\"duration_ms\\"';
/** The records a run is worked out from; each is told apart by its type, so message text is never looked at. */
const RELEVANT = /"type":"(?:session_meta|turn_context|token_usage_record|task_started|turn_aborted|token_count|function_call|function_call_output|UserMessage)"/;

/** The keep-warm runs of one rollout, oldest first. Other sleeps have other lengths: models also sleep to wait for work. */
export function readKeepWarmRuns(path: string, table: PricingTable): CodexRun[] {
  const raw = readFileSync(path);
  const content = path.endsWith(".zst") ? zlib.zstdDecompressSync(raw) : raw;
  // A whole-file search first, as few rollouts have any sleep at all.
  if (!content.includes(SLEEP_CALL)) return [];

  const runs: CodexRun[] = [];
  const sleeping = new Set<string>();
  let threadId = "";
  let cwd = "";
  let model = "unknown";
  let planType: string | undefined;
  let turn = "";
  let lastInput = 0;
  let run: CodexRun | undefined;

  for (const line of content.toString("utf8").split("\n")) {
    if (!RELEVANT.test(line)) continue;
    const record = parseLine(line);
    if (!record || typeof record.timestamp !== "string") continue;
    const payload = (record.payload ?? {}) as Payload;
    const at = new Date(record.timestamp);
    switch (record.type) {
      case "session_meta":
        // A subagent forked from a thread repeats the thread's records, its runs included; only a user's own thread keeps warm.
        if (payload.source?.subagent) return [];
        threadId = payload.id ?? threadId;
        cwd = payload.cwd ?? cwd;
        break;
      case "turn_context":
        model = payload.model ?? model;
        cwd = payload.cwd ?? cwd;
        break;
      case "token_usage_record": {
        const usage = toUsage(payload);
        lastInput = usage.input;
        if (!run || run.turnId !== payload.turn_id || run.presentAt) break;
        // Until the first sleep ends, this is the request that called it, not a refresh.
        if (run.requestStarts.length === 0) run.contextTokens = usage.input;
        else run.refreshes.push(usage);
        break;
      }
      case "event_msg":
        if (payload.type === "task_started") turn = payload.turn_id ?? turn;
        else if (payload.type === "token_count") planType ??= payload.rate_limits?.plan_type;
        else if (payload.type === "turn_aborted" && run && run.turnId === payload.turn_id) run.presentAt ??= at;
        else if (payload.type === "item_completed" && payload.item?.type === "UserMessage" && run && !run.returnTurn) {
          run.returnTurn = payload.turn_id;
          run.presentAt ??= at;
        }
        break;
      case "response_item":
        if (payload.type === "function_call" && payload.name === "sleep") {
          if (parseLine(payload.arguments ?? "")?.duration_ms !== codexSleepMs(lookupModel(model, table))) break;
          sleeping.add(payload.call_id!);
          // Starting again in the same turn, while the user is here, is a new run.
          if (!run || run.turnId !== turn || run.presentAt) {
            run = {
              threadId,
              cwd,
              model,
              planType,
              turnId: turn,
              startedAt: at,
              contextTokens: lastInput,
              requestStarts: [],
              refreshes: [],
              presentAt: undefined,
              returnTurn: undefined,
            };
            runs.push(run);
          }
        } else if (payload.type === "function_call_output" && sleeping.delete(payload.call_id!)) {
          run?.requestStarts.push(at);
        }
        break;
    }
  }
  return runs.map((r) => ({ ...r, planType: r.planType ?? planType }));
}

function toUsage(payload: Payload): Usage {
  return { input: payload.usage?.input_tokens ?? 0, cached: payload.usage?.cached_input_tokens ?? 0, output: payload.usage?.output_tokens ?? 0 };
}

/** The keep-warm runs of every rollout. */
export function allKeepWarmRuns(table: PricingTable): CodexRun[] {
  return allRollouts().flatMap((path) => readKeepWarmRuns(path, table));
}

/**
 * Whether the model slept in the turn that just ended or in the one before: only then can that turn be the one the
 * user came back in. It reads just the end of the rollout, as the Stop hook runs on every turn.
 */
export function sleptRecently(path: string): boolean {
  let turns = 0;
  for (const line of readLinesReverse(path)) {
    if (line.includes(SLEEP_CALL)) return true;
    if (line.includes('"type":"task_started"') && ++turns === 2) return false;
  }
  return false;
}

/**
 * What a run cost and how it ended, by the same rules as a Claude run, priced with the table at hand. `outcome` is
 * null while the user is not back and the cache has not expired yet.
 */
export function settleCodexRun(run: CodexRun, table: PricingTable, now = new Date()): RunRecord {
  const price = lookupModel(run.model, table);
  const coldBp = coldResumeBp(price, "5m", run.planType ? "codex-credits" : "api");
  const outputBp = price.outputBp ?? 50000;
  const spentScaled = run.refreshes.reduce((total, u) => total + u.cached * price.readBp + (u.input - u.cached) * coldBp + u.output * outputBp, 0);
  const startedAt = run.startedAt.toISOString();
  const basis = { startedAt, ttlMinutes: codexTtlMinutes(price), readBp: price.readBp, coldBp, contextTokens: run.contextTokens, spentScaled };
  const record = {
    sessionId: run.threadId,
    cwd: run.cwd,
    startedAt,
    beats: run.refreshes.length,
    spentScaled,
    stopReason: null,
    inputUsdPerMTok: price.inputUsdPerMTok ?? null,
    misses: run.refreshes.filter((u) => u.cached / u.input < MIN_HIT_RATIO).length,
  };
  if (run.presentAt) {
    const outcome = returnOutcome(basis, run.presentAt, run.requestStarts);
    return { ...record, outcome, endedAt: run.presentAt.toISOString(), warmUntil: null, savedScaled: netSavingScaled(basis, outcome, run.presentAt) };
  }
  const expiry = effectiveExpiry(basis, run.requestStarts);
  const warmUntil = new Date(expiry).toISOString();
  if (now.getTime() < expiry) return { ...record, outcome: null, endedAt: null, warmUntil, savedScaled: null };
  return { ...record, outcome: "cold", endedAt: warmUntil, warmUntil, savedScaled: -spentScaled };
}
