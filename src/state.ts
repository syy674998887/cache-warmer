import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseLine } from "./jsonl.js";

/** The user came back to a warm cache, came back after it expired (or never did), or the run broke off. */
export type Outcome = "warm" | "cold" | "failed";

/** Format of the state files; a monitor started before an update that changed it cannot run newer runs. */
export const STATE_VERSION = 3;
/** A monitor that has not written its heartbeat for this long is gone. It writes one on every 15-second poll. */
const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_PRUNE_MS = 24 * 60 * 60_000;

/** One keep-warm run for one session, shared between the start/stop commands and the monitor. */
export interface KeeperState {
  version: typeof STATE_VERSION;
  sessionId: string;
  /** Where the session runs, for the history. */
  cwd: string;
  /** Prices when the run started, in basis points of the base input price; coldBp also prices each refresh's cache writes. */
  readBp: number;
  coldBp: number;
  outputBp: number;
  inputUsdPerMTok: number | null;
  status: "active" | "stopped";
  startedAt: string;
  /** Start + declared away time + grace; no refresh is fired for a cache that already outlives it. */
  deadline: string;
  ttlMinutes: number;
  leadMinutes: number;
  /** Refreshes the declared window needs, and the most the monitor will fire. */
  plannedBeats: number;
  maxBeats: number;
  beats: number;
  /** Set while a beat has been emitted and its reply has not been verified yet. */
  awaitingSince: string | null;
  /** Context size when the run started: what a cold resume would have rewritten, so the baseline of the saving. */
  contextTokens: number;
  /** Context size when the pending beat was emitted; its reply must read most of it from cache. */
  contextBeforeBeat: number | null;
  /** What the refreshes actually cost, tokens x basis points. */
  spentScaled: number;
  awake: boolean;
  stopReason: string | null;
  /** Set when refreshing ends before the user is back: the cache stays warm until then. */
  warmUntil: string | null;
  outcome: Outcome | null;
  endedAt: string | null;
  /** What keeping warm saved against a cold resume, negative when it did not pay off; tokens x basis points. */
  savedScaled: number | null;
  /** Whether the user has seen the run's summary, from the Stop hook or the stop command. */
  summaryShown: boolean;
}

/** What a run shows in its summary and in the history, whichever CLI kept the cache warm. */
export type RunRecord = Pick<
  KeeperState,
  "sessionId" | "cwd" | "startedAt" | "beats" | "spentScaled" | "savedScaled" | "outcome" | "endedAt" | "warmUntil" | "stopReason" | "inputUsdPerMTok"
> & {
  /** Refreshes that missed the cache: a Codex run goes on after one, while the Claude monitor stops at the first. */
  misses?: number;
};

function statePath(dataDir: string, sessionId: string): string {
  return join(dataDir, "sessions", `${sessionId}.json`);
}

