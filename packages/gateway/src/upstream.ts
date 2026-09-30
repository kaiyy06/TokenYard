import type { IncomingHttpHeaders } from "node:http";

export type Provider = "anthropic" | "openai";

export interface Upstreams {
  readonly anthropic: string;
  readonly openai: string;
}

export const DEFAULT_UPSTREAMS: Upstreams = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

/**
 * Decides which provider a request belongs to. The path is authoritative where it is
 * unambiguous; for shared paths such as `/v1/models` the credential header decides.
 * Unknown requests default to OpenAI, whose format is the most widely spoken.
 */
export function detectProvider(path: string, headers: IncomingHttpHeaders): Provider {
  const pathname = path.split("?")[0] ?? "";
  if (pathname.startsWith("/v1/messages") || pathname.startsWith("/v1/complete")) {
    return "anthropic";
  }
  if (pathname.startsWith("/v1/chat/completions") || pathname.startsWith("/v1/responses")) {
    return "openai";
  }
  if (headers["anthropic-version"] !== undefined || headers["x-api-key"] !== undefined) {
    return "anthropic";
  }
  return "openai";
}
