import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Capture } from "../src/capture.js";
import { type Recorder, startRecorder } from "../src/proxy.js";

const SSE_CHUNKS = [
  'event: message_start\ndata: {"type":"message_start"}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hé',
  'llo"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
];

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

interface Upstream {
  url: string;
  seen: { url: string | undefined; headers: IncomingMessage["headers"]; body: string }[];
  /** Resolves the gate that holds back the last chunk. */
  release: () => void;
}

async function startUpstream(): Promise<Upstream> {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: Upstream["seen"] = [];
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_123" });
    const bytes = Buffer.from(SSE_CHUNKS.join(""));
    // Split inside the multi-byte "é" to check that raw bytes pass through untouched.
    const split = Buffer.from(SSE_CHUNKS[0] as string).length + 70;
    res.write(bytes.subarray(0, split));
    await gate;
    res.end(bytes.subarray(split));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api`, seen, release };
}

async function setup(): Promise<{ upstream: Upstream; recorder: Recorder; outDir: string }> {
  const upstream = await startUpstream();
  const outDir = await mkdtemp(join(tmpdir(), "recorder-"));
  const recorder = await startRecorder({ upstream: upstream.url, outDir });
  cleanup.push(async () => {
    await recorder.close();
    await rm(outDir, { recursive: true, force: true });
  });
  return { upstream, recorder, outDir };
}

describe("startRecorder", () => {
  it("streams the response through unchanged and records the exchange", async () => {
    const { upstream, recorder, outDir } = await setup();
    const requestBody = JSON.stringify({ model: "claude-sonnet-5", stream: true });

    const response = await fetch(`${recorder.url}/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-ant-api03-secretsecretsecretsecret",
        "accept-encoding": "gzip, br",
      },
      body: requestBody,
    });
    expect(response.status).toBe(200);

    // The first chunk arrives while the upstream is still holding back the rest.
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    upstream.release();
    const parts = [Buffer.from(first.value as Uint8Array)];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    expect(Buffer.concat(parts).toString()).toBe(SSE_CHUNKS.join(""));

    const [forwarded] = upstream.seen;
    expect(forwarded?.url).toBe("/api/v1/messages?beta=true");
    expect(forwarded?.body).toBe(requestBody);
    expect(forwarded?.headers["x-api-key"]).toBe("sk-ant-api03-secretsecretsecretsecret");
    expect(forwarded?.headers["accept-encoding"]).toBe("identity");

    await recorder.close();
    const files = await readdir(outDir);
    expect(files).toEqual(["0001-POST-v1-messages.json"]);
    const raw = await readFile(join(outDir, files[0] as string), "utf8");
    expect(raw).not.toContain("secretsecret");

    const capture = JSON.parse(raw) as Capture;
    expect(capture.request.path).toBe("/v1/messages?beta=true");
    expect(capture.request.headers["x-api-key"]).toBe("sk-ant-api03-[redacted]");
    expect(capture.request.headers["accept-encoding"]).toBe("gzip, br");
    expect(capture.request.body.data).toBe(requestBody);
    expect(capture.response?.status).toBe(200);
    expect(capture.response?.body.data).toBe(SSE_CHUNKS.join(""));
    expect(capture.response?.chunks.length).toBeGreaterThanOrEqual(2);
    expect(capture.response?.firstByteMs).not.toBeNull();
  });

  it("answers 502 and records the error when the upstream is unreachable", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "recorder-"));
    const recorder = await startRecorder({ upstream: "http://127.0.0.1:1", outDir });
    cleanup.push(async () => {
      await recorder.close();
      await rm(outDir, { recursive: true, force: true });
    });

    const response = await fetch(`${recorder.url}/v1/models`);
    expect(response.status).toBe(502);
    await response.text();

    await recorder.close();
    const [file] = await readdir(outDir);
    const capture = JSON.parse(await readFile(join(outDir, file as string), "utf8")) as Capture;
    expect(capture.response).toBeUndefined();
    expect(capture.error).toMatch(/^upstream error/);
  });
});
