import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Io } from "../src/commands.js";
import { doctor, init, type SetupDeps } from "../src/setup.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenyard-setup-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function capture(): { io: Io; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    io: {
      out: (t) => {
        out += t;
      },
      err: (t) => {
        err += t;
      },
    },
    out: () => out,
    err: () => err,
  };
}

async function fakeUser(agents: string[]): Promise<{ userHome: string; home: string }> {
  const userHome = await tempDir();
  for (const dir of agents) await mkdir(join(userHome, dir), { recursive: true });
  return { userHome, home: join(userHome, ".tokenyard") };
}

describe("init", () => {
  it("configures only the agents that are installed", async () => {
    const { userHome } = await fakeUser([".claude", ".codex"]);
    const out = capture();
    expect(await init([], out.io, { userHome, env: {} })).toBe(0);
    expect(JSON.parse(await readFile(join(userHome, ".claude", "settings.json"), "utf8"))).toEqual({
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
    });
    expect(await readFile(join(userHome, ".codex", "config.toml"), "utf8")).toContain("tokenyard");
    expect(out.out()).toContain("Claude Code");
    expect(out.out()).not.toContain("OpenCode");
  });

  it("uses the port it is given, and undo reverses it", async () => {
    const { userHome } = await fakeUser([".claude"]);
    const deps: SetupDeps = { userHome, env: {} };
    await init(["claude", "--port", "9000"], capture().io, deps);
    const file = join(userHome, ".claude", "settings.json");
    expect(await readFile(file, "utf8")).toContain("127.0.0.1:9000");

    const out = capture();
    expect(await init(["claude", "--port", "9000", "--undo"], out.io, deps)).toBe(0);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({});
    expect(out.out()).toContain("removed from");
  });

  it("writes nothing on a dry run", async () => {
    const { userHome } = await fakeUser([".claude"]);
    const out = capture();
    await init(["claude", "--dry-run"], out.io, { userHome, env: {} });
    await expect(readFile(join(userHome, ".claude", "settings.json"), "utf8")).rejects.toThrow();
    expect(out.out()).toContain("dry run");
  });

  it("reports a conflict, keeps going and exits 1", async () => {
    const { userHome } = await fakeUser([".claude", ".codex"]);
    await writeFile(join(userHome, ".codex", "config.toml"), 'model_provider = "azure"\n');
    const out = capture();
    expect(await init([], out.io, { userHome, env: {} })).toBe(1);
    expect(out.err()).toContain("Codex CLI");
    expect(out.out()).toContain("Claude Code: TokenYard added");
  });

  it("fails clearly when no agent is found or the name is unknown", async () => {
    const { userHome } = await fakeUser([]);
    const out = capture();
    expect(await init([], out.io, { userHome, env: {} })).toBe(1);
    expect(out.err()).toContain("no agent settings found");
    await expect(init(["cursor"], capture().io, { userHome, env: {} })).rejects.toThrow(
      /unknown agent/,
    );
  });
});

describe("doctor", () => {
  const up = async () => true;
  const down = async () => false;

  it("passes on a configured setup", async () => {
    const { userHome, home } = await fakeUser([".claude"]);
    const deps: SetupDeps = { userHome, env: {}, isListening: up };
    await init(["claude"], capture().io, deps);
    const out = capture();
    expect(await doctor(["--home", home], out.io, deps)).toBe(0);
    expect(out.out()).toContain("Claude Code is pointed at the gateway");
    expect(out.out()).toContain("a gateway is listening");
    expect(out.out()).toContain("No problems found.");
  });

  it("warns, but does not fail, when the gateway is down or agents are unset", async () => {
    const { userHome, home } = await fakeUser([".claude"]);
    await writeFile(join(userHome, ".claude", "settings.json"), "{}");
    const out = capture();
    expect(await doctor(["--home", home], out.io, { userHome, env: {}, isListening: down })).toBe(
      0,
    );
    expect(out.out()).toContain("nothing is listening");
    expect(out.out()).toContain("tokenyard init claude");
  });

  it("fails on an old Node, a broken config, or a missing decider key", async () => {
    const { userHome, home } = await fakeUser([]);
    const old = capture();
    expect(
      await doctor(["--home", home], old.io, { userHome, env: {}, nodeVersion: "20.1.0" }),
    ).toBe(1);
    expect(old.out()).toContain("too old");

    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.yaml"), "mode: sideways\n");
    const bad = capture();
    expect(await doctor(["--home", home], bad.io, { userHome, env: {}, isListening: up })).toBe(1);
    expect(bad.out()).toContain("config.yaml");

    await writeFile(join(home, "config.yaml"), "mode: shadow\n");
    const noKey = capture();
    expect(await doctor(["--home", home], noKey.io, { userHome, env: {}, isListening: up })).toBe(
      1,
    );
    expect(noKey.out()).toContain("is not set");
  });
});
