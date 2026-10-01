import { describe, expect, it } from "vitest";
import { PricingTable } from "../src/pricing.js";
import type { Classification } from "../src/routing/classifier.js";
import { createRouter, type RouterConfig } from "../src/routing/router.js";
import { createSessionStore } from "../src/routing/session.js";
import type { Signals } from "../src/routing/types.js";

const pricing = new PricingTable({
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  "claude-sonnet-5-5": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
  "gpt-5-mini": { input: 2.5e-7, output: 2e-6, cacheRead: 2.5e-8, cacheWrite: 2.5e-7 },
  "gpt-5": { input: 1.25e-6, output: 1e-5, cacheRead: 1.25e-7, cacheWrite: 1.25e-6 },
  "gpt-5-pro": { input: 1.5e-5, output: 1.2e-4, cacheRead: 1.5e-6, cacheWrite: 1.5e-5 },
  "claude-opus-5-5": { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheWrite: 6.25e-6 },
});

const config = (mode: RouterConfig["mode"]): RouterConfig => ({
  mode,
  tiers: {
    anthropic: {
      fast: "claude-haiku-4-5",
      standard: "claude-sonnet-5-5",
      frontier: "claude-opus-5-5",
    },
    openai: { fast: "gpt-5-mini", standard: "gpt-5", frontier: "gpt-5-pro" },
  },
});

const signals = (over: Partial<Signals> = {}): Signals => ({
  tier: { choice: "fast", confidence: 0.9 },
  effort: { score: 0, confidence: 0.9 },
  taskChanged: 0.9,
  ...over,
});

function harness(mode: RouterConfig["mode"], answer: Classification | (() => Classification)) {
  let calls = 0;
  const router = createRouter({
    config: config(mode),
    sessions: createSessionStore(),
    pricing,
    classify: async () => {
      calls++;
      return typeof answer === "function" ? answer() : answer;
    },
  });
  return { router, calls: () => calls };
}

const ok = (s: Signals): Classification => ({ ok: true, signals: s, latencyMs: 90, model: "jev" });

const turn = (text: string, extra: object[] = []) => ({
  model: "claude-sonnet-5-5",
  metadata: { user_id: JSON.stringify({ session_id: "s1" }) },
  messages: [{ role: "user", content: text }, ...extra],
});

const toolRound = [
  { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] },
];

describe("router", () => {
  it("routes a trivial first turn down and says which model it chose", async () => {
    const { router } = harness("route", ok(signals()));
    const d = await router.decide("/v1/messages", turn("rename foo to bar"));
    expect(d).toMatchObject({
      action: "route",
      decided: true,
      model: "claude-haiku-4-5",
      target: { tier: "fast", effort: "none" },
      deciderLatencyMs: 90,
    });
  });

  it("only logs in shadow mode but still reports the decision", async () => {
    const { router } = harness("shadow", ok(signals()));
    const d = await router.decide("/v1/messages", turn("rename foo to bar"));
    expect(d).toMatchObject({ action: "shadow", model: "claude-haiku-4-5" });
  });

  it("does nothing when off", async () => {
    const { router, calls } = harness("off", ok(signals()));
    expect((await router.decide("/v1/messages", turn("x"))).action).toBe("passthrough");
    expect(calls()).toBe(0);
  });

  it("decides once per user turn and reuses it for tool-result continuations", async () => {
    const { router, calls } = harness("route", ok(signals()));
    await router.decide("/v1/messages", turn("rename foo to bar"));
    const d = await router.decide("/v1/messages", turn("rename foo to bar", toolRound));
    expect(calls()).toBe(1);
    expect(d).toMatchObject({ reason: "continuation", decided: false, model: "claude-haiku-4-5" });
  });

  it("forwards unchanged when the decider fails", async () => {
    const { router } = harness("route", { ok: false, reason: "timeout: slow", latencyMs: 800 });
    const d = await router.decide("/v1/messages", turn("x"));
    expect(d.action).toBe("passthrough");
    expect(d.reason).toContain("decider failed");
  });

  it("forwards unchanged when the classifier throws", async () => {
    const { router } = harness("route", () => {
      throw new Error("boom");
    });
    const d = await router.decide("/v1/messages", turn("x"));
    expect(d).toMatchObject({ action: "passthrough" });
    expect(d.reason).toContain("boom");
  });

  it("leaves pinned models and unknown requests alone", async () => {
    const { router, calls } = harness("route", ok(signals()));
    const pinned = await router.decide("/v1/messages", {
      ...turn("x"),
      model: "some-custom-model",
    });
    expect(pinned.action).toBe("passthrough");
    const odd = await router.decide("/v1/messages", { not: "a request" });
    expect(odd.action).toBe("passthrough");
    expect(calls()).toBe(0);
  });

  it("leaves the agent's own fast-tier calls alone", async () => {
    const { router, calls } = harness("route", ok(signals()));
    const d = await router.decide("/v1/messages", {
      ...turn("title this"),
      model: "claude-haiku-4-5",
    });
    expect(d.action).toBe("passthrough");
    expect(calls()).toBe(0);
  });

  it("does not drop a big cached session to a cheaper model mid-task", async () => {
    let answer = signals({ tier: { choice: "frontier", confidence: 0.9 } });
    const { router } = harness("route", () => ok(answer));
    const first = await router.decide("/v1/messages", turn("design the system"));
    expect(first.target?.tier).toBe("frontier");
    router.observe(first.sessionKey as string, 150_000);
    answer = signals({ tier: { choice: "fast", confidence: 0.99 }, taskChanged: 0.1 });
    const second = await router.decide(
      "/v1/messages",
      turn("design the system", [...toolRound, { role: "user", content: "also tweak a comment" }]),
    );
    expect(second.target?.tier).toBe("frontier");
  });

  it("restarts from the user's choice when they switch models", async () => {
    const { router } = harness(
      "route",
      ok(signals({ tier: { choice: "frontier", confidence: 0.9 } })),
    );
    await router.decide("/v1/messages", turn("hard problem"));
    const switched = await router.decide("/v1/messages", {
      ...turn("hard problem", toolRound),
      model: "claude-opus-5-5",
    });
    expect(switched.reason).not.toBe("continuation");
  });

  it("routes OpenAI requests with the OpenAI tier map", async () => {
    const { router } = harness("route", ok(signals()));
    const d = await router.decide("/responses", {
      model: "gpt-5",
      prompt_cache_key: "c1",
      input: [{ type: "message", role: "user", content: "hi" }],
    });
    expect(d).toMatchObject({ action: "route", model: "gpt-5-mini" });
  });
});
