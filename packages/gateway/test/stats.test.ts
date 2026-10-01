import { describe, expect, it } from "vitest";
import { openSqliteStore } from "../src/sqlite.js";
import { formatStats, parseSince, summarize, toCsv, toJsonl } from "../src/stats.js";
import { createMemoryStore, type UsageRecord } from "../src/store.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ts: 1000,
    provider: "anthropic",
    method: "POST",
    path: "/v1/messages",
    status: 200,
    model: "claude-sonnet-5-5",
    requestModel: "claude-sonnet-5-5",
    stream: true,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    firstByteMs: 100,
    totalMs: 400,
    error: null,
    routing: null,
    ...overrides,
  };
}

describe("summarize", () => {
  it("totals per model, counts failures and unpriced requests, and finds the cache hit rate", () => {
    const stats = summarize([
      record(),
      record({ costUsd: 0.03, firstByteMs: 300 }),
      record({ model: "gpt-5", provider: "openai", costUsd: null, cacheReadTokens: 0 }),
      record({
        status: 529,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        costUsd: null,
        firstByteMs: null,
      }),
    ]);
    expect(stats.requests).toBe(4);
    expect(stats.failed).toBe(1);
    expect(stats.totals.costUsd).toBeCloseTo(0.04);
    expect(stats.totals.unpriced).toBe(2);
    expect(stats.byModel.map((m) => [m.model, m.requests])).toEqual([
      ["claude-sonnet-5-5", 3],
      ["gpt-5", 1],
    ]);
    expect(stats.cacheHitRate).toBeCloseTo(1800 / 2100);
    expect(stats.firstByteMs).toEqual({ p50: 100, p95: 300 });
  });

  it("handles no records", () => {
    const stats = summarize([]);
    expect(stats.requests).toBe(0);
    expect(stats.cacheHitRate).toBeNull();
    expect(stats.firstByteMs).toBeNull();
    expect(formatStats(stats, "in the last 24h")).toBe("No requests recorded in the last 24h.");
  });
});

describe("formatStats", () => {
  it("prints a readable report", () => {
    const text = formatStats(summarize([record(), record({ costUsd: null })]), "in the last 24h");
    expect(text).toContain("Requests   2");
    expect(text).toContain("(1 requests unpriced)");
    expect(text).toContain("claude-sonnet-5-5");
  });
});

describe("parseSince", () => {
  it("parses durations relative to now", () => {
    expect(parseSince("90m", 10_000_000)).toBe(10_000_000 - 90 * 60_000);
    expect(parseSince("2d", 1e9)).toBe(1e9 - 2 * 86_400_000);
    expect(parseSince("all")).toBeUndefined();
  });

  it("rejects nonsense", () => {
    expect(() => parseSince("soon")).toThrow(/invalid duration/);
  });
});

describe("export", () => {
  it("writes JSONL, one record per line", () => {
    const lines = toJsonl([record(), record({ ts: 2 })])
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string).ts).toBe(2);
    expect(toJsonl([])).toBe("");
  });

  it("writes CSV with quoting and blanks for nulls", () => {
    const csv = toCsv([record({ error: 'bad "thing", really', costUsd: null })]).split("\n");
    expect(csv[0]?.startsWith("ts,provider,method,path,status,model")).toBe(true);
    expect(csv[1]).toContain(",,"); // null cost
    expect(csv[1]).toContain('"bad ""thing"", really"');
  });
});

describe("stores", () => {
  const range = [
    record({ ts: 10 }),
    record({ ts: 20 }),
    record({ ts: 30, stream: false, costUsd: null }),
  ];

  for (const [name, open] of [
    ["memory", () => createMemoryStore()],
    ["sqlite", () => openSqliteStore(":memory:")],
  ] as const) {
    it(`${name} store round-trips records and filters by time`, () => {
      const store = open();
      for (const r of range) store.insert(r);
      expect(store.list()).toEqual(range);
      expect(store.list({ since: 20 }).map((r) => r.ts)).toEqual([20, 30]);
      expect(store.list({ since: 10, until: 30 }).map((r) => r.ts)).toEqual([10, 20]);
      store.close();
    });
  }
});
