import bundled from "./pricing.json" with { type: "json" };
export const BUNDLED_PRICING = bundled;
export function lookupModel(modelId, table = BUNDLED_PRICING) {
    const id = normalizeModelId(modelId);
    const known = table.models.find((model) => model.id === id);
    return known ? { ...known, estimated: false } : familyDefault(id);
}
/** Drops dated snapshot suffixes such as `-20251001`. */
export function normalizeModelId(modelId) {
    return modelId.replace(/-\d{8}$/, "");
}
function familyDefault(id) {
    if (id.startsWith("claude-")) {
        return { id, provider: "anthropic", label: id, readBp: 1000, write5mBp: 12500, write1hBp: 20000, outputBp: 50000, estimated: true };
    }
    // On the OpenAI API, GPT-5.6 and later bill cache writes at 1.25x; earlier models have no write charge.
    const version = /^gpt-(\d+)(?:\.(\d+))?/.exec(id);
    const major = version ? Number(version[1]) : undefined;
    const minor = version?.[2] ? Number(version[2]) : 0;
    const billsWrites = major === undefined || major > 5 || (major === 5 && minor >= 6);
    return { id, provider: "openai", label: id, readBp: 1000, outputBp: 50000, ...(billsWrites ? { writeBp: 12500 } : {}), estimated: true };
}
/** Multiplier paid when the user comes back to a cold cache and the context is processed again. */
export function coldResumeBp(price, tier, billing) {
    if (price.provider === "anthropic") {
        return tier === "1h" ? (price.write1hBp ?? 20000) : (price.write5mBp ?? 12500);
    }
    if (billing === "codex-credits")
        return 10000;
    return price.writeBp ?? 10000;
}
