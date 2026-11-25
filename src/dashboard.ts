import { basename } from "node:path";
import { START_COMMAND } from "./analysis.js";
import { findTranscript, requestStartsSince, userReturnedAt } from "./claude.js";
import { allKeepWarmRuns, settleCodexRun } from "./codex-runs.js";
import { formatClock, formatDate, formatDollars, formatWan } from "./format.js";
import { settleReturn } from "./monitor.js";
import type { PricingTable } from "./pricing.js";
import { effectiveExpiry, finishRun, monitorAlive, openStates, readHistory, stopState, type KeeperState, type RunRecord } from "./state.js";

const RECENT_RUNS = 10;

const where = (s: Pick<RunRecord, "cwd">) => basename(s.cwd);
const mine = (s: Pick<RunRecord, "sessionId">, sessionId: string | undefined) => (s.sessionId === sessionId ? "（本会话）" : "");

/** Every settled keep-warm run: what it cost, what it saved, and the runs still open. */
export function dashboard(dataDir: string, sessionId: string | undefined, now = new Date(), startCommand: string = START_COMMAND.claude): string {
  // Settled first, so that a run nobody else will settle shows up in the totals of this very output.
  const open = openStates(dataDir).filter((s) => monitorAlive(dataDir, s.sessionId, now) || !settleOrphan(dataDir, s, now));
  const openLines = open.map((s) => {
    // The skill's runs have no monitor: scheduled tasks drive them.
    const lost = s.driver === "cron" || monitorAlive(dataDir, s.sessionId, now) ? "" : "（monitor 失联）";
    return s.status === "active"
      ? `进行中 · ${where(s)} · 已刷新 ${s.beats}/${s.plannedBeats} 次，截止 ${formatClock(new Date(s.deadline))}${lost}${mine(s, sessionId)}`
      : `等你回来 · ${where(s)} · 已刷新 ${s.beats} 次，cache 保持到 ${formatClock(new Date(s.warmUntil!))}${lost}${mine(s, sessionId)}`;
  });
  return renderRuns(readHistory(dataDir), openLines, sessionId, startCommand);
}

/** The same report for Codex, worked out from the rollouts on each call: they are the only record of its runs. */
export function codexDashboard(table: PricingTable, threadId: string | undefined, now = new Date()): string {
  const runs = allKeepWarmRuns(table)
    .map((run) => settleCodexRun(run, table, now))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const openLines = runs
    .filter((r) => r.outcome === null)
    .map((r) => `进行中 · ${where(r)} · 已刷新 ${r.beats} 次，cache 保持到 ${formatClock(new Date(r.warmUntil!))}${mine(r, threadId)}`);
  return renderRuns(runs.filter((r) => r.outcome !== null), openLines, threadId, START_COMMAND.codex);
}

function renderRuns(runs: RunRecord[], openLines: string[], sessionId: string | undefined, startCommand: string): string {
  if (runs.length === 0 && openLines.length === 0) {
    return `Cache Warmer 还没有保温记录。离开前执行 ${startCommand}，先看看保温划不划算。`;
  }
  const lines: string[] = [];
  const warm = runs.filter((r) => r.outcome === "warm").length;
  lines.push(`Cache Warmer 保温记录 · 共 ${runs.length} 次，其中 ${warm} 次你回来时 cache 还热`);
  lines.push(
    `合计花费约 ${formatWan(sum(runs, (r) => r.spentScaled) / 10000)} token 当量${dollars(runs, (r) => r.spentScaled)}，` +
      `净节省约 ${formatWan(sum(runs, (r) => r.savedScaled ?? 0) / 10000)} token 当量${dollars(runs, (r) => r.savedScaled ?? 0)}`,
  );
  lines.push(...openLines);

  if (runs.length > 0) {
    lines.push("", `最近 ${Math.min(runs.length, RECENT_RUNS)} 次`);
    for (const r of runs.slice(-RECENT_RUNS).reverse()) {
      lines.push(`${formatDate(new Date(r.startedAt))} · ${where(r)} · 刷新 ${r.beats} 次，花 ${formatWan(r.spentScaled / 10000)} · ${result(r)}${mine(r, sessionId)}`);
    }
  }
  lines.push("", "注：节省 = 回来时冷启动要花的 − 读 cache 的 − 保温花费，负数表示多花；单位是 token 当量（按各模型的基础输入价折算）。");
  lines.push("注：金额按 API 价折算；订阅用户并非实际扣费，省下的是额度和等待时间。");
  return lines.join("\n");
}

/**
 * Settles a run whose monitor is gone, such as a session closed mid-run, which nothing else would ever settle:
 * by the user's return, or once its cache has expired. Returns whether it settled.
 */
function settleOrphan(dataDir: string, state: KeeperState, now: Date): boolean {
  const transcriptPath = findTranscript(state.sessionId);
  if (!transcriptPath) return false;
  const since = new Date(state.startedAt);
  // A cron run is settled by the skill's hook when the user is back; scheduled fires leave records this check can't tell apart.
  const returnedAt = state.driver === "cron" ? undefined : userReturnedAt(transcriptPath, since);
  if (returnedAt) return settleReturn(dataDir, state, transcriptPath, returnedAt) !== undefined;
  const expiry = effectiveExpiry(state, requestStartsSince(transcriptPath, since));
  // A run done refreshing is shown and archived with the expiry that later requests may have extended.
  if (state.status === "stopped") state.warmUntil = new Date(expiry).toISOString();
  if (now.getTime() < expiry) return false;
  // Still refreshing when the monitor went away: the run broke off. Done refreshing: the cache ran out unattended.
  const ended = state.status === "active" ? stopState(state, state.driver === "cron" ? "定时刷新没有按时触发（会话可能已关闭），保温中断" : "monitor 不在了（会话可能已关闭），保温中断") : state;
  return finishRun(dataDir, ended, state.status === "active" ? "failed" : "cold", new Date(expiry)) !== undefined;
}

function result(r: RunRecord): string {
  const missed = r.misses ? `（${r.misses} 次刷新没命中）` : "";
  const saved = r.savedScaled ?? 0;
  if (r.outcome === "warm") return `${saved > 0 ? `回来时 cache 还热，省 ${formatWan(saved / 10000)}` : "回来时 cache 还热，没有省到"}${missed}`;
  return `${r.outcome === "cold" ? "cache 已过期，没有省到" : "中途停止，没有省到"}${missed}`;
}

function sum(runs: RunRecord[], pick: (r: RunRecord) => number): number {
  return runs.reduce((total, r) => total + pick(r), 0);
}

/** The amount in USD, with its sign, over the runs whose model has a price; token-equivalents of different models do not convert into one rate. */
function dollars(runs: RunRecord[], pick: (r: RunRecord) => number): string {
  const priced = runs.filter((r) => r.inputUsdPerMTok !== null);
  if (priced.length === 0) return "";
  return `（按 API 价 ${formatDollars(sum(priced, (r) => ((pick(r) / 10000) * r.inputUsdPerMTok!) / 1e6))}）`;
}
