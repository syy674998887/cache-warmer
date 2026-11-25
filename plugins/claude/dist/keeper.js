import { spawn } from "node:child_process";
import { START_COMMAND, economicsParams } from "./analysis.js";
import { findTranscript } from "./claude.js";
import { DEFAULT_GRACE, formatMinutes, parseDurationMinutes } from "./duration.js";
import { awayVerdict, keepPlan } from "./economics.js";
import { formatClock, formatUsd, formatWan } from "./format.js";
import { chargePending, DELETE_STEP, nextFireAt, scheduleStep, STOP_SKILL } from "./cron.js";
import { settleReturn } from "./monitor.js";
import { codexSleepMs } from "./session.js";
import { monitorAlive, readState, sameRun, STATE_VERSION, writeState } from "./state.js";
export function startKeeper(s, o) {
    const now = o.now ?? new Date();
    const params = economicsParams(s);
    const plan = keepPlan(params);
    const declaredMinutes = parseDurationMinutes(o.awayText);
    const graceMinutes = parseDurationMinutes(o.graceText);
    const verdict = awayVerdict(params, declaredMinutes + graceMinutes);
    const away = `离开 ${formatMinutes(declaredMinutes)}（另加 ${formatMinutes(graceMinutes)}宽限）`;
    if (verdict.refreshes === 0) {
        return `Cache Warmer 没有启动：${away}仍在当前 cache 的 TTL（${s.ttlLabel}）以内，不需要刷新。`;
    }
    if (!verdict.keep && !o.force) {
        const pct = Math.round(-verdict.savingRatio * 100);
        const options = `${o.graceText === DEFAULT_GRACE ? "" : ` --grace ${o.graceText}`}${o.awake ? "" : " --no-awake"}`;
        return [
            `Cache Warmer 没有启动：${away}需要刷新 ${verdict.refreshes} 次，超过持平点（${plan.breakEvenRefreshes} 次），`,
            `保温会比冷启动多花约 ${pct}%。如果仍要保温，执行 ${s.startCommand ?? START_COMMAND[s.provider]} ${o.awayText}${options} --force。`,
        ].join("\n");
    }
    const deadline = new Date(now.getTime() + (declaredMinutes + graceMinutes) * 60000);
    const awake = o.awake && process.platform === "darwin";
    const usd = formatUsd(plan.refreshCost, s.price.inputUsdPerMTok);
    const lines = [
        "Cache Warmer 已开始保温",
        `${away}，截止 ${formatClock(deadline)}；预计刷新 ${verdict.refreshes} 次，每 ${formatMinutes(plan.refreshIntervalMinutes)}一次，每次约 ${formatWan(plan.refreshCost)} token 当量${usd ? `${usd}（按 API 价折算）` : ""}`,
        verdict.keep
            ? `保温 ${formatWan(verdict.keepCost)} 对冷启动 ${formatWan(verdict.coldCost)}，预计省约 ${Math.round(verdict.savingRatio * 100)}%`
            : `已按 --force 启动：保温 ${formatWan(verdict.keepCost)}，比冷启动 ${formatWan(verdict.coldCost)} 更贵`,
    ];
    if (s.provider === "codex") {
        // Codex keeps warm inside this turn: the model sleeps through the plan, and each wake-up re-reads the cache.
        // The same length the run records are recognized by.
        const sleepMs = codexSleepMs(s.price);
        const awakeUntil = new Date(now.getTime() + verdict.refreshes * sleepMs + 120_000);
        if (awake)
            keepAwakeUntil(awakeUntil, now);
        lines.push("保温期间 Codex 会一直显示正在工作；你回来发任何消息或按 Esc，保温都会立即结束。");
        if (awake)
            lines.push(`${formatClock(awakeUntil)} 之前会阻止系统空闲休眠；合上盖子仍会休眠，保温也会中断。`);
        lines.push(`保温计划：用 sleep 工具睡 ${verdict.refreshes} 次，每次 duration_ms=${sleepMs}`);
        return lines.join("\n");
    }
    if (!o.dataDir)
        throw new Error("缺少 --data");
    const cron = o.driver === "cron";
    // Writing a run that no monitor will execute would leave the user away with a cache that silently expires.
    if (!cron && !monitorAlive(o.dataDir, s.id, now))
        return monitorDown(s.id);
    // Starting again means the user is here, which settles the session's previous run.
    const previous = readState(o.dataDir, s.id);
    const transcriptPath = findTranscript(s.id);
    if (previous && previous.outcome === null && transcriptPath) {
        const pending = previous.driver === "cron" ? chargePending(previous, transcriptPath) : previous;
        settleReturn(o.dataDir, pending, transcriptPath, now, "重新执行了 start");
    }
    // The start turn's own request reads the cache, so the first fire counts from now.
    const warmUntil = now.getTime() + s.ttlMinutes * 60_000;
    const firstFire = !cron
        ? undefined
        : o.firstFireInMinutes !== undefined
            ? nextFireAt(warmUntil, s.ttlMinutes - o.firstFireInMinutes, now.getTime())
            : nextFireAt(warmUntil, s.leadMinutes, now.getTime());
    if (cron && !firstFire)
        return "Cache Warmer 没有启动：cache 的有效期太短，排不进一次定时刷新。";
    const state = {
        version: STATE_VERSION,
        sessionId: s.id,
        // The CLI runs in the session's project directory.
        cwd: process.cwd(),
        readBp: s.price.readBp,
        coldBp: s.coldBp,
        outputBp: s.price.outputBp ?? 50000,
        inputUsdPerMTok: s.price.inputUsdPerMTok ?? null,
        status: "active",
        startedAt: now.toISOString(),
        deadline: deadline.toISOString(),
        ttlMinutes: s.ttlMinutes,
        leadMinutes: s.leadMinutes,
        plannedBeats: verdict.refreshes,
        maxBeats: o.force ? verdict.refreshes : plan.breakEvenRefreshes,
        beats: 0,
        awaitingSince: null,
        contextTokens: s.contextTokens,
        contextBeforeBeat: null,
        spentScaled: 0,
        awake,
        stopReason: null,
        warmUntil: null,
        outcome: null,
        endedAt: null,
        savedScaled: null,
        summaryShown: false,
        ...(cron ? { driver: "cron", via: o.via ?? "hook", nextFireAt: firstFire.toISOString() } : {}),
    };
    writeState(o.dataDir, state);
    if (cron) {
        if (awake)
            keepAwakeUntil(deadline, now);
        lines.push(`每次刷新时，对话里会出现一条 Cache Warmer 的定时消息（含 cache-warmer-beat）和 Claude 的回复；第一次在 ${formatClock(firstFire)}。`, `你回来输入任何消息就会自动停止（斜杠命令不算）；提前取消用 ${STOP_SKILL}。`, awake ? "截止之前会阻止系统空闲休眠；合上盖子仍会休眠，保温也会中断。" : "保温期间电脑不能睡眠，否则定时任务不会触发，保温会中断。");
        // A pending task of the previous run would fire into this one.
        const cleanup = previous?.driver === "cron" && previous.status === "active" && previous.outcome === null;
        if (cleanup)
            lines.push(`下一步之前：先${DELETE_STEP}。`);
        lines.push(scheduleStep(firstFire, state.via));
        return lines.join("\n");
    }
    lines.push("每次刷新时，对话里会出现一条 cache-warmer 的「暂停并等待」通知和 Claude 的一条回复。", "你回来输入一条消息就会自动停止（斜杠命令不算）；提前取消用 /cache-warmer:stop。");
    if (awake)
        lines.push("保温期间会阻止系统空闲休眠；合上盖子仍会休眠，保温也会中断。");
    return lines.join("\n");
}
/** A timed assertion that outlives this short-lived command; the Claude monitor manages its own instead. */
function keepAwakeUntil(until, now) {
    const seconds = Math.ceil((until.getTime() - now.getTime()) / 1000);
    spawn("/usr/bin/caffeinate", ["-i", "-t", String(seconds)], { detached: true, stdio: "ignore" }).unref();
}
function monitorDown(sessionId) {
    return [
        "Cache Warmer 没有启动：本会话的 monitor 没在运行，保温不会执行。",
        `如果它被停掉了、插件更新后还是旧版本，或者用过 /clear、/resume：先 /exit，再运行 claude --resume ${sessionId}，然后重新执行 start。`,
        "如果设置了 disableAllHooks：monitor 不会启动，要先关掉这个设置，再重启会话。",
    ].join("\n");
}
export function stopKeeper(dataDir, sessionId, now = new Date()) {
    const state = readState(dataDir, sessionId);
    if (!state || state.outcome !== null)
        return "Cache Warmer：本会话没有正在进行的保温。";
    const transcriptPath = findTranscript(sessionId);
    if (!transcriptPath)
        throw new Error(`找不到会话 ${sessionId} 的 transcript`);
    const cron = state.driver === "cron";
    settleReturn(dataDir, cron ? chargePending(state, transcriptPath) : state, transcriptPath, now, `用户执行了 ${cron ? STOP_SKILL : "/cache-warmer:stop"}`);
    const latest = sameRun(dataDir, state);
    if (!latest || latest.outcome === null)
        return "Cache Warmer：本会话没有正在进行的保温。";
    writeState(dataDir, { ...latest, summaryShown: true });
    // A task scheduled for the next fire would otherwise still go off.
    if (cron && state.status === "active")
        return `${runSummary(latest)}\n下一步：${DELETE_STEP}，然后只回复「Cache Warmer：已停止」。`;
    return runSummary(latest);
}
/** One line about this session's open run, shown by start without a duration. */
export function keeperStatusLine(dataDir, sessionId) {
    const state = readState(dataDir, sessionId);
    if (!state || state.outcome !== null)
        return undefined;
    if (state.status === "active") {
        const progress = `保温进行中：已刷新 ${state.beats}/${state.plannedBeats} 次，截止 ${formatClock(new Date(state.deadline))}。`;
        if (state.driver === "cron")
            return state.nextFireAt ? `${progress}下次刷新 ${formatClock(new Date(state.nextFireAt))}。` : progress;
        return monitorAlive(dataDir, sessionId) ? progress : `${progress}\n${monitorDown(sessionId)}`;
    }
    return `保温已结束（${state.stopReason}），cache 保持到 ${formatClock(new Date(state.warmUntil))}。`;
}
/** What a settled run cost and saved. */
export function runSummary(s) {
    return `${settledText(s)}${s.misses ? `其中 ${s.misses} 次刷新没有命中 cache。` : ""}`;
}
function settledText(s) {
    const usd = (scaled) => formatUsd(scaled / 10000, s.inputUsdPerMTok ?? undefined);
    const saved = s.savedScaled ?? 0;
    const head = `Cache Warmer 保温总结：${formatClock(new Date(s.startedAt))} 开始，刷新 ${s.beats} 次，花费约 ${formatWan(s.spentScaled / 10000)} token 当量${usd(s.spentScaled)}`;
    switch (s.outcome) {
        case "warm":
            return saved > 0
                ? `${head}；你回来时 cache 还热，比冷启动省约 ${formatWan(saved / 10000)} token 当量${usd(saved)}。`
                : `${head}；你回来时 cache 还热，但这次保温没有省到。`;
        case "cold":
            // A run settled at warmUntil expired before the user was back; any other cold run met them with an expired cache.
            return s.endedAt === s.warmUntil
                ? `${head}；cache 在 ${formatClock(new Date(s.warmUntil))} 过期时你还没回来，这次没有省到。`
                : `${head}；你回来时 cache 已经过期，这次没有省到。`;
        default:
            return `${head}；${s.stopReason}，这次没有省到。`;
    }
}
