import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { isInferencePath } from "./recorder.js";
import { rewriteRequest } from "./routing/rewrite.js";
import type { Router, RoutingDecision } from "./routing/router.js";
import { DEFAULT_UPSTREAMS, detectProvider, type Provider, type Upstreams } from "./upstream.js";
import { readRequestInfo, type TapResult, type Usage, UsageTap } from "./usage.js";

/** Request bodies larger than this are forwarded as usual but not inspected or routed. */
const MAX_INSPECTED_REQUEST_BYTES = 16 * 1024 * 1024;

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
  /** Start of the exchange, in epoch milliseconds. */
  readonly startedAt: number;
  /** The model the agent asked for, read from the request body. */
  readonly requestModel?: string;
  /** The model the response says answered. */
  readonly model?: string;
  readonly stream?: boolean;
  /** Token counts read from the response, when it carried any. */
  readonly usage?: Usage;
  /** What the router did with this request, when routing is enabled. */
  readonly routing?: RoutingDecision;
}

export interface GatewayOptions {
  /** Defaults to the public Anthropic and OpenAI APIs. */
  readonly upstreams?: Partial<Upstreams>;
  /** Defaults to 8787. Use 0 for any free port. */
  readonly port?: number;
  /**
   * Address to bind. Defaults to 127.0.0.1, the only safe choice on a normal machine. Set it to
   * 0.0.0.0 only inside a container, and publish the port to the host's loopback.
   */
  readonly host?: string;
  /** Called after every exchange. Errors thrown here are swallowed: observing never breaks traffic. */
  readonly onExchange?: (exchange: Exchange) => void;
  /**
   * When set, inference requests are held briefly so the router can look at them. Without it
   * every request streams straight through untouched.
   */
  readonly router?: Router;
  /** Longest the router may take before the request is forwarded as the agent sent it. Default 2000. */
  readonly routerTimeoutMs?: number;
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

/** Resolves to undefined if the promise does not settle in time. */
async function withTimeout<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a pass-through gateway on 127.0.0.1. Requests are forwarded to the provider they
 * belong to with their headers and body untouched, and responses stream back chunk by chunk
 * without buffering. Nothing is stored, and credentials are only ever passed along.
 */
export async function startGateway(options: GatewayOptions = {}): Promise<Gateway> {
  const upstreams: Upstreams = { ...DEFAULT_UPSTREAMS, ...options.upstreams };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const startedAt = Date.now();
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

    // A copy of the request body, only to read the model and streaming flag from it.
    const requestParts: Buffer[] = [];
    let requestBytes = 0;
    req.on("data", (chunk: Buffer) => {
      requestBytes += chunk.length;
      if (requestBytes <= MAX_INSPECTED_REQUEST_BYTES) requestParts.push(chunk);
    });

    const finish = (error?: string, tapped: TapResult = {}) => {
      if (finished) return;
      finished = true;
      try {
        const info =
          requestBytes <= MAX_INSPECTED_REQUEST_BYTES && !req.headers["content-encoding"]
            ? readRequestInfo(Buffer.concat(requestParts))
            : {};
        const model = tapped.model ?? info.model;
        options.onExchange?.({
          provider,
          method,
          path,
          status,
          firstByteMs,
          totalMs: elapsed(),
          startedAt,
          ...(error !== undefined && { error }),
          ...(info.model !== undefined && { requestModel: info.model }),
          ...(model !== undefined && { model }),
          ...(info.stream !== undefined && { stream: info.stream }),
          ...(tapped.usage && { usage: tapped.usage }),
          ...(routing && { routing }),
        });
        if (routing?.sessionKey && tapped.usage) {
          const u = tapped.usage;
          options.router?.observe(
            routing.sessionKey,
            u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
          );
        }
      } catch {
        // Observers must never affect the request.
      }
    };

    const declaredLength = Number(req.headers["content-length"] ?? 0);
    const routable =
      options.router !== undefined &&
      method === "POST" &&
      isInferencePath(path) &&
      !req.headers["content-encoding"] &&
      // Without a declared length the body could outgrow what is held, so it streams instead.
      req.headers["content-length"] !== undefined &&
      declaredLength <= MAX_INSPECTED_REQUEST_BYTES;
    let routing: RoutingDecision | undefined;

    const forward = (body?: Buffer) => {
      const headers = forwardHeaders(req.headers);
      if (body) headers["content-length"] = body.length;
      const upstreamReq = send(`${target.origin}${basePath}${path}`, { method, headers });

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

        // Successful responses are read for usage as they stream past.
        const tap =
          status >= 200 && status < 300
            ? new UsageTap(provider, {
                contentType: upstreamRes.headers["content-type"],
                contentEncoding: upstreamRes.headers["content-encoding"],
              })
            : undefined;

        upstreamRes.on("data", (chunk: Buffer) => {
          firstByteMs ??= elapsed();
          tap?.write(chunk);
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once("drain", () => upstreamRes.resume());
          }
        });
        upstreamRes.on("end", () => {
          res.end();
          if (tap)
            void tap.end().then(
              (tapped) => finish(undefined, tapped),
              () => finish(),
            );
          else finish();
        });
        upstreamRes.on("error", (err) => {
          res.destroy(err);
          finish(`upstream stream error: ${err.message}`);
        });
      });

      if (body) {
        upstreamReq.end(body);
      } else {
        // The request body streams straight through; it is never held in memory.
        req.pipe(upstreamReq);
      }
      req.on("error", (err) => {
        upstreamReq.destroy();
        finish(`client request error: ${err.message}`);
      });
    };

    if (!routable) {
      forward();
      return;
    }
    // Inference requests wait here until the body has arrived and the router has had its say.
    req.once("end", () => {
      void (async () => {
        const original = Buffer.concat(requestParts);
        let body: Buffer = original;
        try {
          const decision = await withTimeout(
            options.router?.decide(path, JSON.parse(original.toString("utf8"))),
            options.routerTimeoutMs ?? 2000,
          );
          routing = decision;
          if (decision?.action === "route" && decision.model && decision.target) {
            const rewritten = rewriteRequest(path, original, decision.model, decision.target);
            if (rewritten) body = rewritten;
            else
              routing = { ...decision, action: "passthrough", reason: "could not rewrite request" };
          }
        } catch {
          // Fail open: forward exactly what the agent sent.
        }
        forward(body);
      })();
    });
  }

  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve);
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
