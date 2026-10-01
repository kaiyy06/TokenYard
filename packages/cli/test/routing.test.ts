import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecideResult, Decider, Questions } from "@tokenyard/decider";
import { openSqliteStore, PricingTable } from "@tokenyard/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { type Deps, type Io, start } from "../src/commands.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function capture(): { io: Io; err: () => string } {
  let err = "";
  return {
    io: {
      out: () => {},
      err: (t) => {
        err += t;
      },
    },
    err: () => err,
  };
}

async function tempHome(config?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenyard-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  if (config !== undefined) await writeFile(join(dir, "config.yaml"), config);
  return dir;
}

const pricing = new PricingTable({
  "claude-haiku-4-5": { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
  "claude-sonnet-5-5": { input: 3e-6, output: 15e-6, cacheRead: 3e-7, cacheWrite: 3.75e-6 },
});

const decision = {
  ok: true,
  decision: {
    model: "fake-jev",
    latencyMs: 12,
    usage: { inputTokens: 100, outputTokens: 0 },
    answers: {
      tier: { type: "choice", choice: "fast", confidence: 0.95, probabilities: {} },
      effort: { type: "score", score: 0, confidence: 0.95, probabilities: {} },
      task_changed: { type: "noul", noul: 0.95 },
    },
  },
};
const fakeDecider = {
  model: "fake-jev",
  decide: async () => decision as unknown as DecideResult<Questions>,
} as unknown as Decider;

const deps = (env: Record<string, string> = { OPENROUTER_API_KEY: "k" }): Deps => ({
  loadPricing: async () => pricing,
  makeDecider: () => fakeDecider,
  env,
});

const REPLY = JSON.stringify({
  model: "claude-sonnet-5-5",
  usage: { input_tokens: 1000, output_tokens: 100 },
});

async function upstream(): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    bodies.push(Buffer.concat(parts).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(REPLY);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const body = JSON.stringify({
  model: "claude-sonnet-5-5",
  messages: [{ role: "user", content: "rename foo to bar" }],
});

async function sendOne(url: string): Promise<void> {
  await (await fetch(`${url}/v1/messages`, { method: "POST", body })).text();
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe("start with routing", () => {
  it("passes traffic through untouched when there is no config file", async () => {
    const up = await upstream();
    const home = await tempHome();
    const running = await start(
      ["--port", "0", "--home", home, "--anthropic-upstream", up.url],
      capture().io,
      deps(),
    );
    cleanup.push(() => running.close());
    await sendOne(running.gateway.url);
    expect(up.bodies).toEqual([body]);
    const db = openSqliteStore(join(home, "usage.db"));
    expect(db.list()[0]?.routing).toBeNull();
    db.close();
  });

  it("logs decisions without changing the request in shadow mode", async () => {
    const up = await upstream();
    const home = await tempHome("mode: shadow\n");
    const out = capture();
    const running = await start(
      ["--port", "0", "--home", home, "--anthropic-upstream", up.url],
      out.io,
      deps(),
    );
    cleanup.push(() => running.close());
    await sendOne(running.gateway.url);
    expect(up.bodies).toEqual([body]);
    expect(out.err()).toContain("shadow mode");

    const db = openSqliteStore(join(home, "usage.db"));
    expect(db.list()[0]?.routing).toMatchObject({
      action: "shadow",
      tier: "fast",
      model: "claude-haiku-4-5",
    });
    db.close();
  });

  it("rewrites the model in route mode, and --mode overrides the file", async () => {
    const up = await upstream();
    const home = await tempHome("mode: shadow\n");
    const running = await start(
      ["--port", "0", "--home", home, "--anthropic-upstream", up.url, "--mode", "route"],
      capture().io,
      deps(),
    );
    cleanup.push(() => running.close());
    await sendOne(running.gateway.url);
    expect(JSON.parse(up.bodies[0] ?? "{}").model).toBe("claude-haiku-4-5");
  });

  it("turns routing off, with a note, when the decider key is missing", async () => {
    const up = await upstream();
    const home = await tempHome("mode: route\n");
    const out = capture();
    const running = await start(
      ["--port", "0", "--home", home, "--anthropic-upstream", up.url],
      out.io,
      deps({}),
    );
    cleanup.push(() => running.close());
    await sendOne(running.gateway.url);
    expect(out.err()).toContain("OPENROUTER_API_KEY is not set");
    expect(up.bodies).toEqual([body]);
  });

  it("refuses to start on a bad config or a bad --mode", async () => {
    const bad = await tempHome("mode: sideways\n");
    await expect(start(["--port", "0", "--home", bad], capture().io, deps())).rejects.toThrow(
      /config\.yaml[\s\S]*mode/,
    );
    const ok = await tempHome();
    await expect(
      start(["--port", "0", "--home", ok, "--mode", "fast"], capture().io, deps()),
    ).rejects.toThrow(/--mode/);
  });
});
