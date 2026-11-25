import { keepPlan, type EconomicsParams } from "./economics.js";
import { renderAnalysis } from "./format.js";
import type { SessionSnapshot } from "./session.js";

/** How each CLI invokes the start skill. */
export const START_COMMAND = { claude: "/cache-warmer:start", codex: "$cache-warmer:start" } as const;

export function economicsParams(s: SessionSnapshot): EconomicsParams {
  return {
    contextTokens: s.contextTokens,
    readBp: s.price.readBp,
    coldBp: s.coldBp,
    ttlMinutes: s.ttlMinutes,
    leadMinutes: s.leadMinutes,
    overheadScaled: s.overheadScaled,
  };
}

/** What start shows without a duration: the cache now, a refresh against a cold resume, and the break-even point. */
export function analysis(s: SessionSnapshot, status: string | undefined, now = new Date()): string {
  const start = s.startCommand ?? START_COMMAND[s.provider];
  return renderAnalysis({
    modelLabel: s.price.label,
    modelId: s.modelId,
    ttlLabel: s.ttlLabel,
    contextTokens: s.contextTokens,
    lastRequestStart: s.lastRequestStart,
    expiresAt: new Date(s.lastRequestStart.getTime() + s.ttlMinutes * 60000),
    now,
    readBp: s.price.readBp,
    coldBp: s.coldBp,
    inputUsdPerMTok: s.price.inputUsdPerMTok,
    plan: keepPlan(economicsParams(s)),
    footer: status ?? `要保温就执行 ${start} <离开时长>，例如 ${start} 2h。`,
    notes: s.notes,
  });
}
