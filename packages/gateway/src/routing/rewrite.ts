import type { ApiKind } from "./request.js";
import { inspectRequest } from "./request.js";
import type { Effort, Target } from "./types.js";

/** The effort word each API uses for a level. */
const WIRE_EFFORT: Record<ApiKind, Record<Effort, string>> = {
  "anthropic-messages": { none: "low", low: "low", medium: "medium", high: "high" },
  "openai-responses": { none: "minimal", low: "low", medium: "medium", high: "high" },
  "openai-chat": { none: "minimal", low: "low", medium: "medium", high: "high" },
};

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns the request body with the routed model, and the effort where the agent already set
 * one. Everything else is left exactly as sent. Returns undefined when the body cannot be
 * safely rewritten, in which case the original bytes should be forwarded.
 */
export function rewriteRequest(
  path: string,
  body: Buffer,
  model: string,
  target: Target,
): Buffer | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isObj(json)) return undefined;
  const shape = inspectRequest(path, json);
  if (!shape) return undefined;

  json.model = model;
  const effort = WIRE_EFFORT[shape.api][target.effort];
  if (shape.api === "anthropic-messages") {
    const config = json.output_config;
    if (isObj(config) && typeof config.effort === "string") config.effort = effort;
  } else if (shape.api === "openai-responses") {
    const reasoning = json.reasoning;
    if (isObj(reasoning) && typeof reasoning.effort === "string") reasoning.effort = effort;
  } else if (typeof json.reasoning_effort === "string") {
    json.reasoning_effort = effort;
  }
  return Buffer.from(JSON.stringify(json));
}
