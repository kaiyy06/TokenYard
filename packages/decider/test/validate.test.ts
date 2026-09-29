import { describe, expect, it } from "vitest";
import type { Questions } from "../src/index.js";
import { validateRequest, validateResponse } from "../src/validate.js";

const questions = {
  refund: { type: "noul", instructions: "Is the customer asking for money back?" },
  team: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: { billing: "Charges and refunds", technical: "Bugs and outages" },
  },
  severity: { type: "score", criteria: ["Cosmetic", "Degraded", "Blocking"] },
} as const satisfies Questions;

const validBody = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    refund: { type: "noul", noul: 0.98 },
    team: {
      type: "choice",
      choice: "billing",
      confidence: 0.9,
      probabilities: { billing: 0.95, technical: 0.05 },
    },
    severity: {
      type: "score",
      score: 1.2,
      confidence: 0.7,
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.3 },
      legend: { "0": "Cosmetic", "1": "Degraded", "2": "Blocking" },
    },
  },
  usage: { input_tokens: 275, output_tokens: 20, cost: 0.00003 },
};

function withAnswer(name: string, answer: unknown) {
  return { ...validBody, answers: { ...validBody.answers, [name]: answer } };
}

describe("validateRequest", () => {
  it("accepts well-formed questions", () => {
    expect(validateRequest({ state: "x", questions })).toBeUndefined();
  });

  it("rejects an empty question set", () => {
    expect(validateRequest({ state: "x", questions: {} })).toMatch(/at least one question/);
  });

  it("rejects a choice with fewer than two options", () => {
    const result = validateRequest({
      state: "x",
      questions: { pick: { type: "choice", criteria: { only: null } } },
    });
    expect(result).toMatch(/at least two options/);
  });

  it("rejects a score with fewer than two levels", () => {
    const result = validateRequest({
      state: "x",
      questions: { rate: { type: "score", criteria: ["one"] as never } },
    });
    expect(result).toMatch(/at least two levels/);
  });
});

describe("validateResponse", () => {
  it("returns typed answers and maps usage", () => {
    const result = validateResponse(questions, validBody);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("typesafe/jev-1.13-20260917");
    expect(result.value.answers.refund.noul).toBe(0.98);
    expect(result.value.answers.team.choice).toBe("billing");
    expect(result.value.answers.severity.score).toBe(1.2);
    expect(result.value.usage).toEqual({ inputTokens: 275, outputTokens: 20, costUsd: 0.00003 });
  });

  it("defaults usage to zero when the provider omits it", () => {
    const { usage: _, ...body } = validBody;
    const result = validateResponse(questions, body);
    expect(result.ok && result.value.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    ["a non-object body", "nope", /malformed/],
    [
      "a missing answer",
      { ...validBody, answers: { refund: validBody.answers.refund } },
      /missing/,
    ],
    [
      "a mismatched answer type",
      withAnswer("refund", { type: "choice", choice: "a", confidence: 1, probabilities: {} }),
      /expected "noul"/,
    ],
    ["a probability above one", withAnswer("refund", { type: "noul", noul: 1.5 }), /malformed/],
    [
      "an unknown choice label",
      withAnswer("team", { type: "choice", choice: "sales", confidence: 1, probabilities: {} }),
      /unknown option "sales"/,
    ],
    [
      "a probability for an unknown label",
      withAnswer("team", {
        type: "choice",
        choice: "billing",
        confidence: 1,
        probabilities: { billing: 0.5, sales: 0.5 },
      }),
      /unknown "sales"/,
    ],
    [
      "a score above the top level",
      withAnswer("severity", { type: "score", score: 3, confidence: 1, probabilities: {} }),
      /exceeds 2/,
    ],
  ])("rejects %s", (_label, body, message) => {
    const result = validateResponse(questions, body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});
