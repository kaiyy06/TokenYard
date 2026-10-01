import type { Decider } from "@tokenyard/decider";
import type { RequestShape } from "./request.js";
import type { Session } from "./session.js";
import { type Signals, TIERS, type Tier } from "./types.js";

export interface ClassifierOptions {
  /** Longest text sent for the task goal and for the latest message. Defaults to 4000. */
  readonly maxChars?: number;
  /** Whether recent tool names are included in what the decider sees. Defaults to true. */
  readonly includeToolNames?: boolean;
  readonly timeoutMs?: number;
}

export type Classification =
  | {
      readonly ok: true;
      readonly signals: Signals;
      readonly latencyMs: number;
      readonly costUsd?: number;
      readonly model: string;
    }
  | { readonly ok: false; readonly reason: string; readonly latencyMs: number };

/** The questions asked about every new user turn, in one call. */
export const QUESTIONS = {
  tier: {
    type: "choice",
    instructions: "Which model tier can complete this coding step well?",
    criteria: {
      fast: "Trivial edits, lookups, renames, formatting, simple questions",
      standard: "Typical feature work, bug fixes, tests, refactors in a few files",
      frontier: "Architecture, hard debugging, multi-file reasoning, ambiguous specs",
    },
  },
  effort: {
    type: "score",
    instructions: "How much reasoning does this step need?",
    criteria: ["None", "Low", "Medium", "High"],
  },
  task_changed: {
    type: "noul",
    instructions: "Is this a new, unrelated task rather than a continuation?",
  },
} as const;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** What the decider sees about a turn. It never includes the system prompt or tool outputs. */
export function buildState(
  shape: RequestShape,
  session: Session,
  options: ClassifierOptions = {},
): Record<string, string | number | string[]> {
  const max = options.maxChars ?? 4000;
  return {
    task_goal: clip(shape.firstUserText, max),
    latest_message: clip(shape.lastUserText, max),
    turn_count: shape.userTurns,
    context_tokens: session.contextTokens,
    ...(options.includeToolNames !== false && { recent_tools: [...shape.recentTools] }),
    tool_errors: shape.toolErrors,
  };
}

/**
 * Asks the decider about a new user turn. Returns a failure instead of throwing, so the caller
 * can fall back to forwarding the request unchanged.
 */
export function createClassifier(
  decider: Decider,
  options: ClassifierOptions = {},
): (shape: RequestShape, session: Session) => Promise<Classification> {
  return async (shape, session) => {
    const result = await decider.decide(
      { state: buildState(shape, session, options), questions: QUESTIONS },
      options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    );
    if (!result.ok) {
      return {
        ok: false,
        reason: `${result.error.kind}: ${result.error.message}`,
        latencyMs: result.error.latencyMs,
      };
    }
    const { answers, usage, model, latencyMs } = result.decision;
    const choice = answers.tier.choice;
    if (!(TIERS as readonly string[]).includes(choice)) {
      return { ok: false, reason: `unknown tier "${choice}"`, latencyMs };
    }
    return {
      ok: true,
      signals: {
        tier: { choice: choice as Tier, confidence: answers.tier.confidence },
        effort: { score: answers.effort.score, confidence: answers.effort.confidence },
        taskChanged: answers.task_changed.noul,
      },
      latencyMs,
      ...(usage.costUsd !== undefined && { costUsd: usage.costUsd }),
      model,
    };
  };
}
