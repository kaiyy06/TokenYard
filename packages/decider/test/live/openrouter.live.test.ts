/**
 * Live calls to System One decision models on OpenRouter. Excluded from `pnpm test`;
 * run with `pnpm test:live` and OPENROUTER_API_KEY set. Each call costs a few
 * millionths of a dollar.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createDecider, providers } from "../../src/index.js";

/** Only decision models may be called with the key. Never add chat or completion models. */
const DECISION_MODELS = [
  "typesafe/jev-1.13",
  "upstage/solar-decide",
  "jaredpalmer/kev-4b",
] as const;

const apiKey = process.env.OPENROUTER_API_KEY;

/** Confirms from OpenRouter's public catalog that the model returns decisions, not text. */
async function assertDecisionModel(model: string): Promise<void> {
  const response = await fetch(`https://openrouter.ai/api/v1/models/${model}/endpoints`);
  if (!response.ok) throw new Error(`could not look up ${model}: HTTP ${response.status}`);
  const { data } = (await response.json()) as {
    data?: { architecture?: { modality?: string; output_modalities?: string[] } };
  };
  const architecture = data?.architecture;
  const isDecision =
    architecture?.modality === "text->decisions" &&
    architecture.output_modalities?.length === 1 &&
    architecture.output_modalities[0] === "decisions";
  if (!isDecision) {
    throw new Error(
      `refusing to call ${model}: modality is ${architecture?.modality ?? "unknown"}`,
    );
  }
}

describe.skipIf(!apiKey)("OpenRouter decision models (live)", () => {
  beforeAll(async () => {
    await Promise.all(DECISION_MODELS.map(assertDecisionModel));
  });

  it.each(DECISION_MODELS)("%s answers noul, choice and score questions", async (model) => {
    const decider = createDecider({
      baseURL: providers.openrouter.baseURL,
      model,
      apiKey: apiKey as string,
      timeoutMs: 15_000,
    });

    const result = await decider.decide({
      state: "User: rename the variable `userId` to `accountId` in src/auth.ts",
      questions: {
        tier: {
          type: "choice",
          instructions: "Which model tier can complete this coding step well?",
          criteria: {
            fast: "Trivial edits, lookups, renames, formatting",
            standard: "Typical feature work, bug fixes, tests",
            frontier: "Architecture, hard debugging, ambiguous specs",
          },
        },
        newTask: { type: "noul", instructions: "Is this a request to change code?" },
        effort: {
          type: "score",
          instructions: "How much reasoning does this step need?",
          criteria: ["None", "Low", "Medium", "High"],
        },
      },
    });

    if (!result.ok) throw new Error(`${result.error.kind}: ${result.error.message}`);
    const { answers, usage, latencyMs } = result.decision;
    console.info(
      `${model}: tier=${answers.tier.choice} (${answers.tier.confidence.toFixed(2)}) ` +
        `code-change=${answers.newTask.noul.toFixed(2)} effort=${answers.effort.score.toFixed(2)} ` +
        `tokens=${usage.inputTokens} cost=$${usage.costUsd ?? "n/a"} ${latencyMs.toFixed(0)}ms`,
    );

    expect(["fast", "standard", "frontier"]).toContain(answers.tier.choice);
    expect(answers.newTask.noul).toBeGreaterThanOrEqual(0);
    expect(answers.effort.score).toBeLessThanOrEqual(3);
    expect(usage.inputTokens).toBeGreaterThan(0);
  });
});
