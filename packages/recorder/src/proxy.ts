import { mkdir, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  CAPTURE_VERSION,
  type Capture,
  type CapturedChunk,
  type CapturedResponse,
  captureBody,
  redactHeaders,
} from "./capture.js";

export interface RecorderOptions {
  /** Base URL requests are forwarded to, e.g. `https://api.anthropic.com`. A path prefix is kept. */
  readonly upstream: string;
  /** Directory the capture files are written to. Created if missing. */
  readonly outDir: string;
  /** Defaults to 0 (any free port). */
  readonly port?: number;
  /** Called after each capture file is written. */
  readonly onCapture?: (file: string, capture: Capture) => void;
}

export interface Recorder {
  /** Base URL to point the agent at. */
  readonly url: string;
  close(): Promise<void>;
}

/** Hop-by-hop headers describe one connection and are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "host",
]);

function forwardHeaders(headers: IncomingMessage["headers"]): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  }
  return out;
}

function fileName(seq: number, method: string, path: string): string {
  const slug = (path.split("?")[0] ?? "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${String(seq).padStart(4, "0")}-${method}-${slug || "root"}.json`;
}

/**
 * Starts a proxy on 127.0.0.1 that forwards every request to `upstream`, streams the
 * response back chunk by chunk, and writes one capture file per exchange. Credentials are
 * redacted before anything is written. The only change made in transit is asking the
 * upstream for an uncompressed body, so captures stay readable.
 */
export async function startRecorder(options: RecorderOptions): Promise<Recorder> {
  const upstream = new URL(options.upstream);
  const basePath = upstream.pathname.replace(/\/+$/, "");
  const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
  await mkdir(options.outDir, { recursive: true });

  let seq = 0;
  const pending = new Set<Promise<void>>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
    const id = ++seq;
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    const requestChunks: Buffer[] = [];
    for await (const chunk of req) requestChunks.push(chunk as Buffer);
    const requestBody = Buffer.concat(requestChunks);

    const headers = forwardHeaders(req.headers);
    headers["accept-encoding"] = "identity";
    if (requestBody.length > 0 || req.headers["content-length"] !== undefined) {
      headers["content-length"] = String(requestBody.length);
    }

    const responseChunks: Buffer[] = [];
    const chunks: CapturedChunk[] = [];
    let status = 0;
    let responseHeaders: IncomingMessage["headers"] = {};
    let firstByteMs: number | null = null;

    const error = await new Promise<string | undefined>((resolve) => {
      const upstreamReq = send(`${upstream.origin}${basePath}${path}`, { method, headers });

      res.on("close", () => {
        if (!res.writableFinished) {
          upstreamReq.destroy();
          resolve("client closed the connection before the response finished");
        }
      });

      upstreamReq.on("error", (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "recorder_error", message: err.message } }));
        } else {
          res.destroy(err);
        }
        resolve(`upstream error: ${err.message}`);
      });

      upstreamReq.on("response", (upstreamRes) => {
        status = upstreamRes.statusCode ?? 0;
        responseHeaders = upstreamRes.headers;
        res.writeHead(status, forwardHeaders(upstreamRes.headers));
        res.flushHeaders();

        upstreamRes.on("data", (chunk: Buffer) => {
          const at = elapsed();
          firstByteMs ??= at;
          chunks.push({ at, bytes: chunk.length });
          responseChunks.push(chunk);
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once("drain", () => upstreamRes.resume());
          }
        });
        upstreamRes.on("end", () => {
          res.end();
          resolve(undefined);
        });
        upstreamRes.on("error", (err) => {
          res.destroy(err);
          resolve(`upstream stream error: ${err.message}`);
        });
      });

      upstreamReq.end(requestBody);
    });

    const response: CapturedResponse | undefined =
      status === 0
        ? undefined
        : {
            status,
            headers: redactHeaders(responseHeaders),
            body: captureBody(Buffer.concat(responseChunks)),
            chunks,
            firstByteMs,
            totalMs: elapsed(),
          };
    const capture: Capture = {
      version: CAPTURE_VERSION,
      recordedAt: new Date().toISOString(),
      upstream: upstream.href,
      request: {
        method,
        path,
        headers: redactHeaders(req.headers),
        body: captureBody(requestBody),
      },
      ...(response && { response }),
      ...(error !== undefined && { error }),
    };

    const file = join(options.outDir, fileName(id, method, path));
    await writeFile(file, `${JSON.stringify(capture, null, 2)}\n`);
    options.onCapture?.(file, capture);
  }

  const server = createServer((req, res) => {
    const task = handle(req, res)
      .catch((err: unknown) => {
        console.error("recorder: failed to record exchange:", err);
        if (!res.headersSent) res.writeHead(500).end();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(pending);
    },
  };
}
