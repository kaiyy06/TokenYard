/** What the router did, or would have done in shadow mode, for one request. */
export interface RoutingRecord {
  /** `route` rewrote the request, `shadow` only logged, `passthrough` left it alone. */
  readonly action: "passthrough" | "shadow" | "route";
  readonly reason: string;
  /** The tier, effort and model the router picked. Null when it picked nothing. */
  readonly tier: string | null;
  readonly effort: string | null;
  readonly model: string | null;
  /** True when the decider was consulted for this request. */
  readonly decided: boolean;
  readonly deciderMs: number | null;
  readonly deciderCostUsd: number | null;
  /**
   * What the same tokens would have cost on the other option: the requested model when the
   * request was rewritten, the routed model in shadow mode. Null when a price is unknown.
   */
  readonly altCostUsd: number | null;
}

/** One row per inference request that passed through the gateway. */
export interface UsageRecord {
  /** Milliseconds since the epoch, when the request arrived. */
  readonly ts: number;
  readonly provider: "anthropic" | "openai";
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** The model that answered, falling back to the one the agent asked for. */
  readonly model: string | null;
  readonly requestModel: string | null;
  readonly stream: boolean;
  /** Null when the response carried no usage. */
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  /** Null when there was no usage or the model has no known price. */
  readonly costUsd: number | null;
  readonly firstByteMs: number | null;
  readonly totalMs: number;
  readonly error: string | null;
  /** Null when routing was not involved (it is off, or the request was not routable). */
  readonly routing: RoutingRecord | null;
}

export interface TimeRange {
  /** Inclusive lower bound, in epoch milliseconds. */
  readonly since?: number;
  /** Exclusive upper bound, in epoch milliseconds. */
  readonly until?: number;
}

/** Storage behind an interface so the default SQLite store can be swapped. */
export interface UsageStore {
  insert(record: UsageRecord): void;
  /** Records in the range, oldest first. */
  list(range?: TimeRange): UsageRecord[];
  close(): void;
}

/** A store that keeps records in memory; used in tests. */
export function createMemoryStore(): UsageStore {
  const rows: UsageRecord[] = [];
  return {
    insert: (record) => void rows.push(record),
    list: (range = {}) =>
      rows.filter((r) => r.ts >= (range.since ?? -Infinity) && r.ts < (range.until ?? Infinity)),
    close: () => {},
  };
}
