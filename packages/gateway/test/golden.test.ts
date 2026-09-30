import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryStore,
  createUsageRecorder,
  PricingTable,
  startGateway,
  type UsageRecord,
} from "../src/index.js";

/** The subset of the recorder's fixture format this test reads. */
type Body =
  | { kind: "empty" }
  | { kind: "json"; json: unknown }
  | { kind: "sse"; events: { event?: string; data: unknown }[] }
  | { kind: "opaque"; bytes: number };

interface Fixture {
  request: { method: string; path: string; headers: Record<string, string | string[]>; body: Body };
  response?: { status: number; headers: Record<string, string | string[]>; body: Body };
}

interface Expected {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures");

function findFixtures(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return findFixtures(path);
    return name.endsWith(".json") && name !== "expected.json" ? [path] : [];
  });
}

/** Bytes a body had on the wire. Scrubbing re-serializes JSON, so this is the canonical form. */
function bodyBytes(body: Body): Buffer | undefined {
  switch (body.kind) {
    case "empty":
      return Buffer.alloc(0);
    case "json":
      return Buffer.from(JSON.stringify(body.json));
    case "sse":
      return Buffer.from(
        body.events
          .map((e) => {
            const data = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
            return `${e.event ? `event: ${e.event}\n` : ""}data: ${data}\n\n`;
          })
          .join(""),
      );
    case "opaque":
      return undefined;
  }
}

/** Headers that describe one connection or a body encoding rather than the exchange itself. */
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "keep-alive",
  "accept-encoding",
]);

function usable(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !SKIP_HEADERS.has(k)));
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

const files = findFixtures(FIXTURES);

describe("golden fixtures", () => {
  it("finds fixtures to replay", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const name = relative(FIXTURES, file);
    const fixture = JSON.parse(readFileSync(file, "utf8")) as Fixture;
    const requestBody = bodyBytes(fixture.request.body);
    const responseBody = fixture.response ? bodyBytes(fixture.response.body) : undefined;
    if (!fixture.response || !requestBody || !responseBody) continue;
    const response = fixture.response;

    it(`passes ${name} through unchanged and records its usage`, async () => {
      let seen: { headers: IncomingHttpHeaders; body: Buffer } | undefined;
      const upstream: Server = createServer(async (req, res) => {
        const parts: Buffer[] = [];
        for await (const chunk of req) parts.push(chunk as Buffer);
        seen = { headers: req.headers, body: Buffer.concat(parts) };
        res.writeHead(response.status, usable(response.headers));
        // One event per write, as an upstream would stream it.
        if (response.body.kind === "sse") {
          for (const event of response.body.events) {
            res.write(bodyBytes({ kind: "sse", events: [event] }) as Buffer);
          }
          res.end();
        } else {
          res.end(responseBody);
        }
      });
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
      cleanup.push(() => new Promise((resolve) => upstream.close(() => resolve())));
      const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

      const store = createMemoryStore();
      const record = createUsageRecorder(store, new PricingTable());
      let done: () => void = () => {};
      const exchanged = new Promise<void>((resolve) => {
        done = resolve;
      });
      const gateway = await startGateway({
        port: 0,
        upstreams: { anthropic: upstreamUrl, openai: upstreamUrl },
        onExchange: (e) => {
          record(e);
          done();
        },
      });
      cleanup.push(() => gateway.close());

      const sent = usable(fixture.request.headers);
      const res = await fetch(`${gateway.url}${fixture.request.path}`, {
        method: fixture.request.method,
        headers: sent as Record<string, string>,
        body: requestBody,
      });
      const received = Buffer.from(await res.arrayBuffer());
      await exchanged;

      expect(res.status).toBe(response.status);
      expect(received.equals(responseBody)).toBe(true);
      expect(seen?.body.equals(requestBody)).toBe(true);
      for (const [key, value] of Object.entries(sent)) {
        expect(seen?.headers[key.toLowerCase()]).toEqual(value);
      }

      const expectedFile = join(dirname(file), "expected.json");
      let expected: Expected | undefined;
      try {
        expected = (JSON.parse(readFileSync(expectedFile, "utf8")) as Record<string, Expected>)[
          file.slice(dirname(file).length + 1)
        ];
      } catch {
        // No expectations for this directory: byte identity is all that is checked.
      }
      if (expected) {
        const recorded = store.list()[0] as UsageRecord;
        expect(recorded.model).toBe(expected.model);
        expect(recorded.inputTokens).toBe(expected.inputTokens);
        expect(recorded.outputTokens).toBe(expected.outputTokens);
        expect(recorded.cacheReadTokens).toBe(expected.cacheReadTokens);
        expect(recorded.cacheWriteTokens).toBe(expected.cacheWriteTokens);
      }
    });
  }
});
