import { findTranscript, readClaudeSession } from "./claude.js";
import { findRollout, readCodexThread } from "./codex.js";
import { coldResumeBp, lookupModel, type Billing, type ModelPrice, type Pricing } from "./pricing.js";

export type ProviderName = "claude" | "codex";

/** What the economics need to know about one session, whichever CLI it came from. */
export interface SessionSnapshot {
  provider: ProviderName;
  id: string;
  modelId: string;
  price: ModelPrice;
  ttlLabel: string;
  ttlMinutes: number;
  /** How long before expiry a refresh fires. */
  leadMinutes: number;
  contextTokens: number;
  lastRequestStart: Date;
  coldBp: number;
  /** Extra cost of one refresh turn beyond reading the context, in tokens x basis points. */
  overheadScaled: number;
  notes: string[];
}

// Measured on 2026-10-01. Claude Code (Opus 5.5, pause-and-wait beat): after the first, each keep-alive turn wrote
// 297-546 new tokens; output was 153-253 tokens on the first turn and 6-74 after. Measured on 2026-09-30. Codex
// (gpt-6-astra, sleep-tool loop): each wake-up left 180-270 tokens uncached, because cached counts advance in
// 128-token steps, and produced about 20 output tokens.
const REFRESH_OVERHEAD: Record<ProviderName, { tailTokens: number; outputTokens: number }> = {
  claude: { tailTokens: 400, outputTokens: 50 },
  codex: { tailTokens: 250, outputTokens: 20 },
};

/** The new tail is billed like uncached content (the cold-resume rate); output at the model's output price. */
function refreshOverheadScaled(provider: ProviderName, price: ModelPrice, coldBp: number): number {
  const { tailTokens, outputTokens } = REFRESH_OVERHEAD[provider];
  return tailTokens * coldBp + outputTokens * (price.outputBp ?? 50000);
}

/** For models the price table gives no documented minimum; OpenAI says GPT-5.5 entries typically last about 30 minutes. */
const CODEX_FALLBACK_TTL_MINUTES = 30;
const CODEX_LEAD_MINUTES = 5;

export function codexTtlMinutes(price: ModelPrice): number {
  return price.ttlMinutes ?? CODEX_FALLBACK_TTL_MINUTES;
}

/** How long the model sleeps between refreshes in the Codex keep-warm plan. */
export function codexSleepMs(price: ModelPrice): number {
  return (codexTtlMinutes(price) - CODEX_LEAD_MINUTES) * 60_000;
}

export function claudeSnapshot(sessionId: string, pricing: Pricing): SessionSnapshot {
  const path = findTranscript(sessionId);
  if (!path) throw new Error(`找不到会话 ${sessionId} 的 transcript`);
  const state = readClaudeSession(path);
  const price = lookupModel(state.model, pricing.table);
  const notes: string[] = [];
  if (!state.ttl) notes.push("没有找到 cache 写入记录，按 5 分钟 TTL 估算。");
  const tier = state.ttl ?? "5m";
  const coldBp = coldResumeBp(price, tier, "api");
  if (price.estimated) notes.push(`价格表里没有 ${state.model}，按同家族默认倍率估算，不显示金额。`);
  notes.push("金额按 API 价折算；订阅用户并非实际扣费，省下的是额度和等待时间。");
  notes.push(pricingNote(pricing));
  return {
    provider: "claude",
    id: sessionId,
    modelId: state.model,
    price,
    ttlLabel: tier,
    ttlMinutes: tier === "1h" ? 60 : 5,
    // On the 1h tier Claude Code may compact a long conversation left idle for about 54 minutes; a refresh has to come first.
    leadMinutes: tier === "1h" ? 10 : 0.75,
    contextTokens: state.contextTokens,
    lastRequestStart: state.lastRequestStart,
    coldBp,
    overheadScaled: refreshOverheadScaled("claude", price, coldBp),
    notes,
  };
}

export function codexSnapshot(threadId: string, pricing: Pricing): SessionSnapshot {
  const path = findRollout(threadId);
  if (!path) throw new Error(`找不到 thread ${threadId} 的 rollout`);
  const state = readCodexThread(path);
  const price = lookupModel(state.model, pricing.table);
  const billing: Billing = state.planType ? "codex-credits" : "api";
  const coldBp = coldResumeBp(price, "5m", billing);
  const ttlMinutes = codexTtlMinutes(price);
  const notes: string[] = [];
  notes.push(
    price.ttlMinutes
      ? `按 OpenAI API 文档，${state.model} 的 cache 在最近一次使用后至少保留 ${ttlMinutes} 分钟（ChatGPT 登录时按同一规则计算）。`
      : `OpenAI 没有给出 ${state.model} 的最短保留时间，按 ${ttlMinutes} 分钟估算。`,
  );
  if (state.compactedSinceLastRequest) notes.push("最近一次请求之后发生过压缩，之前的 cache 前缀已经失效。");
  if (price.estimated) notes.push(`价格表里没有 ${state.model}，按同家族默认倍率估算，不显示金额。`);
  notes.push(
    billing === "codex-credits"
      ? "按 Codex credits 规则计算（不单独收写入费）；金额按 API 价折算，并非实际扣费。"
      : "按 OpenAI API 价计算。",
  );
  notes.push(pricingNote(pricing));
  return {
    provider: "codex",
    id: threadId,
    modelId: state.model,
    price,
    ttlLabel: `${ttlMinutes} 分钟${price.ttlMinutes ? "" : "（估算）"}`,
    ttlMinutes,
    leadMinutes: CODEX_LEAD_MINUTES,
    contextTokens: state.contextTokens,
    lastRequestStart: state.lastRequestStart,
    coldBp,
    overheadScaled: refreshOverheadScaled("codex", price, coldBp),
    notes,
  };
}

function pricingNote(pricing: Pricing): string {
  return `价格表日期 ${pricing.table.asOf}（${pricing.source === "remote" ? "远程更新" : "插件内置"}）。`;
}
