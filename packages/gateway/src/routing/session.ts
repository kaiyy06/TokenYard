import { createHash } from "node:crypto";
import type { RequestShape } from "./request.js";
import type { Target } from "./types.js";

/** What the router remembers about one agent session between requests. */
export interface Session {
  readonly key: string;
  /** The target the session is currently running on, once a decision has been made. */
  target?: Target;
  /** The model the agent asked for when the session's decisions began; a change means the user switched. */
  baselineModel?: string;
  /** Prompt tokens seen in the last response; what sits in the cache right now. */
  contextTokens: number;
  /** User turns routed so far. */
  turns: number;
  lastSeen: number;
}

export interface SessionStoreOptions {
  /** Idle time after which a session is forgotten. Defaults to two hours. */
  readonly ttlMs?: number;
  /** Most sessions kept at once; the least recently used go first. Defaults to 1000. */
  readonly maxSessions?: number;
  readonly now?: () => number;
}

export interface SessionStore {
  /** Finds or creates the session for a request, and marks it as just used. */
  touch(shape: RequestShape): { session: Session; isNew: boolean };
  /** Records the context size that a finished response reported. */
  recordContext(key: string, contextTokens: number): void;
  readonly size: number;
}

/**
 * Identifies the session a request belongs to. An id from the agent wins; otherwise the
 * system prompt plus the first user message, which stay the same for the whole conversation.
 * Only a hash is kept, never the text.
 */
export function sessionKey(shape: RequestShape): string {
  if (shape.sessionId) return `${shape.api}:${shape.sessionId}`;
  const hash = createHash("sha256");
  hash.update(shape.model.split("-")[0] ?? "");
  hash.update("\0");
  hash.update(shape.systemText);
  hash.update("\0");
  hash.update(shape.firstUserText);
  return `${shape.api}:h:${hash.digest("hex").slice(0, 24)}`;
}

export function createSessionStore(options: SessionStoreOptions = {}): SessionStore {
  const ttlMs = options.ttlMs ?? 2 * 60 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 1000;
  const now = options.now ?? Date.now;
  // A Map iterates in insertion order, so re-inserting on use keeps the oldest first.
  const sessions = new Map<string, Session>();

  function evict(at: number): void {
    for (const [key, s] of sessions) {
      if (at - s.lastSeen <= ttlMs) break;
      sessions.delete(key);
    }
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next();
      if (oldest.done) break;
      sessions.delete(oldest.value);
    }
  }

  return {
    touch(shape) {
      const at = now();
      const key = sessionKey(shape);
      let session = sessions.get(key);
      const isNew = session === undefined || at - session.lastSeen > ttlMs;
      if (session === undefined || isNew)
        session = { key, contextTokens: 0, turns: 0, lastSeen: at };
      session.lastSeen = at;
      sessions.delete(key);
      sessions.set(key, session);
      evict(at);
      return { session, isNew };
    },
    recordContext(key, contextTokens) {
      const session = sessions.get(key);
      if (session) session.contextTokens = contextTokens;
    },
    get size() {
      return sessions.size;
    },
  };
}
