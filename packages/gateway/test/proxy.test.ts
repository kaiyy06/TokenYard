import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Exchange, startGateway } from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

interface Seen {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface Upstream {
  url: string;
  seen: Seen[];
  /** Releases the last chunk of a streamed response. */
  release: () => void;
}

/** A fake provider that streams a response in two chunks, split inside a multi-byte character. */
async function startUpstream(): Promise<Upstream> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: Seen[] = [];
  const server: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_123" });
    const bytes = Buffer.from('data: {"text":"héllo"}\n\ndata: [DONE]\n\n');
    res.write(bytes.subarray(0, 14));
    await gate;
    res.end(bytes.subarray(14));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/base`, seen, release };
}

async function setup(onExchange?: (e: Exchange) => void) {
  const anthropic = await startUpstream();
  const openai = await startUpstream();
  const gateway = await startGateway({
    port: 0,
    upstreams: { anthropic: anthropic.url, openai: openai.url },
    ...(onExchange && { onExchange }),
  });
  cleanup.push(() => gateway.close());
  return { anthropic, openai, gateway };
}

describe("gateway pass-through", () => {
  it("forwards the request body and headers untouched", async () => {
    const { anthropic, gateway } = await setup();
    anthropic.release();
    const body = Buffer.from('{"model":"claude-x","weird":"  spacing \\u00e9 "}');

    const res = await fetch(`${gateway.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": "sk-test", "anthropic-version": "2023-06-01" },
      body,
    });
    await res.arrayBuffer();

    const seen = anthropic.seen[0];
    expect(seen?.url).toBe("/base/v1/messages?beta=true");
    expect(seen?.body.equals(body)).toBe(true);
    expect(seen?.headers["x-api-key"]).toBe("sk-test");
    expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("returns response bytes and headers unchanged", async () => {
    const { anthropic, gateway } = await setup();
    anthropic.release();
    const res = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.headers.get("request-id")).toBe("req_123");
    expect(await res.text()).toBe('data: {"text":"héllo"}\n\ndata: [DONE]\n\n');
  });

  it("streams chunks as they arrive instead of buffering", async () => {
    const { openai, gateway } = await setup();
    const res = await fetch(`${gateway.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    // The upstream is still holding back its last chunk; the first one must already be here.
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: {"text":');

    openai.release();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('"héllo"}\n\ndata: [DONE]\n\n');
  });

  it("routes each request to its own provider", async () => {
    const { anthropic, openai, gateway } = await setup();
    anthropic.release();
    openai.release();

    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      await (await fetch(`${gateway.url}${path}`, { method: "POST", body: "{}" })).text();
    }
    for (const path of ["/v1/chat/completions", "/v1/responses"]) {
      await (await fetch(`${gateway.url}${path}`, { method: "POST", body: "{}" })).text();
    }
    // Shared path: the credential header picks the provider.
    await (await fetch(`${gateway.url}/v1/models`, { headers: { "x-api-key": "k" } })).text();
    await (
      await fetch(`${gateway.url}/v1/models`, { headers: { authorization: "Bearer k" } })
    ).text();

    expect(anthropic.seen.map((s) => s.url)).toEqual([
      "/base/v1/messages",
      "/base/v1/messages/count_tokens",
      "/base/v1/models",
    ]);
    expect(openai.seen.map((s) => s.url)).toEqual([
      "/base/v1/chat/completions",
      "/base/v1/responses",
      "/base/v1/models",
    ]);
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const gateway = await startGateway({
      port: 0,
      upstreams: { anthropic: "http://127.0.0.1:1" },
    });
    cleanup.push(() => gateway.close());
    const res = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("gateway_error");
  });

  it("reports each exchange, and a throwing observer does not break the request", async () => {
    const exchanges: Exchange[] = [];
    const { anthropic, gateway } = await setup((e) => {
      exchanges.push(e);
      throw new Error("observer bug");
    });
    anthropic.release();

    const res = await fetch(`${gateway.url}/v1/messages`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    await res.text();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ provider: "anthropic", method: "POST", status: 200 });
    expect(exchanges[0]?.firstByteMs).not.toBeNull();
  });

  it("binds to loopback only", async () => {
    const { gateway } = await setup();
    expect(gateway.url.startsWith("http://127.0.0.1:")).toBe(true);
  });
});
