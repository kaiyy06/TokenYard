/** The wire formats the router understands. Anything else is forwarded untouched. */
export type ApiKind = "anthropic-messages" | "openai-responses" | "openai-chat";

/** What routing needs to know about one inference request, read without changing it. */
export interface RequestShape {
  readonly api: ApiKind;
  readonly model: string;
  /** An id the agent supplied for its session, when it supplied one. */
  readonly sessionId?: string;
  /** The system prompt, used with the first user message to identify a session. */
  readonly systemText: string;
  readonly firstUserText: string;
  readonly lastUserText: string;
  /** True when the newest message is the user's own words, not a tool result. */
  readonly newUserTurn: boolean;
  readonly userTurns: number;
  /** Names of the most recent tool calls, newest last. */
  readonly recentTools: readonly string[];
  readonly toolErrors: number;
  /** The reasoning effort the agent asked for, as it wrote it. */
  readonly effort?: string;
  /** Rough size of the whole request in characters. */
  readonly sizeChars: number;
}

const RECENT_TOOLS = 8;

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Agents wrap their own notices in tags inside user messages; those are not the user's words. */
function isNotice(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

/** Joins the text parts of a message body that is either a string or a list of typed parts. */
function textOf(content: unknown): string {
  if (typeof content === "string") return isNotice(content) ? "" : content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = obj(part);
      const text = str(p?.text);
      return p && text !== undefined && !isNotice(text) ? text : "";
    })
    .filter((t) => t !== "")
    .join("\n");
}

function systemTextOf(system: unknown): string {
  return typeof system === "string" ? system : textOf(system);
}

/** The session id Claude Code embeds in `metadata.user_id`, which is JSON or `..._session_<id>`. */
function anthropicSessionId(metadata: unknown): string | undefined {
  const userId = str(obj(metadata)?.user_id);
  if (!userId) return undefined;
  try {
    const id = str(obj(JSON.parse(userId))?.session_id);
    if (id) return id;
  } catch {
    // Not JSON; try the older underscore form.
  }
  return /_session_([\w-]+)/.exec(userId)?.[1];
}

interface Walk {
  firstUser: string;
  lastUser: string;
  turns: number;
  tools: string[];
  errors: number;
  newestIsUser: boolean;
}

function emptyWalk(): Walk {
  return { firstUser: "", lastUser: "", turns: 0, tools: [], errors: 0, newestIsUser: false };
}

function noteUser(walk: Walk, text: string): void {
  if (text === "") return;
  walk.firstUser ||= text;
  walk.lastUser = text;
  walk.turns++;
}

function inspectAnthropic(body: Obj): RequestShape | undefined {
  const model = str(body.model);
  const messages = body.messages;
  if (!model || !Array.isArray(messages)) return undefined;
  const walk = emptyWalk();
  for (const raw of messages) {
    const message = obj(raw);
    if (!message) continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    if (message.role === "user") {
      const text = textOf(message.content);
      noteUser(walk, text);
      walk.newestIsUser = text !== "";
      for (const part of parts) {
        const p = obj(part);
        if (p?.type === "tool_result" && p.is_error === true) walk.errors++;
      }
    } else if (message.role === "assistant") {
      walk.newestIsUser = false;
      for (const part of parts) {
        const p = obj(part);
        if (p?.type === "tool_use" && str(p.name)) walk.tools.push(p.name as string);
      }
    }
  }
  const sessionId = anthropicSessionId(body.metadata);
  const effort = str(obj(body.output_config)?.effort);
  return finish(
    "anthropic-messages",
    model,
    systemTextOf(body.system),
    walk,
    body,
    sessionId,
    effort,
  );
}

function inspectResponses(body: Obj): RequestShape | undefined {
  const model = str(body.model);
  if (!model) return undefined;
  // `input` may be a plain string: a single user turn.
  const input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : body.input;
  if (!Array.isArray(input)) return undefined;
  const walk = emptyWalk();
  for (const raw of input) {
    const item = obj(raw);
    if (!item) continue;
    const type = str(item.type);
    if (type === "message" || (type === undefined && item.role !== undefined)) {
      if (item.role === "user") {
        const text = textOf(item.content);
        noteUser(walk, text);
        walk.newestIsUser = text !== "";
      } else if (item.role === "assistant") {
        walk.newestIsUser = false;
      }
    } else if (type === "function_call" || type === "custom_tool_call") {
      walk.newestIsUser = false;
      if (str(item.name)) walk.tools.push(item.name as string);
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      walk.newestIsUser = false;
    }
  }
  const meta = obj(body.client_metadata);
  const sessionId = str(body.prompt_cache_key) ?? str(meta?.session_id);
  const effort = str(obj(body.reasoning)?.effort);
  return finish(
    "openai-responses",
    model,
    str(body.instructions) ?? "",
    walk,
    body,
    sessionId,
    effort,
  );
}

function inspectChat(body: Obj): RequestShape | undefined {
  const model = str(body.model);
  const messages = body.messages;
  if (!model || !Array.isArray(messages)) return undefined;
  const walk = emptyWalk();
  let system = "";
  for (const raw of messages) {
    const message = obj(raw);
    if (!message) continue;
    if (message.role === "system" || message.role === "developer") {
      system ||= textOf(message.content);
    } else if (message.role === "user") {
      const text = textOf(message.content);
      noteUser(walk, text);
      walk.newestIsUser = text !== "";
    } else if (message.role === "assistant") {
      walk.newestIsUser = false;
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const name = str(obj(obj(call)?.function)?.name);
        if (name) walk.tools.push(name);
      }
    } else if (message.role === "tool") {
      walk.newestIsUser = false;
    }
  }
  return finish(
    "openai-chat",
    model,
    system,
    walk,
    body,
    str(body.prompt_cache_key),
    str(body.reasoning_effort),
  );
}

function finish(
  api: ApiKind,
  model: string,
  systemText: string,
  walk: Walk,
  body: Obj,
  sessionId: string | undefined,
  effort: string | undefined,
): RequestShape {
  return {
    api,
    model,
    ...(sessionId !== undefined && { sessionId }),
    systemText,
    firstUserText: walk.firstUser,
    lastUserText: walk.lastUser,
    newUserTurn: walk.newestIsUser,
    userTurns: walk.turns,
    recentTools: walk.tools.slice(-RECENT_TOOLS),
    toolErrors: walk.errors,
    ...(effort !== undefined && { effort }),
    sizeChars: JSON.stringify(body).length,
  };
}

/**
 * Reads the routing-relevant facts from a request body, or returns undefined for a path or
 * shape it does not recognize, in which case the request should be forwarded unchanged.
 */
export function inspectRequest(path: string, body: unknown): RequestShape | undefined {
  const root = obj(body);
  if (!root) return undefined;
  const pathname = path.split("?")[0] ?? "";
  if (pathname === "/v1/messages") return inspectAnthropic(root);
  if (pathname === "/v1/responses" || pathname === "/responses") return inspectResponses(root);
  if (pathname === "/v1/chat/completions") return inspectChat(root);
  return undefined;
}
