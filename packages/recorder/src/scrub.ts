import { createHmac, randomBytes } from "node:crypto";
import { bodyText, type Capture, type HeaderMap, REDACTED, redactHeaders } from "./capture.js";

/**
 * Scrubbing works from allowlists and fails closed: a string survives only when its key is
 * known to hold protocol structure (types, roles, model and tool names, ids, stop reasons).
 * Everything else, including every prompt, tool input, tool result, thinking block and
 * signature, is replaced with a length marker. Identifying ids are pseudonymized consistently,
 * so requests from one session still link up.
 */

export const FIXTURE_VERSION = 1;

/** Keys whose string values are protocol structure, not content. */
const KEEP_KEYS = new Set([
  "type",
  "role",
  "model",
  "name",
  "event",
  "object",
  "status",
  "stop_reason",
  "finish_reason",
  "media_type",
  "service_tier",
  "effort",
  "reasoning_effort",
  "verbosity",
  "truncation",
  "include",
  "modalities",
  "ttl",
  "tool_choice",
  "parallel_tool_calls",
]);

/** Ids that can identify a user, account, device or session. */
const PSEUDONYM_KEYS = new Set([
  "user_id",
  "session_id",
  "account_uuid",
  "device_id",
  "organization_id",
  "prompt_cache_key",
  "safety_identifier",
  "user",
]);

/** Other `*_id` keys (message, tool call, response ids) are random and kept. */
const ID_KEY = /(?:^id$|_id$|Id$)/;

/** Header values kept as they are; any other header value is pseudonymized. */
const KEEP_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "anthropic-beta",
  "anthropic-version",
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
  "content-type",
  "date",
  "host",
  "keep-alive",
  "openai-beta",
  "openai-processing-ms",
  "originator",
  "retry-after",
  "server",
  "transfer-encoding",
  "user-agent",
  "vary",
  "version",
  "x-app",
  "x-should-retry",
]);
const KEEP_HEADER_PREFIXES = ["x-stainless-", "anthropic-ratelimit-", "x-ratelimit-"];

/** Subscription usage and reset times describe one person's account, so they are hidden. */
const HIDDEN_HEADER_PREFIXES = ["anthropic-ratelimit-unified-"];

/** Words kept when pseudonymizing, so id formats stay readable. */
const ID_WORDS = new Set([
  "user",
  "account",
  "session",
  "device",
  "uuid",
  "id",
  "org",
  "organization",
  "req",
  "msg",
  "toolu",
  "resp",
  "call",
]);

/** Belt and braces: fail the scrub if anything that looks like a key survives. */
const SECRET_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+(?!\[redacted\])[A-Za-z0-9._~+/-]{16,})/;

export type Pseudonymize = (value: string) => string;

/**
 * Format-preserving and stable within one scrub run: the same input always maps to the same
 * output, hex stays hex, and digits and letter case keep their positions.
 */
export function createPseudonymizer(salt: Buffer = randomBytes(16)): Pseudonymize {
  return (value) =>
    value.replace(/[A-Za-z0-9]+/g, (run) => {
      if (ID_WORDS.has(run.toLowerCase())) return run;
      const digest = createHmac("sha256", salt).update(run).digest();
      const hex = /^[0-9a-f]+$/.test(run);
      let out = "";
      for (let i = 0; i < run.length; i++) {
        const byte = digest[i % digest.length] ?? 0;
        const char = run[i] as string;
        if (hex) out += "0123456789abcdef"[byte % 16];
        else if (/[0-9]/.test(char)) out += String(byte % 10);
        else if (/[A-Z]/.test(char)) out += String.fromCharCode(65 + (byte % 26));
        else out += String.fromCharCode(97 + (byte % 26));
      }
      return out;
    });
}

export function scrubbed(text: string): string {
  return `[scrubbed ${text.length} chars]`;
}

/** Keeps the keys of a subtree and scrubs every string in it, whatever its key. */
function scrubOpaque(value: unknown): unknown {
  if (typeof value === "string") return scrubbed(value);
  if (Array.isArray(value)) return value.map(scrubOpaque);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubOpaque(v)]));
  }
  return value;
}

export function scrubJson(value: unknown, pseudonymize: Pseudonymize, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && PSEUDONYM_KEYS.has(key)) return pseudonymize(value);
    // Connector tool names (`mcp__<service>__<tool>`) reveal which services someone has connected.
    if (key === "name" && value.startsWith("mcp__")) return `mcp__${pseudonymize(value.slice(5))}`;
    if (key !== undefined && (KEEP_KEYS.has(key) || ID_KEY.test(key))) return value;
    return scrubbed(value);
  }
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, pseudonymize, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Tool-call arguments are free-form; only their shape is kept.
      const opaque = k === "input" && v !== null && typeof v === "object" && !Array.isArray(v);
      out[k] = opaque ? scrubOpaque(v) : scrubJson(v, pseudonymize, k);
    }
    return out;
  }
  return value;
}

