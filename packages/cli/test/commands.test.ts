import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PricingTable } from "@tokenyard/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { type Deps, HELP, type Io, start, stats } from "../src/commands.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenyard-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const deps: Deps = {
  loadPricing: async () =>
    new PricingTable({
      "claude-sonnet-5-5": { input: 2e-6, output: 1e-5, cacheRead: 2e-7, cacheWrite: 2.5e-6 },
    }),
};

const SSE =
  'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":1000,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":200}}\n\n';

describe("help", () => {
  it("documents both commands", () => {
    expect(HELP).toContain("tokenyard start");
    expect(HELP).toContain("tokenyard stats");
  });
});

describe("start and stats", () => {
  async function runTraffic(home: string) {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const started = capture();
    const running = await start(
      ["--port", "0", "--home", home, "--anthropic-upstream", upstreamUrl],
      started.io,
      deps,
    );
    cleanup.push(() => running.close());
    expect(started.out()).toContain(`ANTHROPIC_BASE_URL=${running.gateway.url}`);

    const res = await fetch(`${running.gateway.url}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true }),
    });
    expect(await res.text()).toBe(SSE);
    // The record is written when the exchange finishes, just after the last byte.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await running.close();
    cleanup.pop();
  }

  it("records traffic and reports it", async () => {
    const home = await tempHome();
    await runTraffic(home);

    const text = capture();
    stats(["--home", home], text.io);
    expect(text.out()).toContain("Requests   1");
    expect(text.out()).toContain("claude-sonnet-5-5");
    expect(text.out()).toContain("$0.0040"); // 1000 * 2e-6 + 200 * 1e-5

    const json = capture();
    stats(["--home", home, "--json"], json.io);
    expect(JSON.parse(json.out()).totals.outputTokens).toBe(200);

    const csv = capture();
    stats(["--home", home, "--export", "csv"], csv.io);
    expect(csv.out().split("\n")).toHaveLength(3); // header, one row, trailing newline

    const jsonl = capture();
    stats(["--home", home, "--export", "jsonl", "--since", "all"], jsonl.io);
    expect(JSON.parse(jsonl.out()).model).toBe("claude-sonnet-5-5");
  });

  it("says so when nothing has been recorded", async () => {
    const text = capture();
    stats(["--home", await tempHome(), "--since", "7d"], text.io);
    expect(text.out()).toContain("No requests recorded in the last 7d.");
  });

  it("rejects bad options", async () => {
    const home = await tempHome();
    const { io } = capture();
    expect(() => stats(["--home", home, "--since", "soon"], io)).toThrow(/invalid duration/);
    expect(() => stats(["--home", home, "--export", "xml"], io)).toThrow(/invalid --export/);
    expect(() => stats(["--nope"], io)).toThrow();
    await expect(start(["--port", "99999", "--home", home], io, deps)).rejects.toThrow(
      /invalid port/,
    );
  });

  it("warns when no prices are available", async () => {
    const home = await tempHome();
    const out = capture();
    const running = await start(["--port", "0", "--home", home], out.io, {
      loadPricing: async () => new PricingTable(),
    });
    await running.close();
    expect(out.err()).toContain("no model prices available");
  });
});
