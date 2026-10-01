import { z } from "zod";
import type { RoutingMode, TierModels } from "./router.js";
import type { PolicyConfig } from "./types.js";

const tierModels = z
  .object({
    fast: z.string().min(1),
    standard: z.string().min(1),
    frontier: z.string().min(1),
  })
  .strict();

const unit = z.number().min(0).max(1);

/** The routing section of `~/.tokenyard/config.yaml`, as written by a person. */
const schema = z
  .object({
    mode: z.enum(["off", "shadow", "route"]).default("shadow"),
    decider: z
      .object({
        provider: z.enum(["openrouter", "typesafe", "kev-local"]).default("openrouter"),
        model: z.string().min(1).optional(),
        base_url: z.url().optional(),
        api_key_env: z.string().min(1).optional(),
        timeout_ms: z.number().int().positive().max(10_000).default(800),
        send: z
          .object({
            max_chars: z.number().int().positive().default(4000),
            include_tool_names: z.boolean().default(true),
          })
          .strict()
          .prefault({}),
      })
      .strict()
      .prefault({}),
    policy: z
      .object({
        upgrade_min_confidence: unit.default(0.5),
        downgrade_min_confidence: unit.default(0.75),
        task_changed_threshold: unit.default(0.7),
        expected_remaining_turns: z.number().int().positive().default(8),
      })
      .strict()
      .prefault({}),
    tiers: z
      .object({
        anthropic: tierModels.default({
          fast: "claude-haiku-4-5",
          standard: "claude-sonnet-5-5",
          frontier: "claude-opus-5-5",
        }),
        // No defaults: OpenAI model names change too often to guess.
        openai: tierModels.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export interface RoutingSettings {
  readonly mode: RoutingMode;
  readonly decider: {
    readonly provider: "openrouter" | "typesafe" | "kev-local";
    readonly model?: string;
    readonly baseUrl?: string;
    readonly apiKeyEnv?: string;
    readonly timeoutMs: number;
    readonly maxChars: number;
    readonly includeToolNames: boolean;
  };
  readonly policy: PolicyConfig;
  readonly expectedRemainingTurns: number;
  readonly tiers: { readonly anthropic: TierModels; readonly openai?: TierModels };
}

/** Settings used when there is no config file: routing stays off and traffic passes through. */
export const DEFAULT_SETTINGS: RoutingSettings = parseRoutingSettings({ mode: "off" });

/** Validates a parsed config file. Throws one readable error that lists every problem. */
export function parseRoutingSettings(input: unknown): RoutingSettings {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid config:\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  return {
    mode: c.mode,
    decider: {
      provider: c.decider.provider,
      ...(c.decider.model !== undefined && { model: c.decider.model }),
      ...(c.decider.base_url !== undefined && { baseUrl: c.decider.base_url }),
      ...(c.decider.api_key_env !== undefined && { apiKeyEnv: c.decider.api_key_env }),
      timeoutMs: c.decider.timeout_ms,
      maxChars: c.decider.send.max_chars,
      includeToolNames: c.decider.send.include_tool_names,
    },
    policy: {
      upgradeMinConfidence: c.policy.upgrade_min_confidence,
      downgradeMinConfidence: c.policy.downgrade_min_confidence,
      taskChangedThreshold: c.policy.task_changed_threshold,
    },
    expectedRemainingTurns: c.policy.expected_remaining_turns,
    tiers: {
      anthropic: c.tiers.anthropic,
      ...(c.tiers.openai && { openai: c.tiers.openai }),
    },
  };
}
