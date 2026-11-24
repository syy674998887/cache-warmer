/**
 * Keep-warm economics for one idle period.
 * Displayed costs are base-input-token equivalents; internally everything is
 * "scaled" (tokens x basis points) so the break-even count stays exact integer math.
 */
export interface EconomicsParams {
  contextTokens: number;
  /** Cache read multiplier, basis points of the base input price. */
  readBp: number;
  /** Multiplier paid on a cold resume, basis points. */
  coldBp: number;
  ttlMinutes: number;
  /** How long before expiry each refresh fires. */
  leadMinutes: number;
  /** Extra cost of each refresh turn beyond reading the context (tail write + output), scaled units. */
  overheadScaled: number;
}

export interface KeepPlan {
  refreshIntervalMinutes: number;
  /** Reading the whole context once: paid by every refresh and again on return. */
  readCost: number;
  overheadCost: number;
  refreshCost: number;
  coldCost: number;
  /** Most refreshes for which keeping warm still costs no more than a cold resume. */
  breakEvenRefreshes: number;
  /** Longest idle time, measured from the last request, that stays within breakEvenRefreshes. */
  breakEvenMinutes: number;
}

export interface AwayVerdict {
  refreshes: number;
  /** Refreshes plus the one cache read paid on return. */
  keepCost: number;
  coldCost: number;
  savingRatio: number;
  keep: boolean;
}

const SCALE = 10000;

export function refreshIntervalMinutes(ttlMinutes: number, leadMinutes: number): number {
  const interval = ttlMinutes - leadMinutes;
  if (interval <= 0) throw new Error(`提前量（${leadMinutes} 分钟）必须小于 TTL（${ttlMinutes} 分钟）`);
  return interval;
}

/**
 * Refreshes needed so the cache is still warm `idleMinutes` after the last request: the fewest n with
 * n × interval + TTL ≥ idle, which is also when the monitor stops refreshing.
 */
export function refreshesNeeded(idleMinutes: number, ttlMinutes: number, intervalMinutes: number): number {
  return idleMinutes <= ttlMinutes ? 0 : Math.ceil((idleMinutes - ttlMinutes) / intervalMinutes);
}

export function keepPlan(p: EconomicsParams): KeepPlan {
  const interval = refreshIntervalMinutes(p.ttlMinutes, p.leadMinutes);
  const readScaled = p.contextTokens * p.readBp;
  const refreshScaled = readScaled + p.overheadScaled;
  const coldScaled = p.contextTokens * p.coldBp;
  const breakEvenRefreshes = Math.floor((coldScaled - readScaled) / refreshScaled);
  return {
    refreshIntervalMinutes: interval,
    readCost: readScaled / SCALE,
    overheadCost: p.overheadScaled / SCALE,
    refreshCost: refreshScaled / SCALE,
    coldCost: coldScaled / SCALE,
    breakEvenRefreshes,
    breakEvenMinutes: breakEvenRefreshes * interval + p.ttlMinutes,
  };
}

export function awayVerdict(p: EconomicsParams, idleMinutes: number): AwayVerdict {
  const plan = keepPlan(p);
  const refreshes = refreshesNeeded(idleMinutes, p.ttlMinutes, plan.refreshIntervalMinutes);
  const keepCost = refreshes * plan.refreshCost + plan.readCost;
  return {
    refreshes,
    keepCost,
    coldCost: plan.coldCost,
    savingRatio: plan.coldCost > 0 ? (plan.coldCost - keepCost) / plan.coldCost : 0,
    keep: refreshes <= plan.breakEvenRefreshes,
  };
}
