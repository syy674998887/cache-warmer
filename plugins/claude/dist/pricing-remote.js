import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUNDLED_PRICING } from "./pricing.js";
const FRESH_MS = 24 * 3_600_000;
const RETRY_MS = 3_600_000;
const TIMEOUT_MS = 2_000;
/**
 * The newer of the bundled snapshot and the copy published at `remoteUrl`, so price changes
 * reach installed plugins without a release. Fetches at most daily (hourly after a failure),
 * gives up after two seconds, and falls back to the bundled snapshot on any problem.
 */
export async function loadPricing(o = {}) {
    const now = (o.now ?? new Date()).getTime();
    const url = o.url === undefined ? BUNDLED_PRICING.remoteUrl : o.url;
    const cachePath = o.cacheDir ? join(o.cacheDir, "pricing-remote.json") : undefined;
    const cache = cachePath ? readCache(cachePath) : undefined;
    let remote = cache?.table ?? undefined;
    const lastSuccess = cache?.fetchedAt ? Date.parse(cache.fetchedAt) : Number.NEGATIVE_INFINITY;
    const lastAttempt = cache ? Date.parse(cache.attemptedAt) : Number.NEGATIVE_INFINITY;
    if (url && now - lastSuccess >= FRESH_MS && now - lastAttempt >= RETRY_MS) {
        const fetched = await fetchTable(url, o.fetchImpl ?? fetch);
        if (fetched)
            remote = fetched;
        if (cachePath) {
            const stamp = new Date(now).toISOString();
            writeCache(cachePath, { attemptedAt: stamp, fetchedAt: fetched ? stamp : (cache?.fetchedAt ?? null), table: remote ?? null });
        }
    }
    return remote && remote.asOf > BUNDLED_PRICING.asOf ? { table: remote, source: "remote" } : { table: BUNDLED_PRICING, source: "bundled" };
}
async function fetchTable(url, fetchImpl) {
    try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.ok)
            return undefined;
        const value = await response.json();
        return isPricingTable(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function isPricingTable(value) {
    if (value === null || typeof value !== "object")
        return false;
    const table = value;
    return (typeof table.asOf === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(table.asOf) &&
        Array.isArray(table.models) &&
        table.models.length > 0 &&
        table.models.every((model) => typeof model?.id === "string" &&
            (model.provider === "anthropic" || model.provider === "openai") &&
            Number.isInteger(model.readBp) &&
            model.readBp > 0));
}
function readCache(path) {
    if (!existsSync(path))
        return undefined;
    try {
        // Only tables that passed isPricingTable are ever written here.
        const cache = JSON.parse(readFileSync(path, "utf8"));
        return typeof cache.attemptedAt === "string" ? cache : undefined;
    }
    catch {
        return undefined;
    }
}
function writeCache(path, cache) {
    try {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, `${JSON.stringify(cache)}\n`);
    }
    catch {
        // An unwritable cache only means the next call fetches again.
    }
}
