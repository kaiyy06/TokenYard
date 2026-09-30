import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { DEFAULT_UPSTREAMS, detectProvider, type Provider, type Upstreams } from "./upstream.js";

/** What the gateway saw for one request, handed to `onExchange` once it has finished. */
export interface Exchange {
  readonly provider: Provider;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Time until the first response byte, or null if none arrived. */
  readonly firstByteMs: number | null;
  readonly totalMs: number;
  /** The error that ended the exchange early, if any. */
  readonly error?: string;
}

export interface GatewayOptions {
  /** Defaults to the public Anthropic and OpenAI APIs. */
  readonly upstreams?: Partial<Upstreams>;
  /** Defaults to 8787. Use 0 for any free port. */
  readonly port?: number;
  /** Called after every exchange. Errors thrown here are swallowed: observing never breaks traffic. */
  readonly onExchange?: (exchange: Exchange) => void;
}

export interface Gateway {
  /** Base URL to point an agent at. */
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

/**
 * Starts a pass-through gateway on 127.0.0.1. Requests are forwarded to the provider they
 * belong to with their headers and body untouched, and responses stream back chunk by chunk
 * without buffering. Nothing is stored, and credentials are only ever passed along.
 */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const upstreams: Upstreams = { ...DEFAULT_UPSTREAMS, ...options.upstreams };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const started = performance.now();
    const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const provider = detectProvider(path, req.headers);

    const target = new URL(upstreams[provider]);
    const basePath = target.pathname.replace(/\/+$/, "");
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    let status = 0;
    let firstByteMs: number | null = null;
    let finished = false;
    const finish = (error?: string) => {
      if (finished) return;
      finished = true;
      try {
        options.onExchange?.({
          provider,
          method,
          path,
          status,
          firstByteMs,
          totalMs: elapsed(),
          ...(error !== undefined && { error }),
        });
      } catch {
        // Observers must never affect the request.
      }
    };

    const upstreamReq = send(`${target.origin}${basePath}${path}`, {
      method,
      headers: forwardHeaders(req.headers),
    });

    // If the agent goes away mid-response, stop the upstream call too.
    res.on("close", () => {
      if (!res.writableFinished) {
        upstreamReq.destroy();
        finish("client closed the connection before the response finished");
      }
    });

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "gateway_error", message: err.message } }));
      } else {
        res.destroy(err);
      }
      finish(`upstream error: ${err.message}`);
    });

    upstreamReq.on("response", (upstreamRes) => {
      status = upstreamRes.statusCode ?? 0;
      res.writeHead(status, upstreamRes.statusMessage, forwardHeaders(upstreamRes.headers));
      res.flushHeaders();

      upstreamRes.on("data", (chunk: Buffer) => {
        firstByteMs ??= elapsed();
        if (!res.write(chunk)) {
          upstreamRes.pause();
          res.once("drain", () => upstreamRes.resume());
        }
      });
      upstreamRes.on("end", () => {
        res.end();
        finish();
      });
      upstreamRes.on("error", (err) => {
        res.destroy(err);
        finish(`upstream stream error: ${err.message}`);
      });
    });

    // The request body streams straight through; it is never held in memory.
    req.pipe(upstreamReq);
    req.on("error", (err) => {
      upstreamReq.destroy();
      finish(`client request error: ${err.message}`);
    });
  }

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
