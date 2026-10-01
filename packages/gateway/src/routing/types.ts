/** The three model tiers a request can be routed to, cheapest first. */
export const TIERS = ["fast", "standard", "frontier"] as const;
export type Tier = (typeof TIERS)[number];

/** How much reasoning a step gets, lowest first. */
export const EFFORTS = ["none", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** A model tier together with a reasoning effort. */
export interface Target {
  readonly tier: Tier;
  readonly effort: Effort;
}

/** What the decider said about one user turn. */
export interface Signals {
  readonly tier: { readonly choice: Tier; readonly confidence: number };
  /** A probability-weighted level from 0 to 3, so it can fall between levels. */
  readonly effort: { readonly score: number; readonly confidence: number };
  /** Probability that this turn starts a new, unrelated task. */
  readonly taskChanged: number;
}

export interface PolicyConfig {
  readonly upgradeMinConfidence: number;
  readonly downgradeMinConfidence: number;
  readonly taskChangedThreshold: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  upgradeMinConfidence: 0.5,
  downgradeMinConfidence: 0.75,
  taskChangedThreshold: 0.7,
};

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

export function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}
