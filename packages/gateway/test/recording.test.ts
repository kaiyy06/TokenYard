import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryStore,
  createUsageRecorder,
  PricingTable,
  startGateway,
  type UsageRecord,
} from "../src/index.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":100,"cache_read_input_tokens":900,"cache_creation_input_tokens":0,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n';

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(respond: Parameters<typeof createServer>[1]) {
  const anthropic = await serve(respond);
  const store = createMemoryStore();
  const pricing = new PricingTable({
    "claude-sonnet-5-5": { input: 2e-6, output: 1e-5, cacheRead: 2e-7, cacheWrite: 2.5e-6 },
  });
  const record = createUsageRecorder(store, pricing);
  let notify: (record: UsageRecord) => void = () => {};
  const recorded = new Promise<UsageRecord>((resolve) => {
    notify = resolve;
  });
  const gateway = await startGateway({
    port: 0,
    upstreams: { anthropic },
    onExchange: (e) => {
      record(e);
      const first = store.list()[0];
      if (first) notify(first);
    },
  });
  cleanup.push(() => gateway.close());
  return { url: gateway.url, recorded, store };
}

describe("usage recording", () => {
  it("records tokens, model and cost for a streamed response without changing it", async () => {
    const { url, recorded } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
    const res = await fetch(`${url}/v1/messages?beta=true`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
    });
    expect(await res.text()).toBe(SSE);

    const record = await recorded;
    expect(record).toMatchObject({
      provider: "anthropic",
      path: "/v1/messages",
      status: 200,
      model: "claude-sonnet-5-5",
      requestModel: "claude-sonnet-5",
      stream: true,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      error: null,
    });
    expect(record.costUsd).toBeCloseTo(100 * 2e-6 + 40 * 1e-5 + 900 * 2e-7, 10);
    expect(record.firstByteMs).not.toBeNull();
  });

  it("reads usage from a gzip-compressed response and still forwards the compressed bytes", async () => {
    const compressed = gzipSync(SSE);
    const { url, recorded } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" });
      res.end(compressed);
    });
    // `fetch` would decompress the body, so read the raw bytes with node:http.
    const raw = await new Promise<Buffer>((resolve, reject) => {
      const req = request(`${url}/v1/messages`, { method: "POST" }, (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk: Buffer) => parts.push(chunk));
        res.on("end", () => resolve(Buffer.concat(parts)));
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(raw.equals(compressed)).toBe(true);
    expect((await recorded).outputTokens).toBe(40);
  });

  it("records failed requests without usage", async () => {
    const { url, recorded } = await setup((_req, res) => {
      res.writeHead(529, { "content-type": "application/json" });
      res.end('{"type":"error","error":{"type":"overloaded_error"}}');
    });
    const res = await fetch(`${url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5-5" }),
    });
    expect(res.status).toBe(529);
    await res.text();
    expect(await recorded).toMatchObject({
      status: 529,
      model: "claude-sonnet-5-5",
      inputTokens: null,
      costUsd: null,
    });
  });

  it("does not record requests that are not inference", async () => {
    const { url, store } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"input_tokens":12}');
    });
    await (await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", body: "{}" })).text();
    await (await fetch(`${url}/v1/models`)).text();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.list()).toEqual([]);
  });
});
