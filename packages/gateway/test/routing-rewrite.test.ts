import { describe, expect, it } from "vitest";
import { rewriteRequest } from "../src/routing/rewrite.js";
import type { Effort, Tier } from "../src/routing/types.js";

const send = (
  path: string,
  body: object,
  model: string,
  tier: Tier = "fast",
  effort: Effort = "low",
) => {
  const out = rewriteRequest(path, Buffer.from(JSON.stringify(body)), model, { tier, effort });
  return out ? JSON.parse(out.toString("utf8")) : undefined;
};

describe("rewriteRequest", () => {
  it("swaps the model and effort on an Anthropic request and keeps the rest", () => {
    const body = {
      model: "claude-opus-5-5",
      max_tokens: 100,
      stream: true,
      output_config: { effort: "high" },
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    };
    expect(send("/v1/messages", body, "claude-haiku-4-5")).toEqual({
      ...body,
      model: "claude-haiku-4-5",
      output_config: { effort: "low" },
    });
  });

  it("does not add an effort the agent did not ask for", () => {
    const out = send(
      "/v1/messages",
      { model: "a", messages: [{ role: "user", content: "x" }] },
      "b",
    );
    expect(out).toEqual({ model: "b", messages: [{ role: "user", content: "x" }] });
  });

  it("sets Responses reasoning effort and keeps other reasoning fields", () => {
    const out = send(
      "/responses",
      { model: "gpt-5", reasoning: { effort: "high", context: "x" }, input: "hi" },
      "gpt-5-mini",
      "fast",
      "none",
    );
    expect(out).toEqual({
      model: "gpt-5-mini",
      reasoning: { effort: "minimal", context: "x" },
      input: "hi",
    });
  });

  it("sets Chat Completions reasoning_effort", () => {
    const out = send(
      "/v1/chat/completions",
      { model: "gpt-5", reasoning_effort: "high", messages: [{ role: "user", content: "x" }] },
      "gpt-5-mini",
      "fast",
      "medium",
    );
    expect(out.reasoning_effort).toBe("medium");
  });

  it("refuses bodies it cannot parse or recognize", () => {
    expect(
      rewriteRequest("/v1/messages", Buffer.from("nope"), "m", { tier: "fast", effort: "low" }),
    ).toBeUndefined();
    expect(
      rewriteRequest("/v1/models", Buffer.from("{}"), "m", { tier: "fast", effort: "low" }),
    ).toBeUndefined();
  });
});
