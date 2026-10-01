import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PricingTable } from "../src/pricing.js";
import { createUsageRecorder } from "../src/recorder.js";
import { openSqliteStore } from "../src/sqlite.js";
import { formatStats, summarize } from "../src/stats.js";
import { createMemoryStore, type RoutingRecord, type UsageRecord } from "../src/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const routing: RoutingRecord = {
  action: "shadow",
  reason: "tier standard->fast",
  tier: "fast",
  effort: "low",
  model: "claude-haiku-4-5",
  decided: true,
  deciderMs: 85,
  deciderCostUsd: 0.00002,
  altCostUsd: 0.001,
};

const base: UsageRecord = {
  ts: 5,
  provider: "anthropic",
  method: "POST",
  path: "/v1/messages",
  status: 200,
  model: "claude-sonnet-5-5",
  requestModel: "claude-sonnet-5-5",
  stream: true,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.1,
  firstByteMs: 1,
  totalMs: 2,
  error: null,
  routing: null,
};

describe("routing in the usage store", () => {
  it("round-trips a routing record through sqlite", () => {
    const store = openSqliteStore(":memory:");
    store.insert({ ...base, routing });
    store.insert({ ...base, ts: 6 });
    const [a, b] = store.list();
    expect(a?.routing).toEqual(routing);
    expect(b?.routing).toBeNull();
  });

  it("upgrades a database created before routing existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "ty-"));
    dirs.push(dir);
    const file = join(dir, "usage.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE usage (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, provider TEXT NOT NULL,
      method TEXT NOT NULL, path TEXT NOT NULL, status INTEGER NOT NULL, model TEXT, request_model TEXT,
      stream INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
      cache_write_tokens INTEGER, cost_usd REAL, first_byte_ms REAL, total_ms REAL NOT NULL, error TEXT);
      CREATE INDEX usage_ts ON usage (ts);
      INSERT INTO usage (ts, provider, method, path, status, stream, total_ms) VALUES (1,'openai','POST','/v1/responses',200,0,3);
      PRAGMA user_version = 1;`);
    old.close();
    const store = openSqliteStore(file);
    expect(store.list()[0]).toMatchObject({ ts: 1, routing: null });
    store.insert({ ...base, routing });
    expect(store.list()).toHaveLength(2);
    store.close();
  });
});

describe("createUsageRecorder routing", () => {
  const pricing = new PricingTable({
    "claude-sonnet-5-5": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
    "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  });
  const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const exchange = (action: "shadow" | "route") => ({
    provider: "anthropic" as const,
    method: "POST",
    path: "/v1/messages",
    status: 200,
    firstByteMs: 1,
    totalMs: 2,
    startedAt: 1,
    requestModel: "claude-sonnet-5-5",
    model: action === "route" ? "claude-haiku-4-5" : "claude-sonnet-5-5",
    usage,
    routing: {
      action,
      reason: "r",
      decided: true,
      model: "claude-haiku-4-5",
      target: { tier: "fast" as const, effort: "low" as const },
    },
  });

  it("prices the routed model as the alternative when only watching", () => {
    const store = createMemoryStore();
    createUsageRecorder(store, pricing)(exchange("shadow"));
    expect(store.list()[0]?.routing?.altCostUsd).toBeCloseTo(1000 * 1e-6 + 100 * 5e-6, 10);
  });

  it("prices the requested model as the alternative when it rewrote the request", () => {
    const store = createMemoryStore();
    createUsageRecorder(store, pricing)(exchange("route"));
    expect(store.list()[0]?.routing?.altCostUsd).toBeCloseTo(1000 * 3e-6 + 100 * 15e-6, 10);
  });
});

describe("routing in stats", () => {
  const rec = (routing: RoutingRecord | null, over: Partial<UsageRecord> = {}): UsageRecord => ({
    ...base,
    routing,
    ...over,
  });

  it("summarizes shadow decisions, the decider's cost and the estimated saving", () => {
    const stats = summarize([
      rec(routing, { costUsd: 0.1 }),
      rec({ ...routing, model: "claude-sonnet-5-5", altCostUsd: 0.1 }, { costUsd: 0.1 }),
      rec({
        ...routing,
        action: "passthrough",
        reason: "decider failed (timeout: slow)",
        decided: false,
        deciderMs: 800,
        tier: null,
        effort: null,
        model: null,
      }),
      rec(null),
    ]);
    expect(stats.routing).toMatchObject({
      requests: 3,
      shadow: 2,
      passedThrough: 1,
      switches: 1,
      decisions: 2,
      priced: 1,
    });
    expect(stats.routing?.savedUsd).toBeCloseTo(0.1 - 0.001, 10);
    expect(stats.routing?.passthroughReasons).toEqual([{ reason: "decider failed", count: 1 }]);
    const text = formatStats(stats, "all time");
    expect(text).toContain("Routing (shadow mode)");
    expect(text).toContain("would save");
  });

  it("counts a rerouted request's saving as what the requested model would have cost", () => {
    const stats = summarize([
      rec({ ...routing, action: "route", altCostUsd: 0.5 }, { costUsd: 0.1 }),
    ]);
    expect(stats.routing?.savedUsd).toBeCloseTo(0.4, 10);
    expect(formatStats(stats, "x")).toContain("saved");
  });

  it("has no routing section when routing was never involved", () => {
    expect(summarize([rec(null)]).routing).toBeNull();
  });
});
