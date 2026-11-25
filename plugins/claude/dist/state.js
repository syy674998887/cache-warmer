import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir } from "./claude.js";
import { parseLine } from "./jsonl.js";
/** Format of the state files; a monitor started before an update that changed it cannot run newer runs. */
export const STATE_VERSION = 3;
/** A monitor that has not written its heartbeat for this long is gone. It writes one on every 15-second poll. */
const HEARTBEAT_STALE_MS = 60_000;
const HEARTBEAT_PRUNE_MS = 24 * 60 * 60_000;
/** Where the standalone skill keeps its state: it has no plugin data directory. */
export function defaultDataDir() {
    return join(claudeConfigDir(), "cache-warmer");
}
function statePath(dataDir, sessionId) {
    return join(dataDir, "sessions", `${sessionId}.json`);
}
export function readState(dataDir, sessionId) {
    const path = statePath(dataDir, sessionId);
    if (!existsSync(path))
        return undefined;
    try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        return state.version === STATE_VERSION ? state : undefined;
    }
    catch {
        return undefined;
    }
}
/** Write-then-rename, so the monitor never reads a half-written file. */
export function writeState(dataDir, state) {
    const path = statePath(dataDir, state.sessionId);
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, path);
}
/** Runs of every session whose outcome is still open. */
export function openStates(dataDir) {
    const dir = join(dataDir, "sessions");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => readState(dataDir, name.slice(0, -".json".length)))
        .filter((state) => state !== undefined && state.outcome === null);
}
/** The stored state while it is still this run: a stale snapshot must not overwrite a newer run or a settled one. */
export function sameRun(dataDir, state) {
    const stored = readState(dataDir, state.sessionId);
    return stored?.startedAt === state.startedAt ? stored : undefined;
}
export function stopState(state, reason) {
    return { ...state, status: "stopped", awaitingSince: null, contextBeforeBeat: null, stopReason: reason };
}
/**
 * When the run's cache expires, given the requests after its start: each request made before the cache expired
 * extends it to one TTL after that request; a request made at or after expiry rebuilt the cache instead, so neither
 * it nor any later request counts for this run.
 */
export function effectiveExpiry(state, requestStarts) {
    let expiry = new Date(state.startedAt).getTime() + state.ttlMinutes * 60_000;
    for (const start of requestStarts.map((d) => d.getTime()).sort((a, b) => a - b)) {
        if (start >= expiry)
            break;
        expiry = start + state.ttlMinutes * 60_000;
    }
    return expiry;
}
/** The outcome when the user shows up at `at`: warm if the cache never expired before then. */
export function returnOutcome(state, at, requestStarts) {
    return at.getTime() < effectiveExpiry(state, requestStarts.filter((start) => start < at)) ? "warm" : "cold";
}
/** What keeping warm saved against a cold resume: without it, the cache left at the start of the run would have lasted one TTL. */
export function netSavingScaled(run, outcome, at) {
    const coldBy = new Date(run.startedAt).getTime() + run.ttlMinutes * 60_000;
    const avoided = outcome === "warm" && at.getTime() > coldBy ? (run.coldBp - run.readBp) * run.contextTokens : 0;
    return avoided - run.spentScaled;
}
/**
 * Settles a run: what keeping warm saved, then its line in the history. Returns undefined when the session has moved
 * on to a newer run, and the stored result when someone else settled this one first.
 */
export function finishRun(dataDir, state, outcome, at) {
    const stored = sameRun(dataDir, state);
    if (!stored || stored.outcome !== null)
        return stored;
    const final = { ...state, outcome, endedAt: at.toISOString(), savedScaled: netSavingScaled(state, outcome, at) };
    writeState(dataDir, final);
    appendFileSync(historyPath(dataDir), `${JSON.stringify(final)}\n`);
    return final;
}
function historyPath(dataDir) {
    return join(dataDir, "history.jsonl");
}
/** Settled runs of every session, oldest first; a run settled twice in a race counts once. */
export function readHistory(dataDir) {
    const path = historyPath(dataDir);
    if (!existsSync(path))
        return [];
    const runs = new Map();
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const state = parseLine(line);
        if (state?.version === STATE_VERSION)
            runs.set(`${state.sessionId} ${state.startedAt}`, state);
    }
    return [...runs.values()];
}
function heartbeatPath(dataDir, sessionId) {
    return join(dataDir, "monitors", sessionId);
}
/** The monitor's sign of life, holding the state format it reads. */
export function writeHeartbeat(dataDir, sessionId, now = new Date()) {
    const path = heartbeatPath(dataDir, sessionId);
    mkdirSync(join(dataDir, "monitors"), { recursive: true });
    writeFileSync(path, String(STATE_VERSION));
    utimesSync(path, now, now);
}
/** Whether a monitor that reads this state format polled for the session within the last minute. */
export function monitorAlive(dataDir, sessionId, now = new Date()) {
    try {
        const path = heartbeatPath(dataDir, sessionId);
        return readFileSync(path, "utf8") === String(STATE_VERSION) && now.getTime() - statSync(path).mtimeMs < HEARTBEAT_STALE_MS;
    }
    catch {
        return false;
    }
}
/** Drops the heartbeats of sessions that ended a day ago or more. */
export function pruneHeartbeats(dataDir, now = new Date()) {
    const dir = join(dataDir, "monitors");
    if (!existsSync(dir))
        return;
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (now.getTime() - statSync(path).mtimeMs > HEARTBEAT_PRUNE_MS)
            rmSync(path, { force: true });
    }
}
