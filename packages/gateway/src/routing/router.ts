import { normalizeModelId, type PricingTable } from "../pricing.js";
import type { Classification } from "./classifier.js";
import { applyPolicy } from "./policy.js";
import { inspectRequest, type RequestShape } from "./request.js";
import type { Session, SessionStore } from "./session.js";
import {
  DEFAULT_POLICY,
  type Effort,
  type PolicyConfig,
  type Signals,
  type Target,
  TIERS,
  type Tier,
} from "./types.js";

export type RoutingMode = "off" | "shadow" | "route";
export type TierModels = Readonly<Record<Tier, string>>;

export interface RouterConfig {
  readonly mode: RoutingMode;
  /** The model for each tier, per provider. */
  readonly tiers: { readonly anthropic: TierModels; readonly openai: TierModels };
  readonly policy?: PolicyConfig;
  /** How many more turns a session is assumed to run when weighing a cache rebuild. Default 8. */
  readonly expectedRemainingTurns?: number;
}

export interface RouterDeps {
  readonly config: RouterConfig;
  readonly sessions: SessionStore;
  readonly pricing: PricingTable;
  readonly classify: (shape: RequestShape, session: Session) => Promise<Classification>;
}

export interface RoutingDecision {
  /** `route` means the request should be rewritten; `shadow` means only the log is written. */
  readonly action: "passthrough" | "shadow" | "route";
  /** Why this decision was made, for the usage log. */
  readonly reason: string;
  readonly sessionKey?: string;
  /** The model the agent asked for. */
  readonly requestModel?: string;
  /** The tier and effort chosen, and the model that tier maps to. */
  readonly target?: Target;
  readonly model?: string;
  /** True when the decider was consulted for this request. */
  readonly decided: boolean;
  readonly deciderLatencyMs?: number;
  readonly deciderCostUsd?: number;
  readonly signals?: Signals;
}

export interface Router {
  decide(path: string, body: unknown): Promise<RoutingDecision>;
  /** Tells the router how big the session's prompt was after a response finished. */
  observe(sessionKey: string, contextTokens: number): void;
}

/** Rough reasoning tokens spent per effort level, used to price an effort change. */
const REASONING_TOKENS: Record<Effort, number> = { none: 0, low: 500, medium: 2000, high: 6000 };

export function effortFromRequest(value: string | undefined): Effort {
  switch (value?.toLowerCase()) {
    case "none":
    case "minimal":
      return "none";
    case "low":
      return "low";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "medium";
  }
}

function tierOf(models: TierModels, model: string): Tier | undefined {
  const wanted = normalizeModelId(model);
  return TIERS.find((t) => normalizeModelId(models[t]) === wanted);
}

export function createRouter(deps: RouterDeps): Router {
  const { config, sessions, pricing, classify } = deps;
  const policy = config.policy ?? DEFAULT_POLICY;
  const remainingTurns = config.expectedRemainingTurns ?? 8;
  const apply = config.mode === "route" ? "route" : "shadow";

  async function decide(path: string, body: unknown): Promise<RoutingDecision> {
    if (config.mode === "off")
      return { action: "passthrough", reason: "routing is off", decided: false };
    const shape = inspectRequest(path, body);
    if (!shape) return { action: "passthrough", reason: "unrecognized request", decided: false };

    const models =
      shape.api === "anthropic-messages" ? config.tiers.anthropic : config.tiers.openai;
    const requestTier = tierOf(models, shape.model);
    const base = { requestModel: shape.model, decided: false };
    if (!requestTier)
      return { action: "passthrough", reason: "model is not in the tier map", ...base };

    const { session, isNew } = sessions.touch(shape);
    const withKey = { ...base, sessionKey: session.key };
    // Anything the agent sends to the cheapest tier is its own background call.
    if (requestTier === "fast" && (isNew || session.target === undefined)) {
      return { action: "passthrough", reason: "agent's own fast-tier call", ...withKey };
    }
    if (session.baselineModel !== undefined && session.baselineModel !== shape.model) {
      delete session.target; // The user switched models: start over from their choice.
    }
    session.baselineModel = shape.model;

    // A tool-result continuation reuses what this user turn already decided.
    if (!shape.newUserTurn && session.target) {
      return {
        action: apply,
        reason: "continuation",
        target: session.target,
        model: models[session.target.tier],
        ...withKey,
      };
    }

    const current: Target = session.target ?? {
      tier: requestTier,
      effort: effortFromRequest(shape.effort),
    };
    const result = await classify(shape, session);
    if (!result.ok) {
      return {
        action: "passthrough",
        reason: `decider failed (${result.reason})`,
        deciderLatencyMs: result.latencyMs,
        ...withKey,
      };
    }

    const contextTokens =
      session.contextTokens > 0 ? session.contextTokens : Math.round(shape.sizeChars / 4);
    const outcome = applyPolicy(current, result.signals, policy, {
      contextTokens: session.turns === 0 ? 0 : contextTokens,
      remainingTurns,
      newSession: session.turns === 0,
      price: (tier) => pricing.lookup(models[tier]),
      effortSaving: (from, to) => {
        const output = pricing.lookup(models[current.tier])?.output ?? 0;
        return (REASONING_TOKENS[from] - REASONING_TOKENS[to]) * output;
      },
    });
    session.target = outcome.target;
    session.turns++;
    return {
      action: apply,
      reason: outcome.reason,
      target: outcome.target,
      model: models[outcome.target.tier],
      ...withKey,
      requestModel: shape.model,
      decided: true,
      deciderLatencyMs: result.latencyMs,
      ...(result.costUsd !== undefined && { deciderCostUsd: result.costUsd }),
      signals: result.signals,
    };
  }

  return {
    async decide(path, body) {
      try {
        return await decide(path, body);
      } catch (err) {
        // Fail open: whatever went wrong, the request goes through as the agent sent it.
        return {
          action: "passthrough",
          reason: `router error (${err instanceof Error ? err.message : "unknown"})`,
          decided: false,
        };
      }
    },
    observe(sessionKey, contextTokens) {
      sessions.recordContext(sessionKey, contextTokens);
    },
  };
}
