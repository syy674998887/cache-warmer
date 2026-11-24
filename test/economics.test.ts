import assert from "node:assert/strict";
import { test } from "node:test";
import { awayVerdict, keepPlan, refreshesNeeded } from "../src/economics.js";

// [scenario, readBp, coldBp, ttl, lead, N*, T* minutes]
const SCENARIOS: [string, number, number, number, number, number, number][] = [
  ["Claude 1h, 0.1x read", 1000, 20000, 60, 10, 19, 1010],
  ["Claude 1h, Opus 5.5", 500, 20000, 60, 10, 39, 2010],
  ["Claude 1h, Fable 5.1", 250, 20000, 60, 10, 79, 4010],
  ["Claude 5m, 0.1x read", 1000, 12500, 5, 0.75, 11, 51.75],
  ["Codex credits", 1000, 10000, 30, 5, 9, 255],
  ["OpenAI API GPT-5.6+", 1000, 12500, 30, 5, 11, 305],
];

for (const [name, readBp, coldBp, ttlMinutes, leadMinutes, n, t] of SCENARIOS) {
  test(`break-even: ${name}`, () => {
    const plan = keepPlan({ contextTokens: 100_000, readBp, coldBp, ttlMinutes, leadMinutes, overheadScaled: 0 });
    assert.equal(plan.breakEvenRefreshes, n);
    assert.equal(plan.breakEvenMinutes, t);
  });
}

test("refreshesNeeded is the fewest refreshes whose last one keeps the cache warm through the idle time", () => {
  assert.equal(refreshesNeeded(59, 60, 50), 0);
  assert.equal(refreshesNeeded(60, 60, 50), 0);
  assert.equal(refreshesNeeded(61, 60, 50), 1);
  assert.equal(refreshesNeeded(110, 60, 50), 1);
  assert.equal(refreshesNeeded(111, 60, 50), 2);
  assert.equal(refreshesNeeded(150, 60, 50), 2);
  assert.equal(refreshesNeeded(55, 30, 25), 1);
  assert.equal(refreshesNeeded(150, 30, 25), 5);
});

test("verdict for Opus 5.5, 500k, away 2h + 30m grace", () => {
  const v = awayVerdict({ contextTokens: 500_000, readBp: 500, coldBp: 20000, ttlMinutes: 60, leadMinutes: 10, overheadScaled: 0 }, 150);
  assert.equal(v.refreshes, 2);
  assert.equal(v.keepCost, 75_000);
  assert.equal(v.coldCost, 1_000_000);
  assert.equal(v.savingRatio, 0.925);
  assert.equal(v.keep, true);
});

test("verdict turns to LET EXPIRE past the break-even point", () => {
  const params = { contextTokens: 200_000, readBp: 1000, coldBp: 10000, ttlMinutes: 30, leadMinutes: 5, overheadScaled: 0 };
  assert.equal(awayVerdict(params, 255).keep, true);
  const late = awayVerdict(params, 256);
  assert.equal(late.refreshes, 10);
  assert.equal(late.keep, false);
  assert.ok(late.keepCost > late.coldCost);
});

test("keepPlan rejects a lead time that is not shorter than the TTL", () => {
  assert.throws(() => keepPlan({ contextTokens: 1, readBp: 1000, coldBp: 20000, ttlMinutes: 5, leadMinutes: 5, overheadScaled: 0 }));
});

test("refresh-turn overhead lowers the break-even count, most for small contexts", () => {
  // Opus 5.5, 1h TTL: 400 tail tokens at 2x plus 50 output tokens at 5x = 1,050 token-equivalents per refresh.
  const overheadScaled = 400 * 20000 + 50 * 50000;
  const small = keepPlan({ contextTokens: 50_000, readBp: 500, coldBp: 20000, ttlMinutes: 60, leadMinutes: 10, overheadScaled });
  assert.equal(small.overheadCost, 1050);
  assert.equal(small.refreshCost, 3550);
  assert.equal(small.breakEvenRefreshes, 27);
  const large = keepPlan({ contextTokens: 500_000, readBp: 500, coldBp: 20000, ttlMinutes: 60, leadMinutes: 10, overheadScaled });
  assert.equal(large.breakEvenRefreshes, 37);
});
