import { formatMinutes } from "./duration.js";
import type { KeepPlan } from "./economics.js";

/** 12345 → "1.2 万", 123456789 → "1.2 亿". */
export function formatWan(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${trim((value / 1e8).toFixed(1))} 亿`;
  if (abs >= 1e4) return `${trim((value / 1e4).toFixed(1))} 万`;
  return `${Math.round(value)}`;
}

/** 558163 → "558k". */
export function formatK(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

/** 500 → "0.05×", 20000 → "2×". */
export function formatMultiplier(bp: number): string {
  return `${trim((bp / 10000).toFixed(3))}×`;
}

export function formatUsd(tokens: number, inputUsdPerMTok: number | undefined): string {
  return inputUsdPerMTok === undefined ? "" : ` ≈ ${formatDollars((tokens * inputUsdPerMTok) / 1e6)}`;
}

export function formatDollars(usd: number): string {
  const abs = Math.abs(usd);
  return `${usd < 0 ? "-" : ""}$${abs > 0 && abs < 0.01 ? abs.toFixed(4) : abs.toFixed(2)}`;
}

export function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "10-01 00:49". */
export function formatDate(date: Date): string {
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${formatClock(date)}`;
}

function trim(fixed: string): string {
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

export interface AnalysisView {
  modelLabel: string;
  modelId: string;
  ttlLabel: string;
  contextTokens: number;
  lastRequestStart: Date;
  expiresAt: Date;
  now: Date;
  readBp: number;
  coldBp: number;
  inputUsdPerMTok: number | undefined;
  plan: KeepPlan;
  /** The run in progress, or how to start one. */
  footer: string;
  notes: string[];
}

export function renderAnalysis(v: AnalysisView): string {
  const lines: string[] = [];
  const ctx = formatK(v.contextTokens);
  lines.push(`Cache Warmer · ${v.modelLabel}（${v.modelId}）· TTL ${v.ttlLabel} · 上下文 ${ctx}`);
  const remaining = (v.expiresAt.getTime() - v.now.getTime()) / 60000;
  const status =
    remaining > 0
      ? `还剩 ${formatMinutes(remaining)}`
      : `已过期 ${formatMinutes(-remaining)}`;
  lines.push(`最近一次请求 ${formatClock(v.lastRequestStart)} · cache ${formatClock(v.expiresAt)} 到期（${status}）`);
  lines.push("");
  lines.push(
    `每次刷新  ${formatMultiplier(v.readBp)} × ${ctx} + 回合开销约 ${formatWan(v.plan.overheadCost)} = ${formatWan(v.plan.refreshCost)} token 当量${formatUsd(v.plan.refreshCost, v.inputUsdPerMTok)}`,
  );
  lines.push(
    `冷启动    ${formatMultiplier(v.coldBp)} × ${ctx} = ${formatWan(v.plan.coldCost)} token 当量${formatUsd(v.plan.coldCost, v.inputUsdPerMTok)}`,
  );
  lines.push(
    `持平点    最多刷新 ${v.plan.breakEvenRefreshes} 次，每 ${formatMinutes(v.plan.refreshIntervalMinutes)}一次：从现在起离开与宽限合计 ${formatMinutes(Math.floor(v.plan.breakEvenMinutes))}以内都划算`,
  );
  lines.push("", v.footer);

  if (v.notes.length > 0) {
    lines.push("");
    for (const note of v.notes) lines.push(`注：${note}`);
  }
  return lines.join("\n");
}
