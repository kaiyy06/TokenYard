import type { DecideResult, Decider, Questions } from "@tokenyard/decider";
import { describe, expect, it } from "vitest";
import { buildState, createClassifier } from "../src/routing/classifier.js";
import type { RequestShape } from "../src/routing/request.js";
import type { Session } from "../src/routing/session.js";

const shape: RequestShape = {
  api: "anthropic-messages",
  model: "claude-sonnet-5-5",
  systemText: "SECRET SYSTEM PROMPT",
  firstUserText: "build a thing",
  lastUserText: "now rename it",
  newUserTurn: true,
  userTurns: 4,
  recentTools: ["Read", "Edit"],
  toolErrors: 1,
  sizeChars: 10,
};
const session: Session = { key: "k", contextTokens: 5000, turns: 3, lastSeen: 0 };

function fake(result: unknown): Decider {
  return {
    model: "fake",
    decide: async () => result as DecideResult<Questions>,
  } as unknown as Decider;
}

const answered = {
  ok: true,
  decision: {
    model: "jev",
    latencyMs: 120,
    usage: { inputTokens: 300, outputTokens: 0, costUsd: 0.00001 },
    answers: {
      tier: { type: "choice", choice: "fast", confidence: 0.9, probabilities: {} },
      effort: { type: "score", score: 0.4, confidence: 0.8, probabilities: {} },
      task_changed: { type: "noul", noul: 0.95 },
    },
  },
};

describe("buildState", () => {
  it("includes the goal, latest message and counts but not the system prompt", () => {
    const state = buildState(shape, session);
    expect(state).toMatchObject({
      task_goal: "build a thing",
      latest_message: "now rename it",
      turn_count: 4,
      context_tokens: 5000,
      recent_tools: ["Read", "Edit"],
      tool_errors: 1,
    });
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });

  it("truncates long text and can leave out tool names", () => {
    const state = buildState({ ...shape, lastUserText: "x".repeat(50) }, session, {
      maxChars: 10,
      includeToolNames: false,
    });
    expect(state.latest_message).toBe(`${"x".repeat(10)}…`);
    expect(state).not.toHaveProperty("recent_tools");
  });
});

describe("createClassifier", () => {
  it("turns the decider's answers into signals", async () => {
    const out = await createClassifier(fake(answered))(shape, session);
    expect(out).toMatchObject({
      ok: true,
      latencyMs: 120,
      costUsd: 0.00001,
      signals: {
        tier: { choice: "fast", confidence: 0.9 },
        effort: { score: 0.4, confidence: 0.8 },
        taskChanged: 0.95,
      },
    });
  });

  it("reports a failure instead of throwing", async () => {
    const out = await createClassifier(
      fake({ ok: false, error: { kind: "timeout", message: "too slow", latencyMs: 800 } }),
    )(shape, session);
    expect(out).toEqual({ ok: false, reason: "timeout: too slow", latencyMs: 800 });
  });

  it("rejects a tier it does not know", async () => {
    const odd = structuredClone(answered);
    odd.decision.answers.tier.choice = "huge";
    const out = await createClassifier(fake(odd))(shape, session);
    expect(out.ok).toBe(false);
  });
});
