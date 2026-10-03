import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BACKUP_SUFFIX,
  configPaths,
  initAgent,
  inspectAgent,
  isAgent,
  undoAgent,
} from "../src/agents.js";

const URL = "http://127.0.0.1:8787";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenyard-agents-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const read = (file: string) => readFile(file, "utf8");

describe("configPaths", () => {
  it("resolves each agent under the user's home", () => {
    const paths = configPaths("/h", {});
    expect(paths.claude).toBe(join("/h", ".claude", "settings.json"));
    expect(paths.codex).toBe(join("/h", ".codex", "config.toml"));
    expect(paths.opencode).toBe(join("/h", ".config", "opencode", "opencode.json"));
  });

  it("honours the agents' own override variables", () => {
    const paths = configPaths("/h", {
      CLAUDE_CONFIG_DIR: "/c",
      CODEX_HOME: "/x",
      XDG_CONFIG_HOME: "/q",
    });
    expect(paths.claude).toBe(join("/c", "settings.json"));
    expect(paths.codex).toBe(join("/x", "config.toml"));
    expect(paths.opencode).toBe(join("/q", "opencode", "opencode.json"));
  });

  it("recognises agent names", () => {
    expect(isAgent("codex")).toBe(true);
    expect(isAgent("cursor")).toBe(false);
  });
});

describe("Claude Code", () => {
  it("creates settings when none exist, and undo removes them again", async () => {
    const file = join(await tempDir(), "nested", "settings.json");
    const result = await initAgent("claude", file, { url: URL });
    expect(result).toEqual({ file, changed: true });
    expect(JSON.parse(await read(file))).toEqual({ env: { ANTHROPIC_BASE_URL: URL } });

    expect((await undoAgent("claude", file, { url: URL })).changed).toBe(true);
    expect(JSON.parse(await read(file))).toEqual({});
  });

  it("keeps other settings and backs up the original once", async () => {
    const file = join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    const first = await initAgent("claude", file, { url: URL });
    expect(first.backup).toBe(`${file}${BACKUP_SUFFIX}`);
    expect(JSON.parse(await read(`${file}${BACKUP_SUFFIX}`))).toEqual({
      model: "opus",
      env: { FOO: "1" },
    });
    expect(JSON.parse(await read(file))).toEqual({
      model: "opus",
      env: { FOO: "1", ANTHROPIC_BASE_URL: URL },
    });

    await undoAgent("claude", file, { url: URL });
    expect(JSON.parse(await read(file))).toEqual({ model: "opus", env: { FOO: "1" } });
  });

  it("is idempotent", async () => {
    const file = join(await tempDir(), "settings.json");
    await initAgent("claude", file, { url: URL });
    expect((await initAgent("claude", file, { url: URL })).changed).toBe(false);
  });

  it("refuses to replace a different base URL unless forced", async () => {
    const file = join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }));
    await expect(initAgent("claude", file, { url: URL })).rejects.toThrow(/--force/);
    expect(JSON.parse(await read(file)).env.ANTHROPIC_BASE_URL).toBe("https://proxy.example");

    await initAgent("claude", file, { url: URL, force: true });
    expect(JSON.parse(await read(file)).env.ANTHROPIC_BASE_URL).toBe(URL);
  });

  it("undo leaves a value that is not ours alone", async () => {
    const file = join(await tempDir(), "settings.json");
    await writeFile(file, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }));
    expect((await undoAgent("claude", file, { url: URL })).changed).toBe(false);
  });

  it("dry run writes nothing", async () => {
    const file = join(await tempDir(), "settings.json");
    const result = await initAgent("claude", file, { url: URL, dryRun: true });
    expect(result.changed).toBe(true);
    await expect(read(file)).rejects.toThrow();
  });

  it("rejects a file that is not plain JSON without touching it", async () => {
    const file = join(await tempDir(), "settings.json");
    await writeFile(file, '{ // comment\n "a": 1 }');
    await expect(initAgent("claude", file, { url: URL })).rejects.toThrow(/not plain JSON/);
    expect(await read(file)).toContain("// comment");
  });
});

