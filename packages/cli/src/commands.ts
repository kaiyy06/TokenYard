import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createUsageRecorder,
  DEFAULT_UPSTREAMS,
  formatStats,
  type Gateway,
  loadPricing,
  openSqliteStore,
  type PricingTable,
  parseSince,
  type RoutingMode,
  startGateway,
  summarize,
  toCsv,
  toJsonl,
} from "@tokenyard/gateway";

import { buildRouter, type MakeDecider } from "./routing.js";
import { loadSettings } from "./settings.js";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

/** Things the commands reach out for, replaceable in tests. */
export interface Deps {
  loadPricing(cacheFile: string): Promise<PricingTable>;
  makeDecider?: MakeDecider;
  /** Environment variables, for finding the decider's API key. */
  env?: Readonly<Record<string, string | undefined>>;
}

const defaultDeps: Deps = {
  loadPricing: (cacheFile) => loadPricing({ cacheFile }),
};

export const HELP: string = `tokenyard: a local gateway for coding agents that tracks what they spend

Usage:
  tokenyard start [options]   Run the gateway on 127.0.0.1
  tokenyard stats [options]   Show recorded usage and spend
  tokenyard init [agent]      Point Claude Code, Codex or OpenCode at the gateway
  tokenyard doctor [options]  Check that everything is set up and working

start options:
  --port <n>                  Port to listen on (default 8787)
  --host <address>            Address to bind (default 127.0.0.1; 0.0.0.0 only inside a container)
  --anthropic-upstream <url>  Default ${DEFAULT_UPSTREAMS.anthropic}
  --openai-upstream <url>     Default ${DEFAULT_UPSTREAMS.openai}
  --mode <off|shadow|route>   Routing mode; overrides config.yaml. Routing is off without a config.

stats options:
  --since <duration>          30m, 24h, 7d, 2w or all (default 24h)
  --json                      Print the summary as JSON
  --export <jsonl|csv>        Print every record instead of a summary

init options:
  [agent]                     claude, codex, opencode or all (default: every agent found)
  --port <n>                  Port the gateway runs on (default 8787)
  --undo                      Remove what init added
  --force                     Replace a setting that already points elsewhere
  --dry-run                   Show what would change without writing

doctor options:
  --port <n>                  Port the gateway runs on (default 8787)

Common options:
  --home <dir>                Data directory (default ~/.tokenyard, or $TOKENYARD_HOME)
  -h, --help                  Show this help
`;

export function homeDir(value: string | undefined): string {
  return value ?? process.env.TOKENYARD_HOME ?? join(homedir(), ".tokenyard");
}

export interface RunningGateway {
  readonly gateway: Gateway;
  close(): Promise<void>;
}

/** Starts the gateway with usage recording. The caller decides when to stop it. */
export async function start(
  argv: readonly string[],
  io: Io,
  deps: Deps = defaultDeps,
): Promise<RunningGateway> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "anthropic-upstream": { type: "string" },
      "openai-upstream": { type: "string" },
      mode: { type: "string" },
      home: { type: "string" },
    },
    strict: true,
  });
  if (values.mode !== undefined && !["off", "shadow", "route"].includes(values.mode)) {
    throw new Error(`invalid --mode "${values.mode}" (use off, shadow or route)`);
  }
  const port = values.port === undefined ? 8787 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port "${values.port}"`);
  }
  const home = homeDir(values.home);

  const loaded = await loadSettings(home);
  const settings =
    values.mode === undefined ? loaded : { ...loaded, mode: values.mode as RoutingMode };

  const store = openSqliteStore(join(home, "usage.db"));
  const pricing = await deps.loadPricing(join(home, "pricing.json"));
  if (pricing.size === 0) {
    io.err("warning: no model prices available (offline?); spend will show as unpriced\n");
  }

  const built = buildRouter(settings, pricing, deps.env ?? process.env, deps.makeDecider);
  for (const note of built.notes) io.err(`${note}\n`);

  const gateway = await startGateway({
    port,
    ...(values.host && { host: values.host }),
    ...(built.router && { router: built.router }),
    upstreams: {
      ...(values["anthropic-upstream"] && { anthropic: values["anthropic-upstream"] }),
      ...(values["openai-upstream"] && { openai: values["openai-upstream"] }),
    },
    onExchange: createUsageRecorder(store, pricing),
  }).catch((error: unknown) => {
    store.close();
    throw error;
  });

  io.out(
    `TokenYard is listening on ${gateway.url}\n` +
      `Recording usage to ${join(home, "usage.db")}\n\n` +
      `Point your agent at it:\n` +
      `  Claude Code  ANTHROPIC_BASE_URL=${gateway.url}\n` +
      `  Codex        OPENAI_BASE_URL=${gateway.url}/v1\n\n` +
      `See what it recorded with: tokenyard stats\n`,
  );

  return {
    gateway,
    async close() {
      await gateway.close();
      store.close();
    },
  };
}

export function stats(argv: readonly string[], io: Io): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      since: { type: "string", default: "24h" },
      json: { type: "boolean", default: false },
      export: { type: "string" },
      home: { type: "string" },
    },
    strict: true,
  });
  if (values.export !== undefined && values.export !== "jsonl" && values.export !== "csv") {
    throw new Error(`invalid --export "${values.export}" (use jsonl or csv)`);
  }
  const since = parseSince(values.since);

  const store = openSqliteStore(join(homeDir(values.home), "usage.db"));
  try {
    const records = store.list(since === undefined ? {} : { since });
    if (values.export === "jsonl") io.out(toJsonl(records));
    else if (values.export === "csv") io.out(toCsv(records));
    else if (values.json) io.out(`${JSON.stringify(summarize(records), null, 2)}\n`);
    else {
      const label = values.since === "all" ? "for all time" : `in the last ${values.since}`;
      io.out(`${formatStats(summarize(records), label)}\n`);
    }
  } finally {
    store.close();
  }
}
