/**
 * Types for the System One decision API (`POST /v1/systemone`).
 *
 * Shapes follow the contract shared by TypeSafe Jev, Kev and Upstage Solar Decide:
 * a `state` plus named, typed questions in; typed answers with probabilities out.
 */

/** A JSON-compatible value. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Text, a JSON object or array, or `null`. Used for state, instructions and criteria. */
export type Entry = string | { [key: string]: JsonValue } | JsonValue[] | null;

/** A yes/no question. The answer is the probability of "yes". */
export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions?: Entry;
  /** Optional descriptions of the yes and no outcomes. */
  readonly criteria?: { readonly true?: Entry; readonly false?: Entry } | null;
}

/** Option labels mapped to their descriptions. */
export type ChoiceCriteria = { readonly [label: string]: Entry };

/** Select one of several named options. */
export interface ChoiceQuestion<C extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  readonly instructions?: Entry;
  readonly criteria: C;
}

/** Ordered rubric levels, lowest first. At least two levels. */
export type ScoreCriteria = readonly [Entry, Entry, ...Entry[]];

/** Rate on an ordered rubric. */
export interface ScoreQuestion<C extends ScoreCriteria = ScoreCriteria> {
  readonly type: "score";
  readonly instructions?: Entry;
  readonly criteria: C;
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

/** Questions keyed by the names their answers are returned under. */
export type Questions = { readonly [name: string]: Question };

export interface NoulAnswer {
  readonly type: "noul";
  /** Probability of "yes", from 0 to 1. */
  readonly noul: number;
}

export interface ChoiceAnswer<C extends ChoiceCriteria = ChoiceCriteria> {
  readonly type: "choice";
  /** The most likely label. */
  readonly choice: keyof C & string;
  /** How concentrated the distribution is, from 0 (uniform) to 1 (certain). */
  readonly confidence: number;
  /** Probability of each label. */
  readonly probabilities: { readonly [label in keyof C & string]: number };
}

export interface ScoreAnswer {
  readonly type: "score";
  /** Probability-weighted level; may fall between integer levels. */
  readonly score: number;
  /** How concentrated the distribution is, from 0 to 1. */
  readonly confidence: number;
  /** Probability of each level, keyed by level index. */
  readonly probabilities: { readonly [level: string]: number };
  /** Level descriptions keyed by level index, when the provider returns them. */
  readonly legend?: { readonly [level: string]: Entry };
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** The answer type for a given question, keeping choice labels typed. */
export type AnswerFor<Q extends Question> = Q extends NoulQuestion
  ? NoulAnswer
  : Q extends ChoiceQuestion<infer C>
    ? ChoiceAnswer<C>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : never;

export type Answers<Q extends Questions> = { readonly [K in keyof Q]: AnswerFor<Q[K]> };

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cost in USD, when the provider reports it (OpenRouter does). */
  readonly costUsd?: number;
}

export interface DecideRequest<Q extends Questions = Questions> {
  readonly state: Entry;
  readonly questions: Q;
  /** Overrides the client's default model for this call. */
  readonly model?: string;
}

export interface Decision<Q extends Questions = Questions> {
  /** The model that answered, as reported by the provider. */
  readonly model: string;
  readonly answers: Answers<Q>;
  readonly usage: Usage;
  /** Wall-clock time of the call in milliseconds. */
  readonly latencyMs: number;
}

export type DeciderErrorKind =
  /** The request was rejected before sending (for example, no questions). */
  | "invalid_request"
  /** The call exceeded its time budget. */
  | "timeout"
  /** The caller's signal aborted the call. */
  | "aborted"
  /** The connection failed. */
  | "network"
  /** The provider returned a non-2xx status. */
  | "http"
  /** The provider returned a body that does not match the request. */
  | "invalid_response";

export interface DeciderError {
  readonly kind: DeciderErrorKind;
  readonly message: string;
  /** HTTP status, for `http` errors. */
  readonly status?: number;
  readonly latencyMs: number;
}

/** A call never throws: it resolves to a decision or an error the caller can fall back on. */
export type DecideResult<Q extends Questions = Questions> =
  | { readonly ok: true; readonly decision: Decision<Q> }
  | { readonly ok: false; readonly error: DeciderError };