export function readState(dataDir: string, sessionId: string): KeeperState | undefined {
  const path = statePath(dataDir, sessionId);
  if (!existsSync(path)) return undefined;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as KeeperState;
    return state.version === STATE_VERSION ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Write-then-rename, so the monitor never reads a half-written file. */
export function writeState(dataDir: string, state: KeeperState): void {
  const path = statePath(dataDir, state.sessionId);
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Runs of every session whose outcome is still open. */
export function openStates(dataDir: string): KeeperState[] {
  const dir = join(dataDir, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readState(dataDir, name.slice(0, -".json".length)))
    .filter((state): state is KeeperState => state !== undefined && state.outcome === null);
}

/** The stored state while it is still this run: a stale snapshot must not overwrite a newer run or a settled one. */
export function sameRun(dataDir: string, state: KeeperState): KeeperState | undefined {
  const stored = readState(dataDir, state.sessionId);
  return stored?.startedAt === state.startedAt ? stored : undefined;
}

export function stopState(state: KeeperState, reason: string): KeeperState {
  return { ...state, status: "stopped", awaitingSince: null, contextBeforeBeat: null, stopReason: reason };
}

/**
 * When the run's cache expires, given the requests after its start: each request made before the cache expired
 * extends it to one TTL after that request; a request made at or after expiry rebuilt the cache instead, so neither
 * it nor any later request counts for this run.
 */
export function effectiveExpiry(state: Pick<KeeperState, "startedAt" | "ttlMinutes">, requestStarts: Date[]): number {
  let expiry = new Date(state.startedAt).getTime() + state.ttlMinutes * 60_000;
  for (const start of requestStarts.map((d) => d.getTime()).sort((a, b) => a - b)) {
    if (start >= expiry) break;
    expiry = start + state.ttlMinutes * 60_000;
  }
  return expiry;
}

/** The outcome when the user shows up at `at`: warm if the cache never expired before then. */
export function returnOutcome(state: Pick<KeeperState, "startedAt" | "ttlMinutes">, at: Date, requestStarts: Date[]): Outcome {
  return at.getTime() < effectiveExpiry(state, requestStarts.filter((start) => start < at)) ? "warm" : "cold";
}

/** What keeping warm saved against a cold resume: without it, the cache left at the start of the run would have lasted one TTL. */
export function netSavingScaled(
  run: Pick<KeeperState, "startedAt" | "ttlMinutes" | "coldBp" | "readBp" | "contextTokens" | "spentScaled">,
  outcome: Outcome,
  at: Date,
): number {
  const coldBy = new Date(run.startedAt).getTime() + run.ttlMinutes * 60_000;
  const avoided = outcome === "warm" && at.getTime() > coldBy ? (run.coldBp - run.readBp) * run.contextTokens : 0;
  return avoided - run.spentScaled;
}

/**
 * Settles a run: what keeping warm saved, then its line in the history. Returns undefined when the session has moved
 * on to a newer run, and the stored result when someone else settled this one first.
 */
export function finishRun(dataDir: string, state: KeeperState, outcome: Outcome, at: Date): KeeperState | undefined {
  const stored = sameRun(dataDir, state);
  if (!stored || stored.outcome !== null) return stored;
  const final: KeeperState = { ...state, outcome, endedAt: at.toISOString(), savedScaled: netSavingScaled(state, outcome, at) };
  writeState(dataDir, final);
  appendFileSync(historyPath(dataDir), `${JSON.stringify(final)}\n`);
  return final;
}

function historyPath(dataDir: string): string {
  return join(dataDir, "history.jsonl");
}

/** Settled runs of every session, oldest first; a run settled twice in a race counts once. */
export function readHistory(dataDir: string): KeeperState[] {
  const path = historyPath(dataDir);
  if (!existsSync(path)) return [];
  const runs = new Map<string, KeeperState>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const state = parseLine(line) as KeeperState | undefined;
    if (state?.version === STATE_VERSION) runs.set(`${state.sessionId} ${state.startedAt}`, state);
  }
  return [...runs.values()];
}

function heartbeatPath(dataDir: string, sessionId: string): string {
  return join(dataDir, "monitors", sessionId);
}

/** The monitor's sign of life, holding the state format it reads. */
export function writeHeartbeat(dataDir: string, sessionId: string, now = new Date()): void {
  const path = heartbeatPath(dataDir, sessionId);
  mkdirSync(join(dataDir, "monitors"), { recursive: true });
  writeFileSync(path, String(STATE_VERSION));
  utimesSync(path, now, now);
}

/** Whether a monitor that reads this state format polled for the session within the last minute. */
export function monitorAlive(dataDir: string, sessionId: string, now = new Date()): boolean {
  try {
    const path = heartbeatPath(dataDir, sessionId);
    return readFileSync(path, "utf8") === String(STATE_VERSION) && now.getTime() - statSync(path).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** Drops the heartbeats of sessions that ended a day ago or more. */
export function pruneHeartbeats(dataDir: string, now = new Date()): void {
  const dir = join(dataDir, "monitors");
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (now.getTime() - statSync(path).mtimeMs > HEARTBEAT_PRUNE_MS) rmSync(path, { force: true });
  }
}
