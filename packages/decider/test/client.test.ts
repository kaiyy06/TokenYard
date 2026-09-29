import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDecider, type Questions } from "../src/index.js";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

interface Recorded {
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: unknown;
}

const servers: Server[] = [];

async function serve(handler: Handler): Promise<{ baseURL: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

const questions = {
  newTask: { type: "noul", instructions: "Is this a new task?" },
  tier: { type: "choice", criteria: { fast: "Trivial", frontier: "Hard" } },
} as const satisfies Questions;

const answers = {
  newTask: { type: "noul", noul: 0.2 },
  tier: {
    type: "choice",
    choice: "fast",
    confidence: 0.8,
    probabilities: { fast: 0.9, frontier: 0.1 },
  },
};

describe("createDecider", () => {
  it("posts the request to {baseURL}/systemone and returns typed answers", async () => {
    const { baseURL, requests } = await serve((_req, _body, res) =>
      json(res, 200, { model: "jev-1.13", answers, usage: { input_tokens: 40, output_tokens: 4 } }),
    );
    const decider = createDecider({ baseURL: `${baseURL}/`, model: "jev-1.13", apiKey: "sk-test" });

    const result = await decider.decide({ state: "rename a variable", questions });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.answers.tier.choice).toBe("fast");
    expect(result.decision.answers.newTask.noul).toBe(0.2);
    expect(result.decision.usage).toEqual({ inputTokens: 40, outputTokens: 4 });
    expect(result.decision.latencyMs).toBeGreaterThanOrEqual(0);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/v1/systemone");
    expect(requests[0]?.headers.authorization).toBe("Bearer sk-test");
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.body).toEqual({ model: "jev-1.13", state: "rename a variable", questions });
  });

  it("uses a per-call model and sends no auth header without a key", async () => {
    const { baseURL, requests } = await serve((_req, _body, res) =>
      json(res, 200, { model: "kev-4b", answers }),
    );
    const decider = createDecider({ baseURL, model: "kev-latest" });

    await decider.decide({ state: "x", questions, model: "kev-4b" });

    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({ model: "kev-4b" });
  });

  it("rejects an invalid request without calling the provider", async () => {
    const { baseURL, requests } = await serve((_req, _body, res) => json(res, 200, {}));
    const decider = createDecider({ baseURL, model: "m" });

    const result = await decider.decide({ state: "x", questions: {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("invalid_request");
    expect(requests).toHaveLength(0);
  });

  it("reports HTTP errors with the status and a truncated body", async () => {
    const { baseURL } = await serve((_req, _body, res) => {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end(`rate limited ${"x".repeat(1000)}`);
    });
    const decider = createDecider({ baseURL, model: "m" });

    const result = await decider.decide({ state: "x", questions });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("http");
    expect(result.error.status).toBe(429);
    expect(result.error.message).toMatch(/^decider returned HTTP 429: rate limited/);
    expect(result.error.message.length).toBeLessThan(400);
  });

  it("reports a non-JSON success body as an invalid response", async () => {
    const { baseURL } = await serve((_req, _body, res) => {
      res.writeHead(200);
      res.end("<html>oops</html>");
    });
    const result = await createDecider({ baseURL, model: "m" }).decide({ state: "x", questions });

    expect(!result.ok && result.error.kind).toBe("invalid_response");
  });

  it("reports answers that do not match the questions as an invalid response", async () => {
    const { baseURL } = await serve((_req, _body, res) =>
      json(res, 200, { model: "m", answers: { newTask: answers.newTask } }),
    );
    const result = await createDecider({ baseURL, model: "m" }).decide({ state: "x", questions });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("invalid_response");
      expect(result.error.message).toMatch(/"tier" is missing/);
    }
  });

  it("times out within the budget when the provider is slow", async () => {
    const { baseURL } = await serve(() => {
      // Never respond.
    });
    const decider = createDecider({ baseURL, model: "m", timeoutMs: 5000 });

    const result = await decider.decide({ state: "x", questions }, { timeoutMs: 50 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    expect(result.error.latencyMs).toBeGreaterThanOrEqual(40);
    expect(result.error.latencyMs).toBeLessThan(1000);
  });

  it("reports a caller abort distinctly from a timeout", async () => {
    const { baseURL } = await serve(() => {
      // Never respond.
    });
    const controller = new AbortController();
    const pending = createDecider({ baseURL, model: "m" }).decide(
      { state: "x", questions },
      { signal: controller.signal },
    );
    controller.abort();

    const result = await pending;
    expect(!result.ok && result.error.kind).toBe("aborted");
  });

  it("reports a refused connection as a network error", async () => {
    const { baseURL } = await serve(() => {});
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );

    const result = await createDecider({ baseURL, model: "m" }).decide({ state: "x", questions });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("network");
      expect(result.error.message).toMatch(/ECONNREFUSED/);
    }
  });
});
