import { z } from "zod";
import type { Answer, Answers, DecideRequest, Question, Questions, Usage } from "./types.js";

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);

const noulWire = z.object({ type: z.literal("noul"), noul: probability });

const choiceWire = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: probability,
  probabilities,
});

const scoreWire = z.object({
  type: z.literal("score"),
  score: z.number().min(0),
  confidence: probability,
  probabilities,
  legend: z.record(z.string(), z.unknown()).optional(),
});

const answerWire = z.discriminatedUnion("type", [noulWire, choiceWire, scoreWire]);

const responseWire = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({
      input_tokens: z.number().int().min(0),
      output_tokens: z.number().int().min(0),
      cost: z.number().min(0).optional(),
    })
    .optional(),
});

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

/** Checks a request before it is sent, so malformed questions fail fast and locally. */
export function validateRequest(request: DecideRequest): string | undefined {
  const names = Object.keys(request.questions);
  if (names.length === 0) return "at least one question is required";

  for (const name of names) {
    if (name.length === 0) return "question names must be non-empty";
    const question = request.questions[name] as Question;
    if (question.type === "choice" && Object.keys(question.criteria).length < 2) {
      return `choice question "${name}" needs at least two options`;
    }
    if (question.type === "score" && question.criteria.length < 2) {
      return `score question "${name}" needs at least two levels`;
    }
  }
  return undefined;
}

function checkAnswer(name: string, question: Question, raw: unknown): Validation<Answer> {
  const parsed = answerWire.safeParse(raw);
  if (!parsed.success) return { ok: false, message: `answer "${name}" is malformed` };

  const answer = parsed.data;
  if (answer.type !== question.type) {
    return {
      ok: false,
      message: `answer "${name}" has type "${answer.type}", expected "${question.type}"`,
    };
  }

  if (answer.type === "choice" && question.type === "choice") {
    const labels = new Set(Object.keys(question.criteria));
    if (!labels.has(answer.choice)) {
      return { ok: false, message: `answer "${name}" chose unknown option "${answer.choice}"` };
    }
    const unknown = Object.keys(answer.probabilities).find((label) => !labels.has(label));
    if (unknown !== undefined) {
      return { ok: false, message: `answer "${name}" has a probability for unknown "${unknown}"` };
    }
  }

  if (answer.type === "score" && question.type === "score") {
    const maxLevel = question.criteria.length - 1;
    if (answer.score > maxLevel) {
      return { ok: false, message: `answer "${name}" score ${answer.score} exceeds ${maxLevel}` };
    }
  }

  return { ok: true, value: answer as Answer };
}

/** Parses a provider response and checks every answer against the question that was asked. */
export function validateResponse<Q extends Questions>(
  questions: Q,
  body: unknown,
): Validation<{ model: string; answers: Answers<Q>; usage: Usage }> {
  const parsed = responseWire.safeParse(body);
  if (!parsed.success) return { ok: false, message: "response body is malformed" };

  const answers: Record<string, Answer> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (!(name in parsed.data.answers)) {
      return { ok: false, message: `answer "${name}" is missing` };
    }
    const checked = checkAnswer(name, question, parsed.data.answers[name]);
    if (!checked.ok) return checked;
    answers[name] = checked.value;
  }

  const usage = parsed.data.usage;
  return {
    ok: true,
    value: {
      model: parsed.data.model,
      answers: answers as Answers<Q>,
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(usage?.cost !== undefined && { costUsd: usage.cost }),
      },
    },
  };
}
