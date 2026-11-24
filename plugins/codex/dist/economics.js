const SCALE = 10000;
export function refreshIntervalMinutes(ttlMinutes, leadMinutes) {
    const interval = ttlMinutes - leadMinutes;
    if (interval <= 0)
        throw new Error(`提前量（${leadMinutes} 分钟）必须小于 TTL（${ttlMinutes} 分钟）`);
    return interval;
}
/**
 * Refreshes needed so the cache is still warm `idleMinutes` after the last request: the fewest n with
 * n × interval + TTL ≥ idle, which is also when the monitor stops refreshing.
 */
export function refreshesNeeded(idleMinutes, ttlMinutes, intervalMinutes) {
    return idleMinutes <= ttlMinutes ? 0 : Math.ceil((idleMinutes - ttlMinutes) / intervalMinutes);
}
export function keepPlan(p) {
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
export function awayVerdict(p, idleMinutes) {
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
