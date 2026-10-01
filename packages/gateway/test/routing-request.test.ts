import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inspectRequest } from "../src/routing/request.js";

const fixture = (name: string): unknown =>
  (
    JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), "utf8")) as {
      request: { path: string; body: { json: unknown } };
    }
  ).request.body.json;

describe("inspectRequest: Anthropic", () => {
  const path = "/v1/messages";

  it("tells a fresh user message from a tool result", () => {
    const fresh = inspectRequest(path, {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "fix the bug" }],
    });
    expect(fresh).toMatchObject({ newUserTurn: true, userTurns: 1, firstUserText: "fix the bug" });

    const continuation = inspectRequest(path, {
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }],
        },
      ],
    });
    expect(continuation).toMatchObject({
      newUserTurn: false,
      userTurns: 1,
      recentTools: ["Read"],
      toolErrors: 1,
      lastUserText: "fix the bug",
    });
  });

  it("ignores injected system reminders and reads the effort and session id", () => {
    const shape = inspectRequest(path, {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "You are an agent" }],
      metadata: { user_id: JSON.stringify({ session_id: "abc-123" }) },
      output_config: { effort: "medium" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>notice</system-reminder>" },
            { type: "text", text: "add a test" },
          ],
        },
      ],
    });
    expect(shape).toMatchObject({
      lastUserText: "add a test",
      systemText: "You are an agent",
      sessionId: "abc-123",
      effort: "medium",
    });
  });

  it("reads the recorded Claude Code requests", () => {
    for (const name of ["0003", "0029"]) {
      const shape = inspectRequest(
        "/v1/messages",
        fixture(`claude-code/session-1/${name}-POST-v1-messages.json`),
      );
      expect(shape?.model).toBe("claude-sonnet-5-5");
      expect(shape?.effort).toBe("medium");
      expect(shape?.userTurns).toBeGreaterThan(0);
    }
  });
});

describe("inspectRequest: OpenAI", () => {
  it("reads a Responses request with a tool output as a continuation", () => {
    const shape = inspectRequest("/v1/responses", {
      model: "gpt-5",
      prompt_cache_key: "sess-1",
      reasoning: { effort: "low" },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
        { type: "function_call", name: "shell", call_id: "c1", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "a b" },
      ],
    });
    expect(shape).toMatchObject({
      api: "openai-responses",
      newUserTurn: false,
      recentTools: ["shell"],
      sessionId: "sess-1",
      effort: "low",
    });
  });

  it("accepts the bare /responses path and a string input", () => {
    expect(inspectRequest("/responses", { model: "gpt-5", input: "hi" })).toMatchObject({
      newUserTurn: true,
      lastUserText: "hi",
    });
  });

  it("reads the recorded Codex requests", () => {
    const shape = inspectRequest("/responses", fixture("codex/session-1/0006-POST-responses.json"));
    expect(shape?.api).toBe("openai-responses");
    expect(shape?.effort).toBe("low");
    expect(shape?.sessionId).toBeTruthy();
  });

  it("reads Chat Completions", () => {
    const shape = inspectRequest("/v1/chat/completions", {
      model: "gpt-5",
      reasoning_effort: "high",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
        { role: "assistant", tool_calls: [{ id: "1", function: { name: "ls", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "x" },
      ],
    });
    expect(shape).toMatchObject({
      systemText: "be brief",
      newUserTurn: false,
      recentTools: ["ls"],
      effort: "high",
    });
  });
});

describe("inspectRequest: unknown", () => {
  it("returns undefined for unknown paths and malformed bodies", () => {
    expect(inspectRequest("/v1/models", {})).toBeUndefined();
    expect(inspectRequest("/v1/messages", "text")).toBeUndefined();
    expect(inspectRequest("/v1/messages", { model: "x" })).toBeUndefined();
    expect(inspectRequest("/v1/chat/completions", { messages: [] })).toBeUndefined();
  });
});
