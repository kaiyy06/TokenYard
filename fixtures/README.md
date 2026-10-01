# Fixtures

Scrubbed request/response exchanges in the format written by `pnpm scrub` (see
`packages/recorder`). The gateway's golden tests replay every `*.json` fixture found here
through the gateway and check that:

- the request reaches the upstream byte for byte,
- the response comes back byte for byte,
- the usage the gateway records matches `expected.json`, when the directory has one.

`expected.json` maps a fixture file name to the token counts it should produce.

## synthetic/

Hand-written to match the documented wire formats of the Anthropic Messages API and the
OpenAI Chat Completions and Responses APIs. They cover the parsing paths (streamed and plain
bodies, cached tokens) but are not recordings of a real agent.

## claude-code/session-1/

Recorded from a real Claude Code session and scrubbed, then cut down to six representative
exchanges: the connectivity check (`HEAD`), a rate-limit `429`, a short reply, a small call, a
reply that ends in a tool call, and a long stream of about 545 events. Their token counts in
`expected.json` were read straight from the recorded usage fields.

## codex/session-1/

Recorded from a real Codex CLI session signed in with ChatGPT, through a custom model
provider pointed at the recorder, and scrubbed. Four exchanges: the model list (`GET /models`),
a short reply, a reply with reasoning, and a reply that ends in a tool call. Codex posts to
`/responses` with no `/v1` prefix and its streams carry no `content-type`, so both are covered
here. Token counts in `expected.json` come from the recorded `response.completed` usage, with
cached tokens split out of the input total.

Recorded fixtures go in `fixtures/<agent>/<scenario>/`, produced with
`pnpm record` followed by `pnpm scrub`. Review each one before committing: check for names,
paths and anything else personal, and keep only a few representative exchanges.
