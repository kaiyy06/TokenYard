import type { ModelPrice } from "../pricing.js";
import { switchPaysOff } from "./cache.js";
import {
  EFFORTS,
  type Effort,
  effortRank,
  type PolicyConfig,
  type Signals,
  type Target,
  type Tier,
  tierRank,
} from "./types.js";

export interface PolicyContext {
  /** Tokens in the session's prompt cache; zero on the first request. */
  readonly contextTokens: number;
  readonly remainingTurns: number;
  /** Price of a tier's model, when known. */
  readonly price: (tier: Tier) => ModelPrice | undefined;
  /** Dollars saved per turn by dropping from `from` to `to` effort, when known. */
  readonly effortSaving?: (from: Effort, to: Effort) => number;
  /** True for the first request of a session, when there is no cache to protect. */
  readonly newSession: boolean;
}

export interface PolicyOutcome {
  readonly target: Target;
  /** Why the target is what it is, for the usage log. */
  readonly reason: string;
}

function inRange(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Maps the decider's effort score onto a level. */
export function effortFromScore(score: number): Effort {
  const index = Math.min(EFFORTS.length - 1, Math.max(0, Math.round(score)));
  return EFFORTS[index] as Effort;
}

/**
 * Chooses the tier and effort for a turn. Moving up is allowed whenever the decider is
 * reasonably sure. Moving down needs a new task, high confidence and cache math that favors it.
 * Any signal that does not make sense leaves the current target alone.
 */
export function applyPolicy(
  current: Target,
  signals: Signals,
  config: PolicyConfig,
  context: PolicyContext,
): PolicyOutcome {
  const keep = (reason: string): PolicyOutcome => ({ target: current, reason });
  const { tier, effort } = signals;
  if (
    !inRange(tier.confidence) ||
    !inRange(effort.confidence) ||
    !inRange(signals.taskChanged) ||
    !Number.isFinite(effort.score)
  ) {
    return keep("invalid signals");
  }

  const wantedEffort = effortFromScore(effort.score);
  const taskChanged = context.newSession ? 1 : signals.taskChanged;
  const downAllowed = (confidence: number): boolean =>
    taskChanged > config.taskChangedThreshold && confidence >= config.downgradeMinConfidence;

  let nextTier = current.tier;
  const tierMove = tierRank(tier.choice) - tierRank(current.tier);
  if (tierMove > 0 && tier.confidence >= config.upgradeMinConfidence) {
    nextTier = tier.choice;
  } else if (tierMove < 0 && downAllowed(tier.confidence)) {
    const from = context.price(current.tier);
    const to = context.price(tier.choice);
    if (
      from &&
      to &&
      switchPaysOff({
        contextTokens: context.contextTokens,
        current: from,
        next: to,
        remainingTurns: context.remainingTurns,
      })
    ) {
      nextTier = tier.choice;
    }
  }

  // A tier change starts a new cache anyway, so effort can follow it freely.
  const cacheLost = nextTier !== current.tier;
  let nextEffort = current.effort;
  const effortMove = effortRank(wantedEffort) - effortRank(current.effort);
  if (effortMove > 0 && effort.confidence >= config.upgradeMinConfidence) {
    nextEffort = wantedEffort;
  } else if (effortMove < 0 && downAllowed(effort.confidence)) {
    const price = context.price(nextTier);
    const saving = context.effortSaving?.(current.effort, wantedEffort) ?? 0;
    if (
      cacheLost ||
      (price &&
        switchPaysOff({
          contextTokens: context.contextTokens,
          current: price,
          next: price,
          remainingTurns: context.remainingTurns,
          extraSavingPerTurn: saving,
        }))
    ) {
      nextEffort = wantedEffort;
    }
  }

  const target: Target = { tier: nextTier, effort: nextEffort };
  if (nextTier === current.tier && nextEffort === current.effort) return keep("no change");
  const parts: string[] = [];
  if (nextTier !== current.tier) parts.push(`tier ${current.tier}->${nextTier}`);
  if (nextEffort !== current.effort) parts.push(`effort ${current.effort}->${nextEffort}`);
  return { target, reason: parts.join(", ") };
}
