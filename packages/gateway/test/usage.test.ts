import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readRequestInfo, SseParser, type TapResult, UsageTap } from "../src/usage.js";

async function tap(
  provider: "anthropic" | "openai",
  contentType: string,
  chunks: (string | Buffer)[],
  contentEncoding?: string,
): Promise<TapResult> {
  const t = new UsageTap(provider, { contentType, contentEncoding });
  for (const chunk of chunks) t.write(Buffer.from(chunk));
  return t.end();
}

/** Splits text into pieces of `size` bytes, to check parsing across chunk boundaries. */
function slices(text: string, size: number): Buffer[] {
  const bytes = Buffer.from(text);
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"héllo"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

describe("UsageTap", () => {
  it("reads Anthropic usage from a stream, using the final output count", async () => {
    const result = await tap("anthropic", "text/event-stream", [ANTHROPIC_SSE]);
    expect(result).toEqual({
      model: "claude-sonnet-5-5",
      usage: { inputTokens: 12, outputTokens: 57, cacheReadTokens: 4000, cacheWriteTokens: 300 },
    });
  });

  it("gives the same answer however the stream is split into chunks", async () => {
    const whole = await tap("anthropic", "text/event-stream", [ANTHROPIC_SSE]);
    for (const size of [1, 2, 7, 64]) {
      expect(await tap("anthropic", "text/event-stream", slices(ANTHROPIC_SSE, size))).toEqual(
        whole,
      );
    }
  });

  it("handles CRLF line endings", async () => {
    const crlf = ANTHROPIC_SSE.replace(/\n/g, "\r\n");
    expect((await tap("anthropic", "text/event-stream", slices(crlf, 5))).usage?.outputTokens).toBe(
      57,
    );
  });

  it("reads a non-streaming Anthropic response", async () => {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      usage: { input_tokens: 5, output_tokens: 9 },
    });
    expect(await tap("anthropic", "application/json", slices(body, 6))).toEqual({
      model: "claude-haiku-4-5-20251001",
      usage: { inputTokens: 5, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("splits cached tokens out of OpenAI chat completion input", async () => {
    const sse =
      'data: {"model":"gpt-5","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"model":"gpt-5","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":900}}}\n\n' +
      "data: [DONE]\n\n";
    expect(await tap("openai", "text/event-stream", slices(sse, 11))).toEqual({
      model: "gpt-5",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 0 },
    });
  });

  it("reads the Responses API completed event", async () => {
    const sse =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":500,"output_tokens":40,"input_tokens_details":{"cached_tokens":128}}}}\n\n';
    expect(await tap("openai", "text/event-stream", [sse])).toEqual({
      model: "gpt-5-codex",
      usage: { inputTokens: 372, outputTokens: 40, cacheReadTokens: 128, cacheWriteTokens: 0 },
    });
  });

  it("reads a non-streaming Responses API body", async () => {
    const body = JSON.stringify({
      model: "gpt-5",
      usage: { input_tokens: 10, output_tokens: 3, input_tokens_details: { cached_tokens: 0 } },
    });
    expect((await tap("openai", "application/json", [body])).usage).toEqual({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("reports the model but no usage when a stream carries none", async () => {
    const sse =
      'data: {"model":"gpt-5","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    expect(await tap("openai", "text/event-stream", [sse])).toEqual({ model: "gpt-5" });
  });

  it("reads through gzip", async () => {
    const compressed = gzipSync(ANTHROPIC_SSE);
    const chunks: Buffer[] = [];
    for (let i = 0; i < compressed.length; i += 9) chunks.push(compressed.subarray(i, i + 9));
    expect((await tap("anthropic", "text/event-stream", chunks, "gzip")).usage?.outputTokens).toBe(
      57,
    );
  });

  it("gives up quietly on unsupported encodings, garbage and non-JSON bodies", async () => {
    expect(await tap("anthropic", "text/event-stream", [ANTHROPIC_SSE], "zstd")).toEqual({});
    expect(await tap("anthropic", "application/json", ["{not json"])).toEqual({});
    expect(
      await tap("anthropic", "text/event-stream", [Buffer.from([0x1f, 0x8b, 0xff])], "gzip"),
    ).toEqual({});
    expect(await tap("openai", "text/html", ["<html>"])).toEqual({});
    expect(
      await tap("openai", "application/json", [JSON.stringify({ usage: { input_tokens: -1 } })]),
    ).toEqual({});
  });
});

describe("SseParser", () => {
  it("joins multi-line data and ignores comments and other fields", () => {
    const seen: string[] = [];
    const parser = new SseParser((d) => seen.push(d));
    parser.write(Buffer.from(": ping\nevent: x\nid: 1\ndata: a\ndata: b\n\ndata:c\n\n"));
    parser.end();
    expect(seen).toEqual(["a\nb", "c"]);
  });

  it("dispatches a final event that has no trailing blank line", () => {
    const seen: string[] = [];
    const parser = new SseParser((d) => seen.push(d));
    parser.write(Buffer.from("data: last"));
    parser.end();
    expect(seen).toEqual(["last"]);
  });
});

describe("readRequestInfo", () => {
  it("reads the model and stream flag", () => {
    expect(readRequestInfo(Buffer.from('{"model":"m","stream":true,"messages":[]}'))).toEqual({
      model: "m",
      stream: true,
    });
  });

  it("returns nothing for bodies it cannot read", () => {
    expect(readRequestInfo(Buffer.from(""))).toEqual({});
    expect(readRequestInfo(Buffer.from("[1]"))).toEqual({});
    expect(readRequestInfo(Buffer.from('{"model":5}'))).toEqual({});
  });
});
