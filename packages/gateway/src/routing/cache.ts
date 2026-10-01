import type { ModelPrice } from "../pricing.js";

export interface SwitchInput {
  /** Tokens already sitting in the prompt cache for this session. */
  readonly contextTokens: number;
  readonly current: ModelPrice;
  /** The price after the switch; equal to `current` when only the effort changes. */
  readonly next: ModelPrice;
  /** How many more turns the session is expected to run. */
  readonly remainingTurns: number;
  /** Extra dollars saved on every turn beyond the cached-input difference, such as fewer reasoning tokens. */
  readonly extraSavingPerTurn?: number;
}

/** Writing a prompt into the cache again costs at least the plain input price. */
function rewritePrice(price: ModelPrice): number {
  return Math.max(price.cacheWrite, price.input);
}

/** What one more turn costs if the cache is kept, for the context alone. */
export function stayCost(input: SwitchInput): number {
  return input.contextTokens * input.current.cacheRead;
}

/** What the first turn after a switch costs for the context alone: the cache starts over. */
export function switchCost(input: SwitchInput): number {
  return input.contextTokens * rewritePrice(input.next);
}

/** Dollars saved on each later turn, once the new model's cache is warm. */
export function perTurnSaving(input: SwitchInput): number {
  const cached = input.contextTokens * (input.current.cacheRead - input.next.cacheRead);
  return cached + (input.extraSavingPerTurn ?? 0);
}

/**
 * True when switching down pays for itself: the saving on the remaining turns has to beat the
 * one-off cost of rebuilding the cache. Anything that cannot be priced is not worth it.
 */
export function switchPaysOff(input: SwitchInput): boolean {
  const numbers = [
    input.contextTokens,
    input.remainingTurns,
    input.current.cacheRead,
    input.next.cacheRead,
    input.next.input,
    input.next.cacheWrite,
  ];
  if (!numbers.every((n) => Number.isFinite(n) && n >= 0)) return false;
  // An empty cache has nothing to lose, so the switch is free.
  if (input.contextTokens === 0) return true;
  return perTurnSaving(input) * input.remainingTurns > switchCost(input) - stayCost(input);
}
