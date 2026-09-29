# @tokenyard/recorder

A small recording proxy used to capture real coding-agent traffic as test fixtures for the
gateway. It is a development tool and is not published.

## Record

```sh
pnpm record                                   # Anthropic, listens on 127.0.0.1:8788
pnpm record --upstream https://api.openai.com --port 8789
```

Point the agent at the printed URL, for example:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8788 claude
```

Each request/response exchange is written to `captures/<timestamp>/NNNN-<method>-<path>.json`
with the request body, the response bytes, and the size and arrival time of every chunk.
Responses stream back to the agent chunk by chunk as they arrive. The only change in transit is
`accept-encoding: identity`, so bodies are stored uncompressed.

Credential headers (`authorization`, `x-api-key`, cookies, anything named like a key or token)
are redacted before anything is written. Only the scheme and key kind survive, e.g.
`Bearer sk-ant-oat01-[redacted]`.

**Raw captures contain full prompts, code and tool output.** `captures/` is ignored by git;
never commit it.

## Scrub

```sh
pnpm scrub captures/<timestamp> --out fixtures/claude-code/<scenario>
```

Scrubbing turns captures into fixtures that are safe to commit. It works from allowlists and
fails closed:

- A string survives only when its key is protocol structure: `type`, `role`, `model`, `name`,
  ids, stop reasons and similar. Every other string, including prompts, system prompts, tool
  descriptions, tool inputs, tool results, thinking and signatures, becomes
  `[scrubbed N chars]`. Numbers and booleans (token counts, `max_tokens`) are kept.
- Identifying values (`metadata.user_id`, session and organization ids, unknown headers) are
  replaced with format-preserving pseudonyms that stay consistent within one scrub run.
- Event streams are split into events, each timed by the chunk that completed it.
- The scrub fails if anything that looks like a credential is left.

Review a fixture before committing it.
