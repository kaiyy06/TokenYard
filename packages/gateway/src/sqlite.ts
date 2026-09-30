import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TimeRange, UsageRecord, UsageStore } from "./store.js";

const SCHEMA_VERSION = 1;

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE usage (
     id INTEGER PRIMARY KEY,
     ts INTEGER NOT NULL,
     provider TEXT NOT NULL,
     method TEXT NOT NULL,
     path TEXT NOT NULL,
     status INTEGER NOT NULL,
     model TEXT,
     request_model TEXT,
     stream INTEGER NOT NULL,
     input_tokens INTEGER,
     output_tokens INTEGER,
     cache_read_tokens INTEGER,
     cache_write_tokens INTEGER,
     cost_usd REAL,
     first_byte_ms REAL,
     total_ms REAL NOT NULL,
     error TEXT
   );
   CREATE INDEX usage_ts ON usage (ts);`,
];

interface Row {
  ts: number;
  provider: "anthropic" | "openai";
  method: string;
  path: string;
  status: number;
  model: string | null;
  request_model: string | null;
  stream: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  first_byte_ms: number | null;
  total_ms: number;
  error: string | null;
}

/** Opens (creating and migrating if needed) the SQLite usage database at `file`. */
export function openSqliteStore(file: string): UsageStore {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`${file} was written by a newer TokenYard (schema ${current})`);
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.exec(MIGRATIONS[version] as string);
    db.exec(`PRAGMA user_version = ${version + 1}`);
  }

  const insert = db.prepare(
    `INSERT INTO usage (ts, provider, method, path, status, model, request_model, stream,
       input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
       first_byte_ms, total_ms, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const list = db.prepare("SELECT * FROM usage WHERE ts >= ? AND ts < ? ORDER BY ts, id");

  return {
    insert(r) {
      insert.run(
        r.ts,
        r.provider,
        r.method,
        r.path,
        r.status,
        r.model,
        r.requestModel,
        r.stream ? 1 : 0,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.costUsd,
        r.firstByteMs,
        r.totalMs,
        r.error,
      );
    },
    list(range: TimeRange = {}) {
      const rows = list.all(
        range.since ?? 0,
        range.until ?? Number.MAX_SAFE_INTEGER,
      ) as unknown as Row[];
      return rows.map(
        (row): UsageRecord => ({
          ts: row.ts,
          provider: row.provider,
          method: row.method,
          path: row.path,
          status: row.status,
          model: row.model,
          requestModel: row.request_model,
          stream: row.stream === 1,
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          cacheReadTokens: row.cache_read_tokens,
          cacheWriteTokens: row.cache_write_tokens,
          costUsd: row.cost_usd,
          firstByteMs: row.first_byte_ms,
          totalMs: row.total_ms,
          error: row.error,
        }),
      );
    },
    close: () => db.close(),
  };
}
