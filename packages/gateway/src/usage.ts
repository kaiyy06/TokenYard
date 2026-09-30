import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Provider } from "./upstream.js";

/**
 * Token counts for one request, normalized across providers:
 * `inputTokens` never includes cached tokens, which are reported separately.
 */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export interface TapResult {
  /** The model that actually answered, when the response says so. */
  readonly model?: string;
  /** Missing when the response carried no usage (errors, or streams without usage). */
  readonly usage?: Usage;
}

/** Bounds on what the tap will hold in memory for one response. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE_CHARS = 4 * 1024 * 1024;

interface Fields {
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Later values win, so a final cumulative count replaces an early estimate. */
function set<K extends keyof Fields>(into: Fields, key: K, value: Fields[K] | undefined): void {
  if (value !== undefined) into[key] = value;
}

/** Anthropic reports uncached input and the two cache counts separately. */
function readAnthropic(usage: Record<string, unknown>, into: Fields): void {
  set(into, "input", num(usage.input_tokens));
  set(into, "output", num(usage.output_tokens));
  set(into, "cacheRead", num(usage.cache_read_input_tokens));
  set(into, "cacheWrite", num(usage.cache_creation_input_tokens));
}

/** OpenAI's input total already contains the cached tokens, so they are split out. */
function readOpenAI(usage: Record<string, unknown>, into: Fields): void {
  const total = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const details = obj(usage.prompt_tokens_details) ?? obj(usage.input_tokens_details);
  const cached = num(details?.cached_tokens) ?? 0;
  if (total !== undefined) {
    into.input = Math.max(0, total - cached);
    into.cacheRead = cached;
    into.cacheWrite = 0;
  }
  set(into, "output", num(usage.completion_tokens) ?? num(usage.output_tokens));
}

/** Reads one parsed JSON value: a whole response body, or one event of a stream. */
function readValue(provider: Provider, value: unknown, into: Fields): void {
  const root = obj(value);
  if (!root) return;
  const read = provider === "anthropic" ? readAnthropic : readOpenAI;
  // Anthropic `message_start` nests the message; OpenAI `response.*` events nest the response.
  for (const holder of [root, obj(root.message), obj(root.response)]) {
    if (!holder) continue;
    if (typeof holder.model === "string") into.model = holder.model;
    const usage = obj(holder.usage);
    if (usage) read(usage, into);
  }
}

/** Incremental parser for `text/event-stream`. Holds at most one partial event. */
export class SseParser {
  readonly #decoder = new TextDecoder();
  readonly #onData: (data: string) => void;
  #buffer = "";
  #data: string[] = [];

  constructor(onData: (data: string) => void) {
    this.#onData = onData;
  }

  write(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#drain(false);
  }

