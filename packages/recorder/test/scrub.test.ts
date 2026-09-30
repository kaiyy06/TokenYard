import { describe, expect, it } from "vitest";
import { type Capture, captureBody } from "../src/capture.js";
import { createPseudonymizer, scrubCapture } from "../src/scrub.js";

const SECRET_WORDS = ["hunter2", "PROJECT-ORCHID", "rm -rf", "C:/Users/alice", "sig-abc"];

const request = {
  model: "claude-opus-5-5",
  max_tokens: 32000,
  stream: true,
  metadata: { user_id: "user_4f9ab0c1d2e3_account_7c1e2f3a-0000-4000-8000-123456789abc" },
  system: [
    {
      type: "text",
      text: "You work in C:/Users/alice on PROJECT-ORCHID",
      cache_control: { type: "ephemeral" },
    },
  ],
  thinking: { type: "enabled", budget_tokens: 8000 },
  tools: [
    {
      name: "Bash",
      description: "Runs a command",
      input_schema: {
        type: "object",
        properties: { command: { type: "string", description: "x" } },
      },
    },
  ],
  messages: [
    { role: "user", content: "the password is hunter2" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "maybe rm -rf", signature: "sig-abc" },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "Bash",
          input: { command: "rm -rf build", name: "PROJECT-ORCHID" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01", content: "deleted C:/Users/alice/build" },
      ],
    },
  ],
};

const sse = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-opus-5-5","role":"assistant","usage":{"input_tokens":12,"cache_read_input_tokens":3000}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hunter2 is weak"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"rm -rf"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
];

function capture(): Capture {
  const body = sse.join("");
  return {
    version: 1,
    recordedAt: "2026-09-29T12:00:00.000Z",
    upstream: "https://api.anthropic.com/",
    request: {
      method: "POST",
      path: "/v1/messages?beta=true",
      headers: {
        "x-api-key": "sk-ant-api03-[redacted]",
        "user-agent": "claude-cli/2.1.284 (external, cli)",
        "x-claude-code-session-id": "7c1e2f3a-0000-4000-8000-123456789abc",
        "x-custom": "PROJECT-ORCHID",
      },
      body: captureBody(Buffer.from(JSON.stringify(request))),
    },
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream", "anthropic-organization-id": "org-abc123" },
      body: captureBody(Buffer.from(body)),
      chunks: [
        { at: 100, bytes: Buffer.byteLength(sse[0] as string) + 5 },
        { at: 250, bytes: Buffer.byteLength(body) - Buffer.byteLength(sse[0] as string) - 5 },
      ],
      firstByteMs: 100,
      totalMs: 260,
    },
  };
}

describe("scrubCapture", () => {
  const fixture = scrubCapture(capture(), createPseudonymizer(Buffer.from("fixed-salt")));
  const serialized = JSON.stringify(fixture);

  it("removes every piece of prompt content", () => {
    for (const word of SECRET_WORDS) expect(serialized).not.toContain(word);
  });

  it("keeps the structure the gateway needs", () => {
    const body = fixture.request.body;
    if (body.kind !== "json") throw new Error(`expected json, got ${body.kind}`);
    const json = body.json as typeof request;
    expect(json.model).toBe("claude-opus-5-5");
    expect(json.max_tokens).toBe(32000);
    expect(json.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(json.system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(json.system[0]?.text).toBe("[scrubbed 44 chars]");
    expect(json.tools[0]?.name).toBe("Bash");
    expect(json.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "[scrubbed 12 chars]", signature: "[scrubbed 7 chars]" },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "Bash",
        input: { command: "[scrubbed 12 chars]", name: "[scrubbed 14 chars]" },
      },
    ]);
    expect(fixture.request.headers["user-agent"]).toBe("claude-cli/2.1.284 (external, cli)");
    expect(fixture.request.headers["x-api-key"]).toBe("sk-ant-api03-[redacted]");
  });

  it("pseudonymizes identifying ids consistently and in the same format", () => {
    const json = (fixture.request.body as { json: typeof request }).json;
    const userId = json.metadata.user_id;
    expect(userId).toMatch(/^user_[0-9a-f]{12}_account_[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(userId).not.toContain("4f9ab0c1d2e3");
    // The account uuid and the session header share a value, so they share a pseudonym.
    const sessionHeader = fixture.request.headers["x-claude-code-session-id"] as string;
    expect(userId.endsWith(sessionHeader)).toBe(true);
    expect(fixture.response?.headers["anthropic-organization-id"]).not.toBe("org-abc123");
  });

  it("hides account usage headers and connected service names", () => {
    const base = capture();
    const tools = [{ name: "Bash" }, { name: "mcp__claude_ai_Asana__get_task" }];
    const c: Capture = {
      ...base,
      request: {
        ...base.request,
        body: captureBody(Buffer.from(JSON.stringify({ ...request, tools }))),
      },
      response: {
        ...(base.response as NonNullable<Capture["response"]>),
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": "0.57",
          "anthropic-ratelimit-requests-limit": "1000",
        },
      },
    };
    const out = scrubCapture(c, createPseudonymizer(Buffer.from("fixed-salt")));
    expect(out.response?.headers["anthropic-ratelimit-unified-5h-utilization"]).not.toBe("0.57");
    expect(out.response?.headers["anthropic-ratelimit-requests-limit"]).toBe("1000");
    const json = (out.request.body as { json: { tools: { name: string }[] } }).json;
    expect(json.tools[0]?.name).toBe("Bash");
    expect(json.tools[1]?.name).toMatch(/^mcp__[a-z]+_[a-z]+_[A-Za-z]+__[a-z]+_[a-z]+$/);
    expect(JSON.stringify(out)).not.toContain("Asana");
  });

  it("splits the event stream and times each event by its chunk", () => {
    const body = fixture.response?.body;
    if (body?.kind !== "sse") throw new Error("expected sse");
    expect(body.events.map((e) => [e.event, e.at])).toEqual([
      ["message_start", 100],
      ["content_block_delta", 250],
      ["content_block_delta", 250],
      ["message_delta", 250],
    ]);
    expect(body.events[0]?.data).toMatchObject({
      message: { id: "msg_01", usage: { input_tokens: 12, cache_read_input_tokens: 3000 } },
    });
    expect(body.events[3]?.data).toMatchObject({ delta: { stop_reason: "tool_use" } });
  });

  it("redacts credentials even if the capture still holds them", () => {
    const leaky = capture();
    const headers = {
      ...leaky.request.headers,
      authorization: "Bearer sk-ant-oat01-abcdefghijklmnopqrstuvwxyz",
    };
    const scrubbedFixture = scrubCapture(
      { ...leaky, request: { ...leaky.request, headers } },
      createPseudonymizer(),
    );
    expect(scrubbedFixture.request.headers.authorization).toBe("Bearer sk-ant-oat01-[redacted]");
  });

  it("refuses to produce a fixture that still holds a credential", () => {
    const leaky = capture();
    const body = captureBody(
      Buffer.from(JSON.stringify({ ...request, model: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })),
    );
    expect(() =>
      scrubCapture({ ...leaky, request: { ...leaky.request, body } }, createPseudonymizer()),
    ).toThrow(/credential/);
  });
});
