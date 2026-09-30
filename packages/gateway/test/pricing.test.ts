import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPricing,
  normalizeModelId,
  PricingTable,
  parseOpenRouterModels,
} from "../src/pricing.js";

const FEED = {
  data: [
    {
      id: "anthropic/claude-sonnet-5.5",
      pricing: {
        prompt: "0.000002",
        completion: "0.00001",
        input_cache_read: "0.0000002",
        input_cache_write: "0.0000025",
      },
    },
    {
      id: "anthropic/claude-sonnet-5.5:batch",
      pricing: { prompt: "0.000001", completion: "0.000005" },
    },
    { id: "openai/gpt-5", pricing: { prompt: "0.000001", completion: "0.00001" } },
    { id: "broken/model", pricing: { prompt: "abc", completion: "1" } },
  ],
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pricing-"));
  dirs.push(dir);
  return join(dir, "sub", "pricing.json");
}

describe("normalizeModelId", () => {
  it("makes Anthropic API ids and OpenRouter ids comparable", () => {
    expect(normalizeModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4-5");
    expect(normalizeModelId("gpt-5-2025-08-07")).toBe("gpt-5");
    expect(normalizeModelId("Claude-Sonnet-5-5-latest")).toBe("claude-sonnet-5-5");
  });
});

describe("parseOpenRouterModels", () => {
  it("keeps plain models, skips variants and malformed entries, and defaults cache prices", () => {
    const prices = parseOpenRouterModels(FEED);
    expect(Object.keys(prices).sort()).toEqual(["anthropic/claude-sonnet-5.5", "openai/gpt-5"]);
    expect(prices["openai/gpt-5"]).toEqual({
      input: 0.000001,
      output: 0.00001,
      cacheRead: 0.000001,
      cacheWrite: 0.000001,
    });
  });

  it("returns nothing for unexpected shapes", () => {
    expect(parseOpenRouterModels(null)).toEqual({});
    expect(parseOpenRouterModels({ data: "x" })).toEqual({});
  });
});

describe("PricingTable", () => {
  const table = new PricingTable(parseOpenRouterModels(FEED));

  it("prices each kind of token", () => {
    const cost = table.cost("claude-sonnet-5-5", {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2000,
    });
    // 1000*2e-6 + 100*1e-5 + 10000*2e-7 + 2000*2.5e-6
    expect(cost).toBeCloseTo(0.002 + 0.001 + 0.002 + 0.005, 10);
  });

  it("returns undefined for unknown models and lets overrides win", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(table.cost("mystery", usage)).toBeUndefined();
    const custom = table.with({ mystery: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    expect(custom.cost("mystery", usage)).toBe(3);
  });
});

describe("loadPricing", () => {
  const ok = (async () => Response.json(FEED)) as unknown as typeof fetch;
  const down = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;

  it("fetches, caches, and reuses a fresh cache without fetching again", async () => {
    const cacheFile = await tempFile();
    let calls = 0;
    const counting = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return ok(...args);
    }) as typeof fetch;

    expect((await loadPricing({ cacheFile, fetch: counting })).size).toBe(2);
    expect((await loadPricing({ cacheFile, fetch: counting })).size).toBe(2);
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(cacheFile, "utf8")).prices).toBeDefined();
  });

  it("falls back to a stale cache when offline, and to an empty table with none", async () => {
    const cacheFile = await tempFile();
    await loadPricing({ cacheFile, fetch: ok, now: () => 0 });
    const stale = await loadPricing({ cacheFile, fetch: down, now: () => 10 * 24 * 3600 * 1000 });
    expect(stale.size).toBe(2);
    expect((await loadPricing({ cacheFile: await tempFile(), fetch: down })).size).toBe(0);
  });

  it("ignores a corrupt cache", async () => {
    const cacheFile = await tempFile();
    await loadPricing({ cacheFile, fetch: ok });
    await writeFile(cacheFile, "garbage");
    expect((await loadPricing({ cacheFile, fetch: ok })).size).toBe(2);
  });
});
