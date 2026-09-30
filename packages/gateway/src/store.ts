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
