import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BUNDLED_PRICING, lookupModel, type PricingTable } from "../src/pricing.js";
import { loadPricing } from "../src/pricing-remote.js";

const root = mkdtempSync(join(tmpdir(), "cache-warmer-pricing-"));
after(() => rmSync(root, { recursive: true, force: true }));

const URL = "https://example.invalid/pricing.json";
const T0 = new Date("2099-01-01T00:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function fakeFetch(respond: () => Response) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    return respond();
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const withAsOf = (asOf: string, readBp = 700): PricingTable => ({
  ...BUNDLED_PRICING,
  asOf,
  models: BUNDLED_PRICING.models.map((m) => (m.id === "claude-opus-5" ? { ...m, readBp } : m)),
});
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

test("no remote URL means no request and the bundled table", async () => {
  const fetch = fakeFetch(json(withAsOf("2099-12-31")));
  const pricing = await loadPricing({ url: null, fetchImpl: fetch.fn, now: T0 });
  assert.equal(pricing.source, "bundled");
  assert.equal(fetch.calls(), 0);
});

test("a newer remote table wins and is cached for a day", async () => {
  const cacheDir = join(root, "fresh");
  const fetch = fakeFetch(json(withAsOf("2099-12-31")));
  const first = await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: T0 });
  assert.equal(first.source, "remote");
  assert.equal(lookupModel("claude-opus-5", first.table).readBp, 700);
  assert.ok(existsSync(join(cacheDir, "pricing-remote.json")));

  const cached = await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: later(23 * 60) });
  assert.equal(cached.source, "remote");
  assert.equal(fetch.calls(), 1);

  await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: later(24 * 60) });
  assert.equal(fetch.calls(), 2);
});

test("an older remote table loses to the bundled snapshot", async () => {
  const fetch = fakeFetch(json(withAsOf("2000-01-01")));
  const pricing = await loadPricing({ url: URL, fetchImpl: fetch.fn, now: T0 });
  assert.equal(pricing.source, "bundled");
});

test("a malformed table is ignored and retried after an hour", async () => {
  const cacheDir = join(root, "malformed");
  const fetch = fakeFetch(json({ asOf: "2099-12-31", models: [{ id: "x" }] }));
  assert.equal((await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: T0 })).source, "bundled");
  await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: later(30) });
  assert.equal(fetch.calls(), 1);
  await loadPricing({ url: URL, cacheDir, fetchImpl: fetch.fn, now: later(61) });
  assert.equal(fetch.calls(), 2);
});

test("network errors and HTTP errors fall back to the bundled table", async () => {
  const failing = fakeFetch(() => {
    throw new Error("offline");
  });
  assert.equal((await loadPricing({ url: URL, fetchImpl: failing.fn, now: T0 })).source, "bundled");
  const notFound = fakeFetch(() => new Response("nope", { status: 404 }));
  assert.equal((await loadPricing({ url: URL, fetchImpl: notFound.fn, now: T0 })).source, "bundled");
});
