import { findTranscript, readClaudeSession, requestStartsSince, userReturnedAt } from "./claude.js";
import { effectiveExpiry, finishRun, readState, returnOutcome, sameRun, stopState, writeState, } from "./state.js";
/**
 * What each refresh puts into the conversation. It asks for a pause: woken by a refresh, Claude may otherwise
 * resume work the user interrupted before leaving.
 */
export const BEAT_TEXT = "暂停并等待";
const REPLY_TIMEOUT_MS = 5 * 60_000;
/** A refresh counts only if its reply read at least this share of the context from cache. */
export const MIN_HIT_RATIO = 0.9;
/** One poll of the keeper for one session: verify a pending refresh, stop, fire the next refresh, or settle the run. */
export function tick(ctx) {
    const state = readState(ctx.dataDir, ctx.sessionId);
    // A run the standalone skill keeps warm with scheduled tasks is never this monitor's to drive.
    if (!state || state.outcome !== null || state.driver === "cron") {
        ctx.setAwake(false);
        return;
    }
    const transcriptPath = findTranscript(ctx.sessionId);
    if (!transcriptPath)
        return;
    const now = ctx.now.getTime();
    const returnedAt = userReturnedAt(transcriptPath, new Date(state.startedAt));
    if (returnedAt) {
        ctx.setAwake(false);
        settleReturn(ctx.dataDir, state, transcriptPath, returnedAt);
        return;
    }
    // A start, stop or Stop hook may have replaced or settled this run since it was read; then nothing is written.
    const save = (next) => {
        if (sameRun(ctx.dataDir, state)?.outcome !== null)
            return false;
        writeState(ctx.dataDir, next);
        return true;
    };
    if (state.status === "stopped") {
        // Refreshing is over and the user is not back. Requests made before the cache expired still extend it.
        ctx.setAwake(false);
        const expiry = effectiveExpiry(state, requestStartsSince(transcriptPath, new Date(state.startedAt)));
        const watched = { ...state, warmUntil: new Date(expiry).toISOString() };
        if (now >= expiry)
            finishRun(ctx.dataDir, watched, "cold", new Date(expiry));
        else if (watched.warmUntil !== state.warmUntil)
            save(watched);
        return;
    }
    // Stopping is always silent: announcing it would start another turn, which on an expired cache costs a rebuild.
    const end = (from, reason, outcome) => {
        finishRun(ctx.dataDir, stopState(from, reason), outcome, ctx.now);
        ctx.setAwake(false);
    };
    const rest = (reason, warmUntil) => {
        save({ ...stopState(state, reason), warmUntil: new Date(warmUntil).toISOString() });
        ctx.setAwake(false);
    };
    const session = readClaudeSession(transcriptPath);
    if (state.awaitingSince) {
        const since = new Date(state.awaitingSince).getTime();
        if (session.lastRequestStart.getTime() >= since) {
            // Charged before the check: a refresh that missed rewrote the whole context, the dearest request of the run.
            const charged = { ...state, spentScaled: state.spentScaled + costScaled(session.lastUsage, state) };
            const before = state.contextBeforeBeat ?? state.contextTokens;
            const ratio = before > 0 ? session.lastUsage.cacheRead / before : 1;
            if (ratio < MIN_HIT_RATIO) {
                return end(charged, `第 ${state.beats + 1} 次刷新没有命中 cache（只读到 ${Math.round(ratio * 100)}%），保温停止`, "failed");
            }
            save({ ...charged, beats: state.beats + 1, awaitingSince: null, contextBeforeBeat: null });
            return;
        }
        if (now - since > REPLY_TIMEOUT_MS)
            return end(state, "刷新通知 5 分钟内没有得到回复，保温停止", "failed");
        return;
    }
    // The start command's own turn read the cache, so the clock never starts earlier than startedAt.
    const lastStart = Math.max(session.lastRequestStart.getTime(), new Date(state.startedAt).getTime());
    const warmUntil = lastStart + state.ttlMinutes * 60_000;
    if (warmUntil >= new Date(state.deadline).getTime())
        return rest("cache 已能保持到截止时间，保温完成", warmUntil);
    if (now >= warmUntil)
        return end(state, "cache 已经过期（电脑可能休眠过），保温停止", "failed");
    ctx.setAwake(state.awake);
    if (now < warmUntil - state.leadMinutes * 60_000)
        return;
    if (state.beats >= state.maxBeats)
        return rest("已达到持平点，保温停止", warmUntil);
    if (save({ ...state, awaitingSince: ctx.now.toISOString(), contextBeforeBeat: session.contextTokens }))
        ctx.emit(BEAT_TEXT);
}
/**
 * Settles a run once the user is present at `at`, for the monitor, the Stop hook and the commands alike. Judged by
 * time, as the Stop hook runs before the reply's usage reaches the transcript. A refresh whose reply arrived but was
 * not checked yet goes uncharged; had it missed the cache, that leaves out a whole rewrite.
 */
export function settleReturn(dataDir, state, transcriptPath, at, reason = "你回来了，保温自动停止") {
    const ended = state.status === "active" ? stopState(state, reason) : state;
    return finishRun(dataDir, ended, returnOutcome(state, at, requestStartsSince(transcriptPath, new Date(state.startedAt))), at);
}
/** What one request cost: cache reads, cache writes at the session's TTL tier, uncached input and output. */
export function costScaled(usage, state) {
    return usage.cacheRead * state.readBp + usage.cacheWrite * state.coldBp + usage.input * 10000 + usage.output * state.outputBp;
}