  end(): void {
    this.#buffer += this.#decoder.decode();
    this.#drain(true);
    if (this.#buffer !== "") this.#line(this.#buffer);
    this.#buffer = "";
    this.#dispatch();
  }

  #drain(final: boolean): void {
    const newline = /\r\n|\n|\r/g;
    let start = 0;
    for (let match = newline.exec(this.#buffer); match; match = newline.exec(this.#buffer)) {
      // A lone "\r" at the very end may be the first half of "\r\n".
      if (!final && match[0] === "\r" && newline.lastIndex === this.#buffer.length) break;
      this.#line(this.#buffer.slice(start, match.index));
      start = newline.lastIndex;
    }
    this.#buffer = this.#buffer.slice(start);
    if (this.#buffer.length > MAX_SSE_LINE_CHARS) this.#buffer = "";
  }

  #line(line: string): void {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (!line.startsWith("data:")) return;
    const value = line.slice(5);
    this.#data.push(value.startsWith(" ") ? value.slice(1) : value);
  }

  #dispatch(): void {
    if (this.#data.length === 0) return;
    const data = this.#data.join("\n");
    this.#data = [];
    this.#onData(data);
  }
}

function makeDecoder(encoding: string | undefined): Transform | null | "unsupported" {
  switch (encoding?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return "unsupported";
  }
}

export interface TapHeaders {
  readonly contentType?: string | undefined;
  readonly contentEncoding?: string | undefined;
}

/**
 * Reads usage out of a response while it streams past. It sees a copy of each chunk and never
 * delays or alters the real one. Event streams are parsed as they arrive and hold only the
 * event in progress; a JSON body is held (up to a cap) so it can be parsed once complete.
 * Anything unexpected results in "no usage", never an exception.
 */
export class UsageTap {
  readonly #provider: Provider;
  readonly #fields: Fields = {};
  readonly #decoder: Transform | null | "unsupported";
  readonly #done: Promise<void> | undefined;
  #mode: "sse" | "json" | "none";
  #sse: SseParser | undefined;
  #json: Buffer[] = [];
  #jsonBytes = 0;
  #decoding = true;

  constructor(provider: Provider, headers: TapHeaders) {
    this.#provider = provider;
    const type = headers.contentType?.toLowerCase() ?? "";
    this.#mode = type.includes("text/event-stream")
      ? "sse"
      : type.includes("json")
        ? "json"
        : "none";
    if (this.#mode === "sse") {
      this.#sse = new SseParser((data) => this.#event(data));
    }
    this.#decoder = makeDecoder(headers.contentEncoding);
    if (this.#decoder === "unsupported") this.#mode = "none";
    if (this.#decoder && this.#decoder !== "unsupported") {
      const decoder = this.#decoder;
      decoder.on("data", (chunk: Buffer) => this.#consume(chunk));
      this.#done = new Promise<void>((resolve) => {
        decoder.on("end", resolve);
        decoder.on("close", resolve);
        decoder.on("error", () => {
          this.#mode = "none";
          this.#decoding = false;
          resolve();
        });
      });
    }
  }

  write(chunk: Buffer): void {
    if (this.#mode === "none") return;
    try {
      if (this.#decoder && this.#decoder !== "unsupported") {
        if (this.#decoding) this.#decoder.write(chunk);
      } else {
        this.#consume(chunk);
      }
    } catch {
      this.#mode = "none";
    }
  }

  async end(): Promise<TapResult> {
    try {
      if (this.#decoder && this.#decoder !== "unsupported" && this.#decoding) {
        this.#decoder.end();
        await this.#done;
      }
      if (this.#mode === "sse") this.#sse?.end();
      if (this.#mode === "json")
        readValue(this.#provider, parseJson(Buffer.concat(this.#json)), this.#fields);
    } catch {
      // Fall through with whatever was read.
    }
    return this.#result();
  }

  #consume(chunk: Buffer): void {
    if (this.#mode === "sse") {
      this.#sse?.write(chunk);
    } else if (this.#mode === "json") {
      this.#jsonBytes += chunk.length;
      if (this.#jsonBytes > MAX_JSON_BYTES) {
        this.#mode = "none";
        this.#json = [];
      } else {
        this.#json.push(chunk);
      }
    }
  }

  #event(data: string): void {
    // Most events are content deltas; skip parsing anything that cannot carry usage or a model.
    if (
      !data.includes('"usage"') &&
      (this.#fields.model !== undefined || !data.includes('"model"'))
    ) {
      return;
    }
    readValue(this.#provider, parseJson(data), this.#fields);
  }

  #result(): TapResult {
    const f = this.#fields;
    const result: { model?: string; usage?: Usage } = {};
    if (f.model !== undefined) result.model = f.model;
    if (f.input !== undefined || f.output !== undefined) {
      result.usage = {
        inputTokens: f.input ?? 0,
        outputTokens: f.output ?? 0,
        cacheReadTokens: f.cacheRead ?? 0,
        cacheWriteTokens: f.cacheWrite ?? 0,
      };
    }
    return result;
  }
}

function parseJson(text: string | Buffer): unknown {
  try {
    return JSON.parse(text.toString());
  } catch {
    return undefined;
  }
}

export interface RequestInfo {
  readonly model?: string;
  readonly stream?: boolean;
}

/** Reads the model and streaming flag from a request body; anything unparseable gives `{}`. */
export function readRequestInfo(body: Buffer): RequestInfo {
  const json = obj(parseJson(body));
  if (!json) return {};
  return {
    ...(typeof json.model === "string" && { model: json.model }),
    ...(typeof json.stream === "boolean" && { stream: json.stream }),
  };
}
