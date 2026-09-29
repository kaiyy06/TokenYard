/** On-disk format of one recorded request/response exchange. */
export const CAPTURE_VERSION = 1;

export type HeaderMap = Record<string, string | string[]>;

export interface CapturedBody {
  /** UTF-8 text, or base64 when the bytes are not valid UTF-8. */
  readonly data: string;
  readonly encoding: "utf8" | "base64";
  readonly bytes: number;
}

export interface CapturedChunk {
  /** Milliseconds since the request arrived. */
  readonly at: number;
  readonly bytes: number;
}

export interface CapturedResponse {
  readonly status: number;
  readonly headers: HeaderMap;
  readonly body: CapturedBody;
  /** Chunk boundaries and arrival times, in the order the upstream sent them. */
  readonly chunks: readonly CapturedChunk[];
  readonly firstByteMs: number | null;
  readonly totalMs: number;
}

export interface Capture {
  readonly version: typeof CAPTURE_VERSION;
  readonly recordedAt: string;
  readonly upstream: string;
  readonly request: {
    readonly method: string;
    /** Path and query as the agent sent them. */
    readonly path: string;
    /** As received from the agent, with secrets redacted. */
    readonly headers: HeaderMap;
    readonly body: CapturedBody;
  };
  /** Missing when the exchange failed before the upstream answered. */
  readonly response?: CapturedResponse;
  readonly error?: string;
}

export const REDACTED = "[redacted]";

const SECRET_HEADER = /authorization|api-?key|cookie|token|secret|password|credential/i;

/** Key prefixes worth keeping: they tell an API key from an OAuth token without revealing either. */
const KEY_PREFIX = /^(?:sk-ant-(?:api|oat|admin)\d*-|sk-or-v\d+-|sk-proj-|sk-)/;

function redactValue(value: string): string {
  const scheme = /^(Bearer|Basic)\s+/i.exec(value);
  const secret = scheme ? value.slice(scheme[0].length) : value;
  const prefix = KEY_PREFIX.exec(secret)?.[0] ?? "";
  return `${scheme ? `${scheme[1]} ` : ""}${prefix}${REDACTED}`;
}

export function isSecretHeader(name: string): boolean {
  // Rate-limit headers such as `anthropic-ratelimit-tokens-limit` mention tokens but hold counts.
  return SECRET_HEADER.test(name) && !/ratelimit/i.test(name);
}

/** Copies headers, replacing credentials so they never reach disk. */
export function redactHeaders(headers: Readonly<Record<string, unknown>>): HeaderMap {
  const out: HeaderMap = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value.map(String) : String(value);
    if (!isSecretHeader(name)) {
      out[name] = values;
    } else {
      out[name] = Array.isArray(values) ? values.map(redactValue) : redactValue(values);
    }
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function captureBody(bytes: Buffer): CapturedBody {
  try {
    return { data: utf8.decode(bytes), encoding: "utf8", bytes: bytes.length };
  } catch {
    return { data: bytes.toString("base64"), encoding: "base64", bytes: bytes.length };
  }
}

export function bodyText(body: CapturedBody): string | undefined {
  return body.encoding === "utf8" ? body.data : undefined;
}
