import assert from "node:assert/strict";
import { test } from "node:test";
import { analysis } from "../src/analysis.js";
import { formatMinutes, parseDurationMinutes } from "../src/duration.js";
import { formatDollars, formatK, formatMultiplier, formatWan } from "../src/format.js";
import { coldResumeBp, lookupModel, normalizeModelId } from "../src/pricing.js";
import type { SessionSnapshot } from "../src/session.js";

test("parseDurationMinutes accepts h/m/d combinations", () => {
  assert.equal(parseDurationMinutes("2h"), 120);
  assert.equal(parseDurationMinutes("90m"), 90);
  assert.equal(parseDurationMinutes("1h30m"), 90);
  assert.equal(parseDurationMinutes("1.5h"), 90);
  assert.equal(parseDurationMinutes(" 1d "), 1440);
  assert.equal(parseDurationMinutes("2H"), 120);
});

test("parseDurationMinutes rejects malformed input", () => {
  for (const bad of ["", "2", "h", "2x", "2h junk", "0m", "-1h"]) {
    assert.throws(() => parseDurationMinutes(bad), Error, bad);
  }
});

test("formatMinutes", () => {
  assert.equal(formatMinutes(45), "45 分钟");
  assert.equal(formatMinutes(120), "2 小时");
  assert.equal(formatMinutes(2205), "36 小时 45 分");
  assert.equal(formatMinutes(4.25), "4 分 15 秒");
  assert.equal(formatMinutes(0.75), "45 秒");
  assert.equal(formatMinutes(51.75), "52 分钟");
});

test("number formatting", () => {
  assert.equal(formatWan(9_999), "9999");
  assert.equal(formatWan(75_000), "7.5 万");
  assert.equal(formatWan(1_000_000), "100 万");
  assert.equal(formatWan(250_000_000), "2.5 亿");
  assert.equal(formatK(558_163), "558k");
  assert.equal(formatMultiplier(500), "0.05×");
  assert.equal(formatMultiplier(250), "0.025×");
  assert.equal(formatMultiplier(20000), "2×");
  assert.equal(formatMultiplier(12500), "1.25×");
  assert.equal(formatDollars(0), "$0.00");
  assert.equal(formatDollars(0.0034), "$0.0034");
  assert.equal(formatDollars(3.7997), "$3.80");
  assert.equal(formatDollars(-0.1), "-$0.10");
});

test("lookupModel matches exact ids and strips dated snapshot suffixes", () => {
  assert.equal(normalizeModelId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  const opus = lookupModel("claude-opus-5-5");
  assert.equal(opus.estimated, false);
  assert.equal(opus.readBp, 500);
  assert.equal(opus.inputUsdPerMTok, 4);
  assert.equal(lookupModel("claude-fable-5-1").readBp, 250);
  const sonnet = lookupModel("claude-sonnet-5-5");
  assert.equal(sonnet.estimated, false);
  assert.equal(sonnet.readBp, 500);
  const haiku = lookupModel("claude-haiku-5-5");
  assert.equal(haiku.estimated, false);
  assert.equal(haiku.readBp, 1000);
  assert.equal(haiku.inputUsdPerMTok, undefined);
  assert.equal(lookupModel("gpt-6.1-sol").readBp, 500);
  const terra = lookupModel("gpt-6.1-terra");
  assert.equal(terra.estimated, false);
  assert.equal(terra.readBp, 500);
  assert.equal(terra.ttlMinutes, 30);
});

test("unknown models fall back to family defaults without a price", () => {
  const claude = lookupModel("claude-opus-9");
  assert.equal(claude.estimated, true);
  assert.equal(claude.readBp, 1000);
  assert.equal(claude.inputUsdPerMTok, undefined);
  assert.equal(lookupModel("gpt-5.3-codex").writeBp, undefined);
  assert.equal(lookupModel("gpt-7-nova").writeBp, 12500);
});

test("coldResumeBp follows provider, TTL tier and billing", () => {
  const opus = lookupModel("claude-opus-5");
  assert.equal(coldResumeBp(opus, "1h", "api"), 20000);
  assert.equal(coldResumeBp(opus, "5m", "api"), 12500);
  const astra = lookupModel("gpt-6-astra");
  assert.equal(coldResumeBp(astra, "5m", "api"), 12500);
  assert.equal(coldResumeBp(astra, "5m", "codex-credits"), 10000);
  assert.equal(coldResumeBp(lookupModel("gpt-5.5"), "5m", "api"), 10000);
});

test("start without a duration shows the break-even window in whole minutes, rounded down, and how to start", () => {
  const s: SessionSnapshot = {
    provider: "claude",
    id: "x",
    modelId: "claude-opus-5-5",
    price: lookupModel("claude-opus-5-5"),
    ttlLabel: "5m",
    ttlMinutes: 5,
    leadMinutes: 0.75,
    contextTokens: 500_000,
    lastRequestStart: new Date(),
    coldBp: 12500,
    overheadScaled: 400 * 12500 + 50 * 50000,
    notes: [],
  };
  // 23 refreshes every 4m15s plus the 5-minute TTL cover 102.75 minutes; 103 would already need a 24th.
  const text = analysis(s, undefined);
  assert.match(text, /离开与宽限合计 1 小时 42 分以内都划算/);
  assert.match(text, /要保温就执行 \/cache-warmer:start <离开时长>/);
});
