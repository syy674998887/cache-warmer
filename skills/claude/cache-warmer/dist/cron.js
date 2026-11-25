import { findTranscript, readClaudeSession, requestsSince } from "./claude.js";
import { formatClock } from "./format.js";
import { costScaled, MIN_HIT_RATIO, settleReturn } from "./monitor.js";
import { finishRun, readState, sameRun, stopState, writeState } from "./state.js";
/*
 * The standalone skill keeps the cache warm without a monitor. Each refresh is a one-shot CronCreate task that
 * Claude schedules itself: the task's prompt is the refresh turn, and in that turn Claude schedules the next one.
 * The CLI decides when each fire is due and checks the previous one, through one of two routes:
 *   hook  – the prompt is plain text; the skill's UserPromptSubmit hook runs `beat` and adds its answer as context.
 *   skill – the prompt is /cache-warmer-beat, whose `!` command runs `beat`.
 */
/** Every fire prompt carries this, so the hook and the CronList clean-up can tell the skill's tasks apart. */
export const BEAT_MARKER = "cache-warmer-beat";
/** The requests of one fire turn all start within this long of the fire. */
const FIRE_TURN_MS = 5 * 60_000;
/**
 * The fire's own prompt may be recorded just before the hook or `!` command runs: the turn is read from a little
 * earlier. The previous turn ended over a minute before any fire, as fires are at least a minute apart.
 */
const FIRE_SLACK_MS = 30_000;
const MINUTE = 60_000;
export const START_SKILL = "/cache-warmer start";
export const STOP_SKILL = "/cache-warmer stop";
/** The prompt each scheduled task sends. It asks for a pause: woken by a fire, Claude may otherwise resume earlier work. */
export function firePrompt(via) {
    if (via === "skill")
        return `/${BEAT_MARKER}`;
    return `暂停并等待（${BEAT_MARKER}）。如果没有看到 Cache Warmer 的下一步指示，只回复「Cache Warmer：没收到指示，保温中断」。`;
}
/** A cron expression that matches `fire` once, in local time as CronCreate reads it. */
export function cronExpression(fire) {
    return `${fire.getMinutes()} ${fire.getHours()} ${fire.getDate()} ${fire.getMonth() + 1} *`;
}
/**
 * When to fire so the cache is read `leadMinutes` before it expires at `warmUntil`. CronCreate fires on whole minutes,
 * so it rounds down; and at least a full minute after now, so the task is not already in the past when it is created.
 * Undefined when no minute fits before expiry.
 */
export function nextFireAt(warmUntil, leadMinutes, now) {
    const fire = Math.max(Math.floor((warmUntil - leadMinutes * MINUTE) / MINUTE) * MINUTE, Math.ceil(now / MINUTE) * MINUTE + MINUTE);
    return fire < warmUntil ? new Date(fire) : undefined;
}
/** The step Claude takes after the CLI's output: create the next task, then say only when it fires. */
export function scheduleStep(fire, via) {
    return [
        `下一步：调用 CronCreate，参数 cron="${cronExpression(fire)}"，recurring=false，prompt="${firePrompt(via)}"。`,
        `设好后只回复一行「Cache Warmer：保温中，下次刷新 ${formatClock(fire)}」，不要做别的事。`,
    ].join("\n");
}
/** Removes the skill's pending tasks, for the stop command, a new start, and the user coming back. */
export const DELETE_STEP = `调用 CronList，找到 prompt 里含 ${BEAT_MARKER} 的定时任务，逐个用 CronDelete 删掉`;
/**
 * The economics of the cron route. Each fire is two requests – the fire prompt, then the reply after CronCreate's
 * result – so a refresh reads the context twice and writes about twice the tail. Not measured yet: an estimate.
 * Fires land on whole minutes, so the 5-minute tier gets a wider lead.
 */
export function cronSnapshot(s) {
    return {
        ...s,
        startCommand: START_SKILL,
        leadMinutes: s.ttlMinutes <= 5 ? 1.5 : s.leadMinutes,
        overheadScaled: 2 * s.overheadScaled + s.contextTokens * s.price.readBp,
        notes: [...s.notes, "skill 版每次刷新是两次请求（定时消息一次，设好下一个定时任务后的回复一次），比插件版贵，持平点也更低。"],
    };
}
/** Charges the requests of the last fire turn, which nothing has checked yet. */
export function chargePending(state, transcriptPath) {
    if (!state.awaitingSince)
        return state;
    const since = new Date(state.awaitingSince);
    const spent = fireTurn(transcriptPath, since).reduce((sum, r) => sum + costScaled(r.usage, state), 0);
    return { ...state, spentScaled: state.spentScaled + spent, awaitingSince: null, contextBeforeBeat: null };
}
function fireTurn(transcriptPath, since) {
    const from = since.getTime() - FIRE_SLACK_MS;
    return requestsSince(transcriptPath, new Date(from)).filter((r) => r.start.getTime() < since.getTime() + FIRE_TURN_MS);
}
/** Settles a cron run once the user is present: the last fire is charged first. */
export function settleCron(dataDir, state, transcriptPath, at, reason) {
    return settleReturn(dataDir, chargePending(state, transcriptPath), transcriptPath, at, reason);
}
/**
 * One scheduled fire, run before its request is sent: checks the previous fire, counts this one, and tells Claude
 * whether to schedule the next. The answer is what Claude reads, so every branch says what to reply.
 */
