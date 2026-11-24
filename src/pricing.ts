import bundled from "./pricing.json" with { type: "json" };

export type Provider = "anthropic" | "openai";
export type TtlTier = "5m" | "1h";
/** How the session is billed: API list prices, or Codex credits on a ChatGPT plan. */
export type Billing = "api" | "codex-credits";

/** Multipliers are basis points of the base input price (10000 = 1x). */
export interface ModelPrice {
  id: string;
  provider: Provider;
  label: string;
  inputUsdPerMTok?: number;
  readBp: number;
  write5mBp?: number;
  write1hBp?: number;
  writeBp?: number;
  /** Output price relative to base input. */
  outputBp?: number;
  /** Documented minimum cache lifetime of an OpenAI model; a Claude session's TTL tier comes from its transcript. */
  ttlMinutes?: number;
  /** True when the model is missing from the table and family defaults were used. */
  estimated: boolean;
}

export interface PricingTable {
  asOf: string;
  /** Where installed plugins fetch a newer copy of this table; null disables fetching. */
  remoteUrl: string | null;
  sources: Record<string, string>;
  models: Omit<ModelPrice, "estimated">[];
}

export interface Pricing {
  table: PricingTable;
  source: "bundled" | "remote";
}

export const BUNDLED_PRICING = bundled as PricingTable;

export function lookupModel(modelId: string, table: PricingTable = BUNDLED_PRICING): ModelPrice {
  const id = normalizeModelId(modelId);
  const known = table.models.find((model) => model.id === id);
  return known ? { ...known, estimated: false } : familyDefault(id);
}

/** Drops dated snapshot suffixes such as `-20251001`. */
export function normalizeModelId(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

function familyDefault(id: string): ModelPrice {
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
export function coldResumeBp(price: ModelPrice, tier: TtlTier, billing: Billing): number {
  if (price.provider === "anthropic") {
    return tier === "1h" ? (price.write1hBp ?? 20000) : (price.write5mBp ?? 12500);
  }
  if (billing === "codex-credits") return 10000;
  return price.writeBp ?? 10000;
}
