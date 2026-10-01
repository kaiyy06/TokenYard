import type { UsageRecord } from "./store.js";

export interface ModelStats {
  readonly model: string;
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  /** Requests whose cost is unknown (no usage in the response, or no price for the model). */
  readonly unpriced: number;
}

export interface Stats {
  readonly requests: number;
  /** Requests that ended in an HTTP error or a gateway error. */
  readonly failed: number;
  readonly totals: Omit<ModelStats, "model">;
  readonly byModel: readonly ModelStats[];
  /** Share of input tokens served from the prompt cache, or null with no input. */
  readonly cacheHitRate: number | null;
  readonly firstByteMs: { readonly p50: number; readonly p95: number } | null;
  /** Null when no request involved routing. */
  readonly routing: RoutingStats | null;
}

export interface RoutingStats {
  readonly requests: number;
  readonly shadow: number;
  readonly routed: number;
  readonly passedThrough: number;
  /** Requests the router chose a different model for (applied or only logged). */
  readonly switches: number;
  /** Requests where the decider was consulted, and how long it took on average. */
  readonly decisions: number;
  readonly avgDeciderMs: number | null;
  readonly deciderCostUsd: number;
  /**
   * Spend minus the other option's cost for the same tokens, over switched requests that could
   * be priced. In shadow mode this is what routing would have saved; it ignores the cost of
   * rebuilding the prompt cache, so treat it as an estimate.
   */
  readonly savedUsd: number;
  readonly priced: number;
  /** Why requests were passed through, most common first. */
  readonly passthroughReasons: readonly { readonly reason: string; readonly count: number }[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function emptyRow(model: string): Mutable<ModelStats> {
  return {
    model,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    unpriced: 0,
  };
}

function add(row: Mutable<ModelStats>, r: UsageRecord): void {
  row.requests++;
  row.inputTokens += r.inputTokens ?? 0;
  row.outputTokens += r.outputTokens ?? 0;
  row.cacheReadTokens += r.cacheReadTokens ?? 0;
  row.cacheWriteTokens += r.cacheWriteTokens ?? 0;
  if (r.costUsd === null) row.unpriced++;
  else row.costUsd += r.costUsd;
}

function percentile(sorted: readonly number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

function summarizeRouting(records: readonly UsageRecord[]): RoutingStats | null {
  const routed = records.filter((r) => r.routing !== null);
  if (routed.length === 0) return null;
  let shadow = 0;
  let applied = 0;
  let passed = 0;
  let switches = 0;
  let decisions = 0;
  let deciderMs = 0;
  let deciderCost = 0;
  let saved = 0;
  let priced = 0;
  const reasons = new Map<string, number>();

  for (const r of routed) {
    const g = r.routing as NonNullable<UsageRecord["routing"]>;
    if (g.action === "shadow") shadow++;
    else if (g.action === "route") applied++;
    else {
      passed++;
      const reason = g.reason.replace(/\(.*\)$/, "").trim();
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    if (g.decided) {
      decisions++;
      deciderMs += g.deciderMs ?? 0;
    }
    deciderCost += g.deciderCostUsd ?? 0;
    const different = g.action !== "passthrough" && g.model !== null && g.model !== r.requestModel;
    if (different) {
      switches++;
      if (r.costUsd !== null && g.altCostUsd !== null) {
        saved += g.action === "route" ? g.altCostUsd - r.costUsd : r.costUsd - g.altCostUsd;
        priced++;
      }
    }
  }
  return {
    requests: routed.length,
    shadow,
    routed: applied,
    passedThrough: passed,
    switches,
    decisions,
    avgDeciderMs: decisions > 0 ? deciderMs / decisions : null,
    deciderCostUsd: deciderCost,
    savedUsd: saved,
    priced,
    passthroughReasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function summarize(records: readonly UsageRecord[]): Stats {
  const total = emptyRow("total");
  const models = new Map<string, Mutable<ModelStats>>();
  let failed = 0;
  const firstBytes: number[] = [];

  for (const r of records) {
    const name = r.model ?? r.requestModel ?? "unknown";
    const row = models.get(name) ?? emptyRow(name);
    models.set(name, row);
    add(row, r);
    add(total, r);
    if (r.status >= 400 || r.status === 0 || r.error !== null) failed++;
    if (r.firstByteMs !== null) firstBytes.push(r.firstByteMs);
  }

  const { model: _model, ...totals } = total;
  const allInput = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  firstBytes.sort((a, b) => a - b);

  return {
    requests: records.length,
    failed,
    totals,
    byModel: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests),
    cacheHitRate: allInput > 0 ? totals.cacheReadTokens / allInput : null,
    firstByteMs:
      firstBytes.length > 0
        ? { p50: percentile(firstBytes, 0.5), p95: percentile(firstBytes, 0.95) }
        : null,
    routing: summarizeRouting(records),
  };
}

const int = new Intl.NumberFormat("en-US");

function usd(value: number): string {
  return value >= 100 ? `$${value.toFixed(0)}` : `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0)))
        .join("  "),
    )
    .join("\n");
}

/** A plain-text report for a terminal. */
export function formatStats(stats: Stats, label: string): string {
  if (stats.requests === 0) return `No requests recorded ${label}.`;
  const t = stats.totals;
  const lines = [
    `TokenYard usage, ${label}`,
    "",
    `Requests   ${int.format(stats.requests)}${stats.failed > 0 ? ` (${stats.failed} failed)` : ""}`,
    `Spend      ${usd(t.costUsd)}${t.unpriced > 0 ? `  (${t.unpriced} requests unpriced)` : ""}`,
    `Tokens     ${int.format(t.inputTokens)} input, ${int.format(t.outputTokens)} output`,
    `Cache      ${int.format(t.cacheReadTokens)} read, ${int.format(t.cacheWriteTokens)} written` +
      (stats.cacheHitRate !== null
        ? `  (${(stats.cacheHitRate * 100).toFixed(0)}% of input from cache)`
        : ""),
  ];
  if (stats.firstByteMs) {
    lines.push(
      `Latency    first byte p50 ${stats.firstByteMs.p50.toFixed(0)} ms, p95 ${stats.firstByteMs.p95.toFixed(0)} ms`,
    );
  }
  lines.push(
    "",
    table([
      ["Model", "Requests", "Input", "Output", "Cache read", "Spend"],
      ...stats.byModel.map((m) => [
        m.model,
        int.format(m.requests),
        int.format(m.inputTokens),
        int.format(m.outputTokens),
        int.format(m.cacheReadTokens),
        usd(m.costUsd),
      ]),
    ]),
  );
  if (stats.routing) lines.push("", ...formatRouting(stats.routing));
  return lines.join("\n");
}

function formatRouting(r: RoutingStats): string[] {
  const mode = r.routed > 0 ? "routing" : "shadow mode";
  const lines = [
    `Routing (${mode})`,
    `  ${int.format(r.requests)} requests: ${int.format(r.routed)} rerouted, ${int.format(r.shadow)} logged only, ${int.format(r.passedThrough)} passed through`,
    `  ${int.format(r.switches)} would use or used a different model than the agent asked for`,
  ];
  if (r.avgDeciderMs !== null) {
    lines.push(
      `  decider: ${int.format(r.decisions)} calls, ${r.avgDeciderMs.toFixed(0)} ms on average, ${usd(r.deciderCostUsd)} spent`,
    );
  }
  if (r.priced > 0) {
    const verb = r.routed > 0 ? "saved" : "would save";
    lines.push(
      `  estimate: ${verb} ${usd(r.savedUsd)} across ${int.format(r.priced)} switched requests (same tokens, ignoring cache rebuilds)`,
    );
  }
  for (const p of r.passthroughReasons.slice(0, 3)) {
    lines.push(`  passed through: ${p.reason} (${int.format(p.count)})`);
  }
  return lines;
}

/** Parses `24h`, `7d`, `30m` or `all` into a start time, or undefined for everything. */
export function parseSince(value: string, now: number = Date.now()): number | undefined {
  if (value === "all") return undefined;
  const match = /^(\d+)([mhdw])$/.exec(value);
  if (!match) throw new Error(`invalid duration "${value}" (use e.g. 30m, 24h, 7d, 2w or all)`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2] as "m"];
  return now - Number(match[1]) * unit;
}

export function toJsonl(records: readonly UsageRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}

const CSV_COLUMNS = [
  "ts",
  "provider",
  "method",
  "path",
  "status",
  "model",
  "requestModel",
  "stream",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "firstByteMs",
  "totalMs",
  "error",
] as const satisfies readonly (keyof UsageRecord)[];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(records: readonly UsageRecord[]): string {
  const rows = records.map((r) => CSV_COLUMNS.map((column) => csvCell(r[column])).join(","));
  return `${[CSV_COLUMNS.join(","), ...rows].join("\n")}\n`;
}
