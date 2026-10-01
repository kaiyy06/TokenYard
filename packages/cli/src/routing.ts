import { createDecider, type Decider, providers } from "@tokenyard/decider";
import {
  createClassifier,
  createRouter,
  createSessionStore,
  type PricingTable,
  type Router,
  type RoutingSettings,
} from "@tokenyard/gateway";

export type MakeDecider = (options: {
  baseURL: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}) => Decider;

export const defaultMakeDecider: MakeDecider = (options) => createDecider(options);

export interface BuiltRouter {
  readonly router?: Router;
  /** Anything the user should know, such as why routing could not start. */
  readonly notes: readonly string[];
}

/**
 * Builds the router from the settings. If the decider cannot be set up (for example, its API key
 * is missing) routing is left off and traffic passes through, rather than failing to start.
 */
export function buildRouter(
  settings: RoutingSettings,
  pricing: PricingTable,
  env: Readonly<Record<string, string | undefined>>,
  makeDecider: MakeDecider = defaultMakeDecider,
): BuiltRouter {
  if (settings.mode === "off") return { notes: [] };

  const preset = providers[settings.decider.provider];
  const keyName = settings.decider.apiKeyEnv ?? preset.apiKeyEnv;
  const apiKey = keyName ? env[keyName] : undefined;
  if (keyName && !apiKey) {
    return { notes: [`routing is off: ${keyName} is not set, so there is no decider to ask`] };
  }

  const decider = makeDecider({
    baseURL: settings.decider.baseUrl ?? preset.baseURL,
    model: settings.decider.model ?? preset.defaultModel,
    ...(apiKey !== undefined && { apiKey }),
    timeoutMs: settings.decider.timeoutMs,
  });
  const router = createRouter({
    config: {
      mode: settings.mode,
      tiers: settings.tiers,
      policy: settings.policy,
      expectedRemainingTurns: settings.expectedRemainingTurns,
    },
    sessions: createSessionStore(),
    pricing,
    classify: createClassifier(decider, {
      maxChars: settings.decider.maxChars,
      includeToolNames: settings.decider.includeToolNames,
      timeoutMs: settings.decider.timeoutMs,
    }),
  });
  const how =
    settings.mode === "shadow" ? "shadow mode: decisions are logged, not applied" : "routing is on";
  return { router, notes: [`${how} (decider ${decider.model})`] };
}
