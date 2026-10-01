import type { PricingTable } from "./pricing.js";
import type { Exchange } from "./proxy.js";
import type { UsageStore } from "./store.js";

/** Only requests that run a model are recorded; listing models or counting tokens is not usage. */
export function isInferencePath(path: string): boolean {
  const pathname = path.split("?")[0] ?? "";
  return (
    pathname === "/v1/messages" ||
    pathname === "/v1/chat/completions" ||
    pathname === "/v1/responses" ||
    // Codex signed in with ChatGPT posts to the bare path, with no /v1.
    pathname === "/responses"
  );
}

/**
 * Returns an `onExchange` handler that writes one usage record per inference request. The
 * cost is priced when the request happens, so later price changes do not rewrite history.
 */
export function createUsageRecorder(
  store: UsageStore,
  pricing: PricingTable,
): (exchange: Exchange) => void {
  return (e) => {
    if (e.method !== "POST" || !isInferencePath(e.path)) return;
    const costUsd = e.usage && e.model ? (pricing.cost(e.model, e.usage) ?? null) : null;
    store.insert({
      ts: e.startedAt,
      provider: e.provider,
      method: e.method,
      path: e.path.split("?")[0] ?? e.path,
      status: e.status,
      model: e.model ?? null,
      requestModel: e.requestModel ?? null,
      stream: e.stream ?? false,
      inputTokens: e.usage?.inputTokens ?? null,
      outputTokens: e.usage?.outputTokens ?? null,
      cacheReadTokens: e.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: e.usage?.cacheWriteTokens ?? null,
      costUsd,
      firstByteMs: e.firstByteMs,
      totalMs: e.totalMs,
      error: e.error ?? null,
    });
  };
}
