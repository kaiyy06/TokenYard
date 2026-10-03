import { existsSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { providers } from "@tokenyard/decider";

import {
  AGENT_LABELS,
  AGENTS,
  type AgentName,
  configPaths,
  initAgent,
  inspectAgent,
  isAgent,
  undoAgent,
} from "./agents.js";
import { homeDir, type Io } from "./commands.js";
import { loadSettings } from "./settings.js";

/** Things setup commands look at, replaceable in tests. */
export interface SetupDeps {
  /** The user's home directory, where the agents keep their settings. */
  userHome?: string;
  env?: Readonly<Record<string, string | undefined>>;
  nodeVersion?: string;
  /** Whether something accepts connections on the port. */
  isListening?(port: number): Promise<boolean>;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`invalid port "${value}"`);
  return port;
}

export function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Points the chosen agents at the gateway, or undoes that. Returns the exit code. */
export async function init(argv: readonly string[], io: Io, deps: SetupDeps = {}): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string" },
      undo: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      home: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) throw new Error("init takes one agent name, or none");
  const choice = positionals[0] ?? "all";
  if (choice !== "all" && !isAgent(choice)) {
    throw new Error(`unknown agent "${choice}" (use claude, codex, opencode or all)`);
  }
  const url = `http://127.0.0.1:${parsePort(values.port)}`;
  const paths = configPaths(deps.userHome, deps.env);

  let agents: readonly AgentName[];
  if (choice === "all") {
    // Without a name, only touch agents that are installed, so we don't create stray folders.
    agents = AGENTS.filter((agent) => existsSync(dirname(paths[agent])));
    if (agents.length === 0) {
      io.err("no agent settings found; name one: tokenyard init claude|codex|opencode\n");
      return 1;
    }
  } else {
    agents = [choice];
  }

  const dryRun = values["dry-run"];
  let failed = false;
  for (const agent of agents) {
    const label = AGENT_LABELS[agent];
    const options = { url, force: values.force, dryRun };
    try {
      const result = values.undo
        ? await undoAgent(agent, paths[agent], options)
        : await initAgent(agent, paths[agent], options);
      const verb = values.undo ? "removed from" : "added to";
      if (!result.changed) {
        io.out(`${label}: nothing to ${values.undo ? "remove" : "change"} (${result.file})\n`);
      } else if (dryRun) {
        io.out(`${label}: would be ${verb} ${result.file} (dry run, nothing written)\n`);
      } else {
        io.out(`${label}: TokenYard ${verb} ${result.file}\n`);
        if (result.backup) io.out(`  original saved as ${result.backup}\n`);
      }
    } catch (error) {
      failed = true;
      io.err(`${label}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (!failed && !values.undo && !dryRun) {
    io.out(`\nStart the gateway with: tokenyard start --port ${url.split(":")[2]}\n`);
    io.out("Then check the setup with: tokenyard doctor\n");
  }
  return failed ? 1 : 0;
}

type Level = "ok" | "warn" | "fail";
const MARK: Record<Level, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** Checks the setup and prints one line per check. Returns 1 if anything failed. */
export async function doctor(
  argv: readonly string[],
  io: Io,
  deps: SetupDeps = {},
): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { port: { type: "string" }, home: { type: "string" } },
    strict: true,
  });
  const port = parsePort(values.port);
  const url = `http://127.0.0.1:${port}`;
  const home = homeDir(values.home);
  const env = deps.env ?? process.env;
  const lines: { level: Level; text: string }[] = [];
  const add = (level: Level, text: string) => void lines.push({ level, text });

  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const [major = 0, minor = 0] = nodeVersion.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) add("ok", `Node ${nodeVersion}`);
  else add("fail", `Node ${nodeVersion} is too old; TokenYard needs 22.5 or newer`);

  let settings: Awaited<ReturnType<typeof loadSettings>> | undefined;
  try {
    settings = await loadSettings(home);
    const file = join(home, "config.yaml");
    add(
      "ok",
      existsSync(file)
        ? `${file} is valid (routing mode: ${settings.mode})`
        : `no config.yaml, so routing is off and traffic passes through`,
    );
  } catch (error) {
    add("fail", error instanceof Error ? error.message : String(error));
  }

  if (settings && settings.mode !== "off") {
    const preset = providers[settings.decider.provider];
    const keyName = settings.decider.apiKeyEnv ?? preset.apiKeyEnv;
    if (!keyName) add("ok", `decider ${settings.decider.provider} needs no API key`);
    else if (env[keyName]) add("ok", `${keyName} is set for the decider`);
    else add("fail", `${keyName} is not set, so routing will stay off`);
  }

  const listening = await (deps.isListening ?? isPortListening)(port);
  if (listening) add("ok", `a gateway is listening on ${url}`);
  else add("warn", `nothing is listening on ${url}; start it with: tokenyard start --port ${port}`);

  const paths = configPaths(deps.userHome, env);
  for (const agent of AGENTS) {
    const label = AGENT_LABELS[agent];
    try {
      const state = await inspectAgent(agent, paths[agent], url);
      if (state === "tokenyard") add("ok", `${label} is pointed at the gateway`);
      else if (state === "missing") add("warn", `${label}: no settings file at ${paths[agent]}`);
      else if (state === "unset") {
        add("warn", `${label} is not pointed at the gateway; run: tokenyard init ${agent}`);
      } else {
        add("warn", `${label} points somewhere else; run: tokenyard init ${agent} --force`);
      }
    } catch (error) {
      add("warn", `${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const { level, text } of lines) io.out(`[${MARK[level]}] ${text}\n`);
  const failures = lines.filter((line) => line.level === "fail").length;
  io.out(failures === 0 ? "\nNo problems found.\n" : `\n${failures} problem(s) found.\n`);
  return failures === 0 ? 0 : 1;
}
