import { describe, expect, it } from "vitest";
import type { ModelPrice } from "../src/pricing.js";
import { switchPaysOff } from "../src/routing/cache.js";
import { applyPolicy, effortFromScore, type PolicyContext } from "../src/routing/policy.js";
import {
  DEFAULT_POLICY,
  EFFORTS,
  type Signals,
  type Target,
  TIERS,
  type Tier,
  tierRank,
} from "../src/routing/types.js";

const PRICES: Record<Tier, ModelPrice> = {
  fast: { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  standard: { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
  frontier: { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheWrite: 6.25e-6 },
};

const context = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  contextTokens: 50_000,
  remainingTurns: 20,
  price: (t) => PRICES[t],
  newSession: false,
  ...over,
});

const signals = (over: Partial<Signals> = {}): Signals => ({
  tier: { choice: "standard", confidence: 0.9 },
  effort: { score: 1, confidence: 0.9 },
  taskChanged: 0.9,
  ...over,
});

const at = (tier: Tier, effort: Target["effort"] = "low"): Target => ({ tier, effort });

/** A small seeded generator so property failures can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomSignals(next: () => number): Signals {
  return {
    tier: { choice: TIERS[Math.floor(next() * 3)] as Tier, confidence: next() },
    effort: { score: next() * 3, confidence: next() },
    taskChanged: next(),
  };
}

describe("effortFromScore", () => {
  it("rounds to the nearest level and clamps", () => {
    expect(effortFromScore(0.4)).toBe("none");
    expect(effortFromScore(1.6)).toBe("medium");
    expect(effortFromScore(9)).toBe("high");
    expect(effortFromScore(-2)).toBe("none");
  });
});

describe("applyPolicy", () => {
  it("moves up when the decider is confident enough, even mid-task", () => {
    const out = applyPolicy(
      at("fast"),
      signals({ tier: { choice: "frontier", confidence: 0.55 }, taskChanged: 0.1 }),
      DEFAULT_POLICY,
      context(),
    );
    expect(out.target.tier).toBe("frontier");
  });

  it("does not move up on a low-confidence answer", () => {
    const out = applyPolicy(
      at("fast"),
      signals({ tier: { choice: "frontier", confidence: 0.3 } }),
      DEFAULT_POLICY,
      context(),
    );
    expect(out.target.tier).toBe("fast");
  });

  it("moves down at a task boundary when the cache math favors it", () => {
    const out = applyPolicy(
      at("frontier"),
      signals({ tier: { choice: "fast", confidence: 0.9 } }),
      DEFAULT_POLICY,
      context(),
    );
    expect(out.target.tier).toBe("fast");
    expect(out.reason).toContain("tier frontier->fast");
  });

  it("stays put mid-task even when the decider wants a cheaper model", () => {
    const out = applyPolicy(
      at("frontier"),
      signals({ tier: { choice: "fast", confidence: 0.99 }, taskChanged: 0.2 }),
      DEFAULT_POLICY,
      context(),
    );
    expect(out.target.tier).toBe("frontier");
  });

  it("stays put when too few turns remain to repay rebuilding the cache", () => {
    const out = applyPolicy(
      at("frontier"),
      signals({ tier: { choice: "fast", confidence: 0.9 } }),
      DEFAULT_POLICY,
      context({ remainingTurns: 1 }),
    );
    expect(out.target.tier).toBe("frontier");
  });

  it("treats the first request of a session as a task boundary with an empty cache", () => {
    const out = applyPolicy(
      at("frontier"),
      signals({ tier: { choice: "fast", confidence: 0.8 }, taskChanged: 0 }),
      DEFAULT_POLICY,
      context({ newSession: true, contextTokens: 0, remainingTurns: 5 }),
    );
    expect(out.target.tier).toBe("fast");
  });

  it("lets effort fall freely when the tier is already changing", () => {
    const out = applyPolicy(
      at("frontier", "high"),
      signals({ tier: { choice: "fast", confidence: 0.9 }, effort: { score: 0, confidence: 0.9 } }),
      DEFAULT_POLICY,
      context(),
    );
    expect(out.target).toEqual({ tier: "fast", effort: "none" });
  });

  it("keeps the current target when a price is unknown", () => {
    const out = applyPolicy(
      at("frontier"),
      signals({ tier: { choice: "fast", confidence: 0.9 } }),
      DEFAULT_POLICY,
      context({ price: () => undefined }),
    );
    expect(out.target.tier).toBe("frontier");
  });

  it("keeps the current target on nonsense signals", () => {
    const current = at("standard");
    for (const bad of [
      signals({ tier: { choice: "fast", confidence: Number.NaN } }),
      signals({ taskChanged: 2 }),
      signals({ effort: { score: Number.NaN, confidence: 0.9 } }),
    ]) {
      expect(applyPolicy(current, bad, DEFAULT_POLICY, context()).target).toEqual(current);
    }
  });
});

describe("policy properties", () => {
  it("never moves down without a task change and high confidence", () => {
    const next = rng(1);
    for (let i = 0; i < 2000; i++) {
      const current = at(TIERS[Math.floor(next() * 3)] as Tier, EFFORTS[Math.floor(next() * 4)]);
      const s = randomSignals(next);
      const out = applyPolicy(current, s, DEFAULT_POLICY, context({ remainingTurns: 1000 }));
      if (tierRank(out.target.tier) < tierRank(current.tier)) {
        expect(s.taskChanged).toBeGreaterThan(DEFAULT_POLICY.taskChangedThreshold);
        expect(s.tier.confidence).toBeGreaterThanOrEqual(DEFAULT_POLICY.downgradeMinConfidence);
      }
    }
  });

  it("only ever lands on the current tier or the one the decider chose", () => {
    const next = rng(2);
    for (let i = 0; i < 2000; i++) {
      const current = at(TIERS[Math.floor(next() * 3)] as Tier);
      const s = randomSignals(next);
      const { target } = applyPolicy(current, s, DEFAULT_POLICY, context());
      expect([current.tier, s.tier.choice]).toContain(target.tier);
    }
  });

  it("always upgrades a confident request for a bigger tier, whatever the cache holds", () => {
    const next = rng(3);
    for (let i = 0; i < 1000; i++) {
      const s = randomSignals(next);
      if (s.tier.choice === "fast" || s.tier.confidence < DEFAULT_POLICY.upgradeMinConfidence)
        continue;
      const out = applyPolicy(
        at("fast"),
        s,
        DEFAULT_POLICY,
        context({ contextTokens: Math.floor(next() * 1e6), remainingTurns: 0 }),
      );
      expect(out.target.tier).toBe(s.tier.choice);
    }
  });

  it("is a no-op when the decider agrees with the current target", () => {
    const next = rng(4);
    for (let i = 0; i < 500; i++) {
      const tier = TIERS[Math.floor(next() * 3)] as Tier;
      const s = signals({
        tier: { choice: tier, confidence: next() },
        effort: { score: 1, confidence: next() },
        taskChanged: next(),
      });
      expect(applyPolicy(at(tier, "low"), s, DEFAULT_POLICY, context()).target).toEqual(
        at(tier, "low"),
      );
    }
  });
});

describe("switchPaysOff", () => {
  const base = { contextTokens: 80_000, current: PRICES.frontier, next: PRICES.fast };

  it("only gets easier as more turns remain", () => {
    let seen = false;
    for (let turns = 0; turns <= 200; turns++) {
      const ok = switchPaysOff({ ...base, remainingTurns: turns });
      if (seen) expect(ok).toBe(true);
      seen ||= ok;
    }
    expect(seen).toBe(true);
  });

  it("never pays off when the new model is no cheaper to read from cache", () => {
    const next = rng(5);
    for (let i = 0; i < 500; i++) {
      expect(
        switchPaysOff({
          contextTokens: 1 + Math.floor(next() * 1e6),
          current: PRICES.fast,
          next: PRICES.fast,
          remainingTurns: Math.floor(next() * 1e4),
        }),
      ).toBe(false);
    }
  });

  it("refuses prices that are not numbers", () => {
    expect(
      switchPaysOff({
        ...base,
        remainingTurns: 50,
        next: { ...PRICES.fast, cacheWrite: Number.NaN },
      }),
    ).toBe(false);
  });
});