export function cronBeat(dataDir, sessionId, now = new Date()) {
    const idle = "Cache Warmer：这是保温的定时消息，但本会话没有正在进行的保温。不要再设定时任务，只回复「好」。";
    const state = readState(dataDir, sessionId);
    if (!state || state.driver !== "cron" || state.outcome !== null || state.status !== "active")
        return idle;
    const transcriptPath = findTranscript(sessionId);
    if (!transcriptPath)
        return idle;
    const via = state.via ?? "hook";
    const save = (next) => {
        if (sameRun(dataDir, state)?.outcome !== null)
            return false;
        writeState(dataDir, next);
        return true;
    };
    const end = (from, reason, outcome) => {
        finishRun(dataDir, stopState(from, reason), outcome, now);
        return `Cache Warmer：${reason}。不要再设定时任务，只回复「Cache Warmer：${reason}」。`;
    };
    // The previous fire's turn: charged first, as a miss rewrote the whole context.
    let current = state;
    if (state.awaitingSince) {
        const turn = fireTurn(transcriptPath, new Date(state.awaitingSince));
        current = chargePending(state, transcriptPath);
        const first = turn[0];
        const before = state.contextBeforeBeat ?? state.contextTokens;
        const ratio = first && before > 0 ? first.usage.cacheRead / before : 1;
        if (ratio < MIN_HIT_RATIO) {
            return end(current, `第 ${state.beats} 次刷新没有命中 cache（只读到 ${Math.round(ratio * 100)}%），保温停止`, "failed");
        }
    }
    // This fire's own request has not been sent yet, so the newest one on record is the previous fire's.
    const session = readClaudeSession(transcriptPath);
    const lastStart = Math.max(session.lastRequestStart.getTime(), new Date(state.startedAt).getTime());
    if (now.getTime() >= lastStart + state.ttlMinutes * MINUTE) {
        return end(current, "cache 已经过期（电脑可能睡眠过，或定时任务没按时触发），保温停止", "failed");
    }
    const warmUntil = now.getTime() + state.ttlMinutes * MINUTE;
    const counted = {
        ...current,
        beats: current.beats + 1,
        awaitingSince: now.toISOString(),
        contextBeforeBeat: session.contextTokens,
        nextFireAt: null,
    };
    // Refreshing ends here; awaitingSince stays, so this fire is charged when the run is settled.
    const rest = (reason) => {
        save({ ...counted, status: "stopped", stopReason: reason, warmUntil: new Date(warmUntil).toISOString() });
        return `Cache Warmer：${reason}，cache 保持到 ${formatClock(new Date(warmUntil))}。不要再设定时任务，只回复「Cache Warmer：${reason}」。`;
    };
    if (warmUntil >= new Date(state.deadline).getTime())
        return rest("cache 已能保持到截止时间，保温完成");
    if (counted.beats >= state.maxBeats)
        return rest("已达到持平点，保温停止");
    const fire = nextFireAt(warmUntil, state.leadMinutes, now.getTime());
    if (!fire)
        return rest("下一次刷新排不进 cache 的有效期，保温停止");
    if (!save({ ...counted, nextFireAt: fire.toISOString() }))
        return idle;
    return `Cache Warmer：第 ${counted.beats} 次刷新。\n${scheduleStep(fire, via)}`;
}
/**
 * The skill's UserPromptSubmit hook. Reads only whether the prompt is a slash command or carries the fire marker; the
 * text itself is never stored. Returns the context to add, if any.
 *   - a fire on the hook route: the beat;
 *   - a slash command (including the skill route's /cache-warmer-beat): nothing, the command handles itself;
 *   - any other prompt from the user: they are back, so the run is settled and the pending task removed.
 */
export function onSkillPrompt(dataDir, sessionId, prompt, source, now = new Date()) {
    if (prompt.trimStart().startsWith("/"))
        return undefined;
    if (prompt.includes(BEAT_MARKER) && source !== "user")
        return cronBeat(dataDir, sessionId, now);
    // Payloads may omit the source; when present, only the user's own prompts end a run.
    if (source !== undefined && source !== "user")
        return undefined;
    const state = readState(dataDir, sessionId);
    if (!state || state.driver !== "cron" || state.outcome !== null)
        return undefined;
    const transcriptPath = findTranscript(sessionId);
    if (!transcriptPath)
        return undefined;
    settleCron(dataDir, state, transcriptPath, now);
    if (state.status !== "active")
        return undefined;
    return `Cache Warmer：用户回来了，保温已结束。先${DELETE_STEP}（不用告诉用户），然后正常处理用户的消息。`;
}
