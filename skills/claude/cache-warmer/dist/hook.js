import { userReturnedAt } from "./claude.js";
import { readKeepWarmRuns, settleCodexRun, sleptRecently } from "./codex-runs.js";
import { runSummary } from "./keeper.js";
import { settleReturn } from "./monitor.js";
import { finishRun, readState, sameRun, stopState, writeState } from "./state.js";
/**
 * At the end of each turn: once the user has typed a prompt since the run started, settles the run if it is still
 * open and returns its summary, once per run. Refresh turns and notifications carry no typed prompt, so they pass.
 */
export function onStop(dataDir, sessionId, transcriptPath) {
    const state = readState(dataDir, sessionId);
    if (!state || state.summaryShown)
        return undefined;
    if (state.driver === "cron") {
        // The skill's UserPromptSubmit hook settles a cron run when the user is back: fires leave records this check can't tell apart.
        if (state.outcome === null)
            return undefined;
        writeState(dataDir, { ...state, summaryShown: true });
        return runSummary(state);
    }
    const returnedAt = userReturnedAt(transcriptPath, new Date(state.startedAt));
    if (!returnedAt)
        return undefined;
    if (state.outcome === null)
        settleReturn(dataDir, state, transcriptPath, returnedAt);
    // Decided on the stored state: the monitor or a command may have settled or shown this run meanwhile.
    const latest = sameRun(dataDir, state);
    if (!latest || latest.outcome === null || latest.summaryShown)
        return undefined;
    writeState(dataDir, { ...latest, summaryShown: true });
    return runSummary(latest);
}
/**
 * /clear and /resume leave the session while its monitor keeps running, bound to the old ID: its refreshes would land
 * in the new conversation. The run ends here and saved nothing, as no request will read the context it kept warm.
 */
export function onSessionEnd(dataDir, sessionId, now = new Date()) {
    const state = readState(dataDir, sessionId);
    if (!state || state.outcome !== null)
        return;
    // The skill's hook runs on every way out: its scheduled tasks and hooks go with the session.
    const reason = state.driver === "cron" ? "会话结束或切换了，保温自动停止" : "切换了会话，保温自动停止";
    finishRun(dataDir, stopState(state, reason), "failed", now);
}
/**
 * The CLI arguments that answer a typed command without a model turn. A start with a duration is left to its skill:
 * that turn is what refreshes the cache at the start of the run.
 */
export function expansionArgs(commandName, commandArgs, sessionId, dataDir) {
    const session = ["--session", sessionId, "--data", dataDir];
    if (commandName === "cache-warmer:dashboard")
        return ["dashboard", ...session];
    if (commandName === "cache-warmer:stop")
        return ["stop", ...session];
    if (commandName === "cache-warmer:start" && commandArgs.trim() === "")
        return ["start", "--provider", "claude", ...session];
    return undefined;
}
/**
 * At the end of each Codex turn: the summary of the run the user came back from in this very turn. Only that one turn
 * matches, so the summary shows once with nothing stored. It reads no request of the turn itself, which the rollout
 * may not hold yet: the Stop hook runs before Codex flushes it.
 */
export function onCodexStop(rolloutPath, turnId, table) {
    if (!sleptRecently(rolloutPath))
        return undefined;
    const run = readKeepWarmRuns(rolloutPath, table).find((r) => r.returnTurn === turnId);
    return run && runSummary(settleCodexRun(run, table));
}
