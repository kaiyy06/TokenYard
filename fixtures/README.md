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

Recorded fixtures go in `fixtures/<agent>/<scenario>/`, produced with
`pnpm record` followed by `pnpm scrub`. Review each one before committing.
