import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENTS = ["claude", "codex", "opencode"] as const;
export type AgentName = (typeof AGENTS)[number];

export const AGENT_LABELS: Readonly<Record<AgentName, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  opencode: "OpenCode",
};

export function isAgent(value: string): value is AgentName {
  return (AGENTS as readonly string[]).includes(value);
}

/** Where each agent keeps its user-level settings. */
export function configPaths(
  userHome: string = homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<AgentName, string> {
  const xdg = env.XDG_CONFIG_HOME || join(userHome, ".config");
  return {
    claude: join(env.CLAUDE_CONFIG_DIR || join(userHome, ".claude"), "settings.json"),
    codex: join(env.CODEX_HOME || join(userHome, ".codex"), "config.toml"),
    opencode: join(xdg, "opencode", "opencode.json"),
  };
}

export interface ChangeOptions {
  /** The gateway's base URL, such as http://127.0.0.1:8787. */
  url: string;
  /** Replace a setting the user already points somewhere else. */
  force?: boolean;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

export interface ChangeResult {
  file: string;
  /** False when the file already had the right content. */
  changed: boolean;
  /** Where the original file was copied, when this call made the copy. */
  backup?: string;
}

export const BACKUP_SUFFIX = ".tokenyard.bak";

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Copies the original once, so a later init never overwrites the first backup. */
async function backUp(file: string, existed: boolean): Promise<string | undefined> {
  if (!existed) return undefined;
  const backup = `${file}${BACKUP_SUFFIX}`;
  if ((await readIfExists(backup)) !== undefined) return undefined;
  await copyFile(file, backup);
  return backup;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tokenyard.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(file: string, text: string | undefined): Json {
  if (text === undefined || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${file} is not plain JSON (comments or a syntax error?). Edit it by hand instead.`,
    );
  }
  if (!isObject(parsed)) throw new Error(`${file} does not hold a JSON object`);
  return parsed;
}

/** Reads `obj[key]` as an object, creating it when absent. */
function child(file: string, obj: Json, key: string): Json {
  const value = obj[key];
  if (value === undefined) {
    const created: Json = {};
    obj[key] = created;
    return created;
  }
  if (!isObject(value)) throw new Error(`${file}: "${key}" is not an object`);
  return value;
}

interface Slot {
  /** Path inside the JSON file, such as ["env", "ANTHROPIC_BASE_URL"]. */
  path: readonly string[];
  value: string;
}

function slotsFor(agent: "claude" | "opencode", url: string): Slot[] {
  if (agent === "claude") return [{ path: ["env", "ANTHROPIC_BASE_URL"], value: url }];
  return [
    { path: ["provider", "anthropic", "options", "baseURL"], value: `${url}/v1` },
    { path: ["provider", "openai", "options", "baseURL"], value: `${url}/v1` },
  ];
}

function holder(file: string, root: Json, path: readonly string[]): Json {
  let node = root;
  for (const key of path.slice(0, -1)) node = child(file, node, key);
  return node;
}

async function initJson(
  agent: "claude" | "opencode",
  file: string,
  options: ChangeOptions,
): Promise<ChangeResult> {
  const text = await readIfExists(file);
  const root = parseJsonObject(file, text);
  let changed = false;
  for (const slot of slotsFor(agent, options.url)) {
    const node = holder(file, root, slot.path);
    const key = slot.path[slot.path.length - 1] as string;
    const current = node[key];
    if (current === slot.value) continue;
    if (current !== undefined && !options.force) {
      throw new Error(
        `${file} already sets ${slot.path.join(".")} to ${JSON.stringify(current)}. ` +
          "Run with --force to replace it (the original file is backed up).",
      );
    }
    node[key] = slot.value;
    changed = true;
  }
  if (!changed || options.dryRun) return { file, changed };
  const backup = await backUp(file, text !== undefined);
  await writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
  return { file, changed, ...(backup && { backup }) };
}

async function undoJson(
  agent: "claude" | "opencode",
  file: string,
  options: ChangeOptions,
): Promise<ChangeResult> {
  const text = await readIfExists(file);
  if (text === undefined) return { file, changed: false };
  const root = parseJsonObject(file, text);
  let changed = false;
  for (const slot of slotsFor(agent, options.url)) {
    // Walk down without creating anything, and only remove what is ours.
    const trail: Json[] = [root];
    let node: Json | undefined = root;
    for (const key of slot.path.slice(0, -1)) {
      const next: unknown = node?.[key];
      node = isObject(next) ? next : undefined;
      if (node === undefined) break;
      trail.push(node);
    }
    const key = slot.path[slot.path.length - 1] as string;
    if (node === undefined || node[key] !== slot.value) continue;
    delete node[key];
    changed = true;
    // Drop containers that the removal left empty, so we leave no trace.
    for (let i = trail.length - 1; i > 0; i--) {
      if (Object.keys(trail[i] as Json).length > 0) break;
      delete (trail[i - 1] as Json)[slot.path[i - 1] as string];
    }
  }
  if (!changed || options.dryRun) return { file, changed };
  await writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
  return { file, changed };
}

const BEGIN = "# >>> tokenyard (managed, remove with `tokenyard init codex --undo`) >>>";
const END = "# <<< tokenyard <<<";
const BLOCK = new RegExp(`${escapeRegExp(BEGIN)}[\\s\\S]*?${escapeRegExp(END)}\\r?\\n?`, "g");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripManaged(text: string): string {
  return text.replace(BLOCK, "");
}

function codexBlocks(url: string): { top: string; table: string } {
  return {
    top: `${BEGIN}\nmodel_provider = "tokenyard"\n${END}\n`,
    table:
      `${BEGIN}\n[model_providers.tokenyard]\n` +
      `name = "TokenYard"\nbase_url = "${url}/v1"\nenv_key = "OPENAI_API_KEY"\n` +
      `wire_api = "responses"\n${END}\n`,
  };
}

async function initCodex(file: string, options: ChangeOptions): Promise<ChangeResult> {
  const text = await readIfExists(file);
  const clean = stripManaged(text ?? "");
  if (/^\s*model_provider\s*=/m.test(clean)) {
    throw new Error(
      `${file} already sets model_provider. Remove that line (or set it to "tokenyard") and run again.`,
    );
  }
  if (/^\s*\[model_providers\.tokenyard\]/m.test(clean)) {
    throw new Error(
      `${file} already defines [model_providers.tokenyard] outside TokenYard's block`,
    );
  }
  const { top, table } = codexBlocks(options.url);
  const body = clean.trim() === "" ? "" : `${clean.trim()}\n\n`;
  const next = `${top}\n${body}${table}`;
  if (next === text) return { file, changed: false };
  if (options.dryRun) return { file, changed: true };
  const backup = await backUp(file, text !== undefined);
  await writeAtomic(file, next);
  return { file, changed: true, ...(backup && { backup }) };
}

async function undoCodex(file: string, options: ChangeOptions): Promise<ChangeResult> {
  const text = await readIfExists(file);
  if (text === undefined || !text.includes(BEGIN)) return { file, changed: false };
  if (options.dryRun) return { file, changed: true };
  const stripped = stripManaged(text)
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  await writeAtomic(file, stripped === "" ? "" : `${stripped}\n`);
  return { file, changed: true };
}

export function initAgent(
  agent: AgentName,
  file: string,
  options: ChangeOptions,
): Promise<ChangeResult> {
  return agent === "codex" ? initCodex(file, options) : initJson(agent, file, options);
}

export function undoAgent(
  agent: AgentName,
  file: string,
  options: ChangeOptions,
): Promise<ChangeResult> {
  return agent === "codex" ? undoCodex(file, options) : undoJson(agent, file, options);
}

export type AgentState = "tokenyard" | "other" | "unset" | "missing";

/** Whether an agent's settings point at the gateway, without changing anything. */
export async function inspectAgent(
  agent: AgentName,
  file: string,
  url: string,
): Promise<AgentState> {
  const text = await readIfExists(file);
  if (text === undefined) return "missing";
  if (agent === "codex") {
    if (text.includes(BEGIN)) return "tokenyard";
    return /^\s*model_provider\s*=/m.test(text) ? "other" : "unset";
  }
  const root = parseJsonObject(file, text);
  const states = slotsFor(agent, url).map((slot) => {
    let node: unknown = root;
    for (const key of slot.path) node = isObject(node) ? node[key] : undefined;
    return node === slot.value ? "tokenyard" : node === undefined ? "unset" : "other";
  });
  if (states.includes("other")) return "other";
  return states.every((state) => state === "tokenyard") ? "tokenyard" : "unset";
}
