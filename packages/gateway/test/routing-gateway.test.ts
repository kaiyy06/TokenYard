import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PricingTable } from "../src/pricing.js";
import { startGateway } from "../src/proxy.js";
import { createUsageRecorder } from "../src/recorder.js";
import type { Classification } from "../src/routing/classifier.js";
import { createRouter, type Router, type RouterConfig } from "../src/routing/router.js";
import { createSessionStore } from "../src/routing/session.js";
import { createMemoryStore, type UsageRecord } from "../src/store.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

const pricing = new PricingTable({
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  "claude-sonnet-5-5": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
  "claude-opus-5-5": { input: 5e-6, output: 25e-6, cacheRead: 5e-7, cacheWrite: 6.25e-6 },
});

const config = (mode: RouterConfig["mode"]): RouterConfig => ({
  mode,
  tiers: {
    anthropic: {
      fast: "claude-haiku-4-5",
      standard: "claude-sonnet-5-5",
      frontier: "claude-opus-5-5",
    },
    openai: { fast: "gpt-5-mini", standard: "gpt-5", frontier: "gpt-5-pro" },
  },
});

const toFast: Classification = {
  ok: true,
  latencyMs: 50,
  model: "jev",
  signals: {
    tier: { choice: "fast", confidence: 0.95 },
    effort: { score: 0, confidence: 0.9 },
    taskChanged: 0.95,
  },
};

const REPLY = JSON.stringify({
  id: "m",
  model: "claude-haiku-4-5",
  usage: { input_tokens: 10, output_tokens: 5 },
});

async function setup(router: Router) {
  let seen: { headers: IncomingHttpHeaders; body: Buffer } | undefined;
  const upstream: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    seen = { headers: req.headers, body: Buffer.concat(parts) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(REPLY);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));

  const store = createMemoryStore();
  const record = createUsageRecorder(store, pricing);
  let done: () => void = () => {};
  const exchanged = new Promise<void>((resolve) => {
    done = resolve;
  });
  const gateway = await startGateway({
    port: 0,
    upstreams: { anthropic: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` },
    router,
    routerTimeoutMs: 200,
    onExchange: (e) => {
      record(e);
      done();
    },
  });
  cleanup.push(() => gateway.close());
  return { gateway, seen: () => seen, store, exchanged };
}

function makeRouter(mode: RouterConfig["mode"], classify: () => Promise<Classification>): Router {
  return createRouter({ config: config(mode), sessions: createSessionStore(), pricing, classify });
}

const body = JSON.stringify({
  model: "claude-sonnet-5-5",
  max_tokens: 10,
  output_config: { effort: "high" },
  messages: [{ role: "user", content: "rename foo to bar" }],
});

const post = (url: string, payload: string) =>
  fetch(`${url}/v1/messages`, {
    method: "POST",
    body: payload,
    headers: { "content-type": "application/json" },
  });

describe("gateway with a router", () => {
  it("forwards identical bytes in shadow mode and logs what it would have done", async () => {
    const t = await setup(makeRouter("shadow", async () => toFast));
    const res = await post(t.gateway.url, body);
    expect(await res.text()).toBe(REPLY);
    await t.exchanged;

    expect(t.seen()?.body.toString()).toBe(body);
    const [row] = t.store.list() as UsageRecord[];
    expect(row?.routing).toMatchObject({
      action: "shadow",
      tier: "fast",
      model: "claude-haiku-4-5",
      decided: true,
      deciderMs: 50,
    });
  });

  it("rewrites the model and effort in route mode, with a matching content-length", async () => {
    const t = await setup(makeRouter("route", async () => toFast));
    await (await post(t.gateway.url, body)).text();
    await t.exchanged;

    const sent = t.seen();
    const json = JSON.parse(sent?.body.toString() ?? "{}");
    expect(json.model).toBe("claude-haiku-4-5");
    expect(json.output_config.effort).toBe("low");
    expect(json.messages).toEqual([{ role: "user", content: "rename foo to bar" }]);
    expect(Number(sent?.headers["content-length"])).toBe(sent?.body.length);

    const [row] = t.store.list() as UsageRecord[];
    expect(row?.requestModel).toBe("claude-sonnet-5-5");
    expect(row?.routing?.action).toBe("route");
    // The other option is what the same tokens cost on the model the agent asked for.
    expect(row?.routing?.altCostUsd).toBeCloseTo(10 * 3e-6 + 5 * 15e-6, 10);
  });

  it("forwards the original request when the decider fails", async () => {
    const t = await setup(
      makeRouter("route", async () => ({ ok: false, reason: "timeout: slow", latencyMs: 800 })),
    );
    await (await post(t.gateway.url, body)).text();
    expect(t.seen()?.body.toString()).toBe(body);
  });

  it("forwards the original request when the router hangs", async () => {
    const t = await setup(makeRouter("route", () => new Promise(() => {})));
    const started = Date.now();
    await (await post(t.gateway.url, body)).text();
    expect(t.seen()?.body.toString()).toBe(body);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("forwards the original request when the body is not JSON", async () => {
    const t = await setup(makeRouter("route", async () => toFast));
    await (await post(t.gateway.url, "not json")).text();
    expect(t.seen()?.body.toString()).toBe("not json");
  });

  it("does not hold back requests that are not inference calls", async () => {
    const t = await setup(makeRouter("route", async () => toFast));
    const res = await fetch(`${t.gateway.url}/v1/models`, {
      headers: { "anthropic-version": "2023-06-01" },
    });
    expect(res.status).toBe(200);
    expect(t.seen()?.body.length).toBe(0);
  });
});
