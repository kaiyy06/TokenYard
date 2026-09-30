import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Usage } from "./usage.js";

/** Prices in US dollars per token. */
export interface ModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * Makes provider model ids comparable: `claude-haiku-4-5-20251001` (Anthropic API) and
 * `anthropic/claude-haiku-4.5` (OpenRouter) both become `claude-haiku-4-5`.
 */
export function normalizeModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/\./g, "-")
    .replace(/-latest$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

export class PricingTable {
  readonly #prices: ReadonlyMap<string, ModelPrice>;

  constructor(prices: Readonly<Record<string, ModelPrice>> = {}) {
    this.#prices = new Map(Object.entries(prices).map(([id, p]) => [normalizeModelId(id), p]));
  }

  get size(): number {
    return this.#prices.size;
  }

  lookup(model: string): ModelPrice | undefined {
    return this.#prices.get(normalizeModelId(model));
  }

  /** Cost in dollars, or undefined when the model has no known price. */
  cost(model: string, usage: Usage): number | undefined {
    const price = this.lookup(model);
    if (!price) return undefined;
    return (
      usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite
    );
  }

  /** A copy with `overrides` laid over this table. */
  with(overrides: Readonly<Record<string, ModelPrice>>): PricingTable {
    return new PricingTable({ ...Object.fromEntries(this.#prices), ...overrides });
  }

  toJSON(): Record<string, ModelPrice> {
    return Object.fromEntries(this.#prices);
  }
}

function price(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Reads prices from an OpenRouter `/models` response. Variants such as `:batch` or `:free`
 * are skipped, and so are the prompt-size tiers some models list. Missing cache prices fall
 * back to the plain input price, which can only overstate cost.
 */
export function parseOpenRouterModels(json: unknown): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  const data = (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const id = entry?.id;
    const pricing = entry?.pricing;
    if (typeof id !== "string" || id.includes(":") || typeof pricing !== "object") continue;
    const input = price(pricing?.prompt);
    const output = price(pricing?.completion);
    if (input === undefined || output === undefined) continue;
    out[id] = {
      input,
      output,
      cacheRead: price(pricing.input_cache_read) ?? input,
      cacheWrite: price(pricing.input_cache_write) ?? input,
    };
  }
  return out;
}

export interface LoadPricingOptions {
  /** Where fetched prices are cached between runs. */
  readonly cacheFile: string;
  /** Refetch when the cache is older than this. Defaults to a day. */
  readonly maxAgeMs?: number;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

interface PriceCache {
  readonly fetchedAt: number;
  readonly prices: Record<string, ModelPrice>;
}

async function readCache(file: string): Promise<PriceCache | undefined> {
  try {
    const cache = JSON.parse(await readFile(file, "utf8")) as PriceCache;
    return typeof cache.fetchedAt === "number" && cache.prices ? cache : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads prices from the on-disk cache, refreshing it from OpenRouter when stale. Never throws:
 * offline, it falls back to a stale cache, and with none it returns an empty table, so models
 * are reported as unpriced rather than the gateway failing.
 */
export async function loadPricing(options: LoadPricingOptions): Promise<PricingTable> {
  const now = options.now?.() ?? Date.now();
  const cached = await readCache(options.cacheFile);
  if (cached && now - cached.fetchedAt < (options.maxAgeMs ?? 24 * 60 * 60 * 1000)) {
    return new PricingTable(cached.prices);
  }
  try {
    const response = await (options.fetch ?? fetch)(
      options.url ?? "https://openrouter.ai/api/v1/models",
      { signal: AbortSignal.timeout(options.timeoutMs ?? 5000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const prices = parseOpenRouterModels(await response.json());
    if (Object.keys(prices).length === 0) throw new Error("no prices in response");
    await mkdir(dirname(options.cacheFile), { recursive: true });
    await writeFile(options.cacheFile, JSON.stringify({ fetchedAt: now, prices }));
    return new PricingTable(prices);
  } catch {
    return new PricingTable(cached?.prices);
  }
}