describe("OpenCode", () => {
  it("points the Anthropic and OpenAI providers at the gateway", async () => {
    const file = join(await tempDir(), "opencode.json");
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", provider: { anthropic: { name: "x" } } }),
    );
    await initAgent("opencode", file, { url: URL });
    expect(JSON.parse(await read(file))).toEqual({
      theme: "dark",
      provider: {
        anthropic: { name: "x", options: { baseURL: `${URL}/v1` } },
        openai: { options: { baseURL: `${URL}/v1` } },
      },
    });

    await undoAgent("opencode", file, { url: URL });
    expect(JSON.parse(await read(file))).toEqual({
      theme: "dark",
      provider: { anthropic: { name: "x" } },
    });
  });
});

describe("Codex CLI", () => {
  const existing = '[tui]\nstatus = true\n\n[projects."/home/me"]\ntrust_level = "trusted"\n';

  it("adds the provider while keeping the user's tables, and undo restores the file", async () => {
    const file = join(await tempDir(), "config.toml");
    await writeFile(file, existing);
    const result = await initAgent("codex", file, { url: URL });
    expect(result.backup).toBe(`${file}${BACKUP_SUFFIX}`);

    const text = await read(file);
    // The top-level key has to come before the first table to be a top-level key.
    expect(text.indexOf('model_provider = "tokenyard"')).toBeLessThan(text.indexOf("[tui]"));
    expect(text).toContain("[model_providers.tokenyard]");
    expect(text).toContain(`base_url = "${URL}/v1"`);
    expect(text).toContain('wire_api = "responses"');
    expect(text).toContain('trust_level = "trusted"');

    await undoAgent("codex", file, { url: URL });
    expect(await read(file)).toBe(existing);
  });

  it("is idempotent", async () => {
    const file = join(await tempDir(), "config.toml");
    await writeFile(file, existing);
    await initAgent("codex", file, { url: URL });
    const once = await read(file);
    expect((await initAgent("codex", file, { url: URL })).changed).toBe(false);
    expect(await read(file)).toBe(once);
  });

  it("moves to a new port by replacing its own block", async () => {
    const file = join(await tempDir(), "config.toml");
    await initAgent("codex", file, { url: URL });
    await initAgent("codex", file, { url: "http://127.0.0.1:9000" });
    const text = await read(file);
    expect(text).toContain("http://127.0.0.1:9000/v1");
    expect(text).not.toContain("8787");
    expect(text.match(/\[model_providers\.tokenyard\]/g)).toHaveLength(1);
  });

  it("refuses when the user already picked another provider", async () => {
    const file = join(await tempDir(), "config.toml");
    await writeFile(file, 'model_provider = "azure"\n');
    await expect(initAgent("codex", file, { url: URL })).rejects.toThrow(/model_provider/);
    expect(await read(file)).toBe('model_provider = "azure"\n');
  });

  it("undo on a missing file does nothing", async () => {
    const file = join(await tempDir(), "config.toml");
    expect((await undoAgent("codex", file, { url: URL })).changed).toBe(false);
  });
});

describe("inspectAgent", () => {
  it("reports whether an agent is set up", async () => {
    const dir = await tempDir();
    const claude = join(dir, "settings.json");
    const codex = join(dir, "config.toml");
    expect(await inspectAgent("claude", claude, URL)).toBe("missing");

    await writeFile(claude, "{}");
    await writeFile(codex, "[tui]\nx = 1\n");
    expect(await inspectAgent("claude", claude, URL)).toBe("unset");
    expect(await inspectAgent("codex", codex, URL)).toBe("unset");

    await initAgent("claude", claude, { url: URL });
    await initAgent("codex", codex, { url: URL });
    expect(await inspectAgent("claude", claude, URL)).toBe("tokenyard");
    expect(await inspectAgent("codex", codex, URL)).toBe("tokenyard");

    await writeFile(claude, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" } }));
    expect(await inspectAgent("claude", claude, URL)).toBe("other");
  });
});
