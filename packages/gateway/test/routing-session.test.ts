import { describe, expect, it } from "vitest";
import type { RequestShape } from "../src/routing/request.js";
import { createSessionStore, sessionKey } from "../src/routing/session.js";

const shape = (over: Partial<RequestShape> = {}): RequestShape => ({
  api: "anthropic-messages",
  model: "claude-sonnet-5-5",
  systemText: "system",
  firstUserText: "fix the bug",
  lastUserText: "fix the bug",
  newUserTurn: true,
  userTurns: 1,
  recentTools: [],
  toolErrors: 0,
  sizeChars: 100,
  ...over,
});

describe("sessionKey", () => {
  it("uses the agent's session id when there is one", () => {
    expect(sessionKey(shape({ sessionId: "abc" }))).toBe("anthropic-messages:abc");
  });

  it("falls back to a hash that stays stable as the conversation grows", () => {
    const a = sessionKey(shape());
    expect(sessionKey(shape({ lastUserText: "something else", userTurns: 5 }))).toBe(a);
    expect(sessionKey(shape({ firstUserText: "another task" }))).not.toBe(a);
    expect(sessionKey(shape({ systemText: "other agent" }))).not.toBe(a);
    expect(a).not.toContain("fix the bug");
  });
});

describe("createSessionStore", () => {
  it("returns the same session for the same conversation", () => {
    const store = createSessionStore();
    const first = store.touch(shape());
    expect(first.isNew).toBe(true);
    first.session.target = { tier: "fast", effort: "low" };
    const second = store.touch(shape({ userTurns: 3 }));
    expect(second.isNew).toBe(false);
    expect(second.session.target).toEqual({ tier: "fast", effort: "low" });
  });

  it("forgets sessions that sit idle past the ttl", () => {
    let t = 0;
    const store = createSessionStore({ ttlMs: 1000, now: () => t });
    store.touch(shape());
    t = 1500;
    expect(store.touch(shape()).isNew).toBe(true);
  });

  it("drops the least recently used session when full", () => {
    const store = createSessionStore({ maxSessions: 2 });
    store.touch(shape({ sessionId: "a" }));
    store.touch(shape({ sessionId: "b" }));
    store.touch(shape({ sessionId: "a" }));
    store.touch(shape({ sessionId: "c" }));
    expect(store.size).toBe(2);
    expect(store.touch(shape({ sessionId: "a" })).isNew).toBe(false);
    expect(store.touch(shape({ sessionId: "b" })).isNew).toBe(true);
  });

  it("records the context size a response reported", () => {
    const store = createSessionStore();
    const { session } = store.touch(shape());
    store.recordContext(session.key, 4200);
    expect(store.touch(shape()).session.contextTokens).toBe(4200);
  });
});