export function scrubHeaders(headers: HeaderMap, pseudonymize: Pseudonymize): HeaderMap {
  const keep = (name: string) =>
    !HIDDEN_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
    (KEEP_HEADERS.has(name) || KEEP_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix)));
  const scrubValue = (name: string, value: string) =>
    keep(name) || value.endsWith(REDACTED) ? value : pseudonymize(value);
  const out: HeaderMap = {};
  // Redact again in case a capture was written by an older or edited recorder.
  for (const [name, value] of Object.entries(redactHeaders(headers))) {
    out[name] = Array.isArray(value)
      ? value.map((v) => scrubValue(name, v))
      : scrubValue(name, value);
  }
  return out;
}

export interface FixtureEvent {
  /** Milliseconds since the request arrived, when the event's last byte did. */
  readonly at: number;
  readonly event?: string;
  readonly data: unknown;
}

export type FixtureBody =
  | { readonly kind: "empty" }
  | { readonly kind: "json"; readonly json: unknown }
  | { readonly kind: "sse"; readonly events: readonly FixtureEvent[] }
  | { readonly kind: "opaque"; readonly bytes: number };

export interface Fixture {
  readonly version: typeof FIXTURE_VERSION;
  readonly recordedAt: string;
  readonly upstream: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: HeaderMap;
    readonly body: FixtureBody;
  };
  readonly response?: {
    readonly status: number;
    readonly headers: HeaderMap;
    readonly firstByteMs: number | null;
    readonly totalMs: number;
    readonly chunkCount: number;
    readonly body: FixtureBody;
  };
  readonly error?: string;
}

function scrubData(data: string, pseudonymize: Pseudonymize): unknown {
  if (data === "[DONE]") return data;
  try {
    return scrubJson(JSON.parse(data), pseudonymize);
  } catch {
    return scrubbed(data);
  }
}

function headerValue(headers: HeaderMap, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Splits a server-sent event stream, timing each event by the chunk that completed it. */
function scrubSse(
  text: string,
  chunks: readonly { at: number; bytes: number }[],
  pseudonymize: Pseudonymize,
): FixtureEvent[] {
  const chunkEnds: { at: number; end: number }[] = [];
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.bytes;
    chunkEnds.push({ at: chunk.at, end: total });
  }
  const arrival = (byteOffset: number) =>
    chunkEnds.find((c) => c.end >= byteOffset)?.at ?? chunkEnds.at(-1)?.at ?? 0;

  const events: FixtureEvent[] = [];
  let offset = 0;
  for (const block of text.split(/(?<=\r?\n\r?\n)/)) {
    offset += Buffer.byteLength(block);
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (event === undefined && data.length === 0) continue;
    events.push({
      at: arrival(offset),
      ...(event !== undefined && { event }),
      data: scrubData(data.join("\n"), pseudonymize),
    });
  }
  return events;
}

function scrubBody(
  body: Capture["request"]["body"],
  headers: HeaderMap,
  chunks: readonly { at: number; bytes: number }[],
  pseudonymize: Pseudonymize,
): FixtureBody {
  if (body.bytes === 0) return { kind: "empty" };
  const text = bodyText(body);
  if (text === undefined) return { kind: "opaque", bytes: body.bytes };
  // Codex answers /responses with a stream but sends no content-type.
  if (
    headerValue(headers, "content-type").includes("text/event-stream") ||
    /^(event|data):/.test(text)
  ) {
    return { kind: "sse", events: scrubSse(text, chunks, pseudonymize) };
  }
  try {
    return { kind: "json", json: scrubJson(JSON.parse(text), pseudonymize) };
  } catch {
    return { kind: "opaque", bytes: body.bytes };
  }
}

export function scrubCapture(capture: Capture, pseudonymize: Pseudonymize): Fixture {
  const { request, response } = capture;
  const fixture: Fixture = {
    version: FIXTURE_VERSION,
    recordedAt: capture.recordedAt,
    upstream: new URL(capture.upstream).origin,
    request: {
      method: request.method,
      path: request.path,
      headers: scrubHeaders(request.headers, pseudonymize),
      body: scrubBody(request.body, request.headers, [], pseudonymize),
    },
    ...(response && {
      response: {
        status: response.status,
        headers: scrubHeaders(response.headers, pseudonymize),
        firstByteMs: response.firstByteMs,
        totalMs: response.totalMs,
        chunkCount: response.chunks.length,
        body: scrubBody(response.body, response.headers, response.chunks, pseudonymize),
      },
    }),
    ...(capture.error !== undefined && { error: capture.error }),
  };
  const serialized = JSON.stringify(fixture);
  if (SECRET_PATTERN.test(serialized)) {
    throw new Error("scrubbed fixture still contains something that looks like a credential");
  }
  return fixture;
}
