import { describe, expectTypeOf, it } from "vitest";
import { createDecider } from "../src/index.js";

describe("answer types", () => {
  it("infers choice labels and answer shapes from an inline request", async () => {
    const decider = createDecider({ baseURL: "http://127.0.0.1:1/v1", model: "m", timeoutMs: 1 });
    const result = await decider.decide({
      state: "x",
      questions: {
        tier: { type: "choice", criteria: { fast: "Trivial", frontier: "Hard" } },
        newTask: { type: "noul" },
        effort: { type: "score", criteria: ["Low", "High"] },
      },
    });
    if (!result.ok) return;
    expectTypeOf(result.decision.answers.tier.choice).toEqualTypeOf<"fast" | "frontier">();
    expectTypeOf(result.decision.answers.newTask.noul).toEqualTypeOf<number>();
    expectTypeOf(result.decision.answers.effort.score).toEqualTypeOf<number>();
  });
});
