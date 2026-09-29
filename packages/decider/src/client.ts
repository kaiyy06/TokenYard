import type { DecideRequest, DecideResult, DeciderError, Questions } from "./types.js";
import { validateRequest, validateResponse } from "./validate.js";

export const DEFAULT_TIMEOUT_MS = 1000;

/** Longest provider error body kept in an error message. */
const MAX_ERROR_BODY_CHARS = 300;

export interface DeciderOptions {
  /** API root including the version segment, e.g. `https://openrouter.ai/api/v1`. */
  readonly baseURL: string;
  /** Default model, e.g. `typesafe/jev-1.13` on OpenRouter or `jev-1.13` on TypeSafe. */
  readonly model: string;
  /** Sent as a bearer token. Omit for local servers that need no auth. */
  readonly apiKey?: string;
  /** Time budget for one call, covering connect, response and body. */
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Custom fetch, for tests or transport configuration. */
  readonly fetch?: typeof fetch;
}

export interface DecideOptions {
  /** Aborts the call; it then resolves to an `aborted` error. */
  readonly signal?: AbortSignal;
  /** Overrides the client's time budget for this call. */
  readonly timeoutMs?: number;
}

export interface Decider {
  readonly model: string;
  /**
   * Asks the decision model. Never throws and never retries: callers on a hot path
   * should fall back to a default when `ok` is false.
   */
  decide<Q extends Questions>(
    request: DecideRequest<Q>,
    options?: DecideOptions,
  ): Promise<DecideResult<Q>>;
}

export function createDecider(options: DeciderOptions): Decider {
  const endpoint = `${options.baseURL.replace(/\/+$/, "")}/systemone`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    ...options.headers,
    "content-type": "application/json",
    accept: "application/json",
  };
  if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;

  async function decide<Q extends Questions>(
    request: DecideRequest<Q>,
    callOptions: DecideOptions = {},
  ): Promise<DecideResult<Q>> {
    const started = performance.now();
    const fail = (error: Omit<DeciderError, "latencyMs">): DecideResult<Q> => ({
      ok: false,
      error: { ...error, latencyMs: performance.now() - started },
    });

    const invalid = validateRequest(request);
    if (invalid !== undefined) return fail({ kind: "invalid_request", message: invalid });

    const timeout = AbortSignal.timeout(callOptions.timeoutMs ?? defaultTimeoutMs);
    const signal = callOptions.signal ? AbortSignal.any([timeout, callOptions.signal]) : timeout;

    const abortError = (): DecideResult<Q> =>
      timeout.aborted
        ? fail({ kind: "timeout", message: "decider call timed out" })
        : fail({ kind: "aborted", message: "decider call was aborted" });

    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.model ?? options.model,
          state: request.state,
          questions: request.questions,
        }),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) return abortError();
      return fail({ kind: "network", message: `decider request failed: ${describe(cause)}` });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (signal.aborted) return abortError();
      return fail({ kind: "network", message: `decider response failed: ${describe(cause)}` });
    }

    if (!response.ok) {
      const detail = text.slice(0, MAX_ERROR_BODY_CHARS).trim();
      return fail({
        kind: "http",
        status: response.status,
        message: `decider returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail({ kind: "invalid_response", message: "decider response is not JSON" });
    }

    const validated = validateResponse(request.questions, body);
    if (!validated.ok) return fail({ kind: "invalid_response", message: validated.message });

    return {
      ok: true,
      decision: { ...validated.value, latencyMs: performance.now() - started },
    };
  }

  return { model: options.model, decide };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause.cause as { code?: unknown } | undefined)?.code;
    return typeof code === "string" ? `${cause.message} (${code})` : cause.message;
  }
  return String(cause);
}
