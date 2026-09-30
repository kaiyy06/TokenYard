# @tokenyard/gateway

A local pass-through gateway for coding agents. It forwards Anthropic and OpenAI requests
unchanged, streams responses back as they arrive, and records the tokens and cost of every
request.

```ts
import { createUsageRecorder, loadPricing, openSqliteStore, startGateway } from "@tokenyard/gateway";

const store = openSqliteStore("usage.db");
const pricing = await loadPricing({ cacheFile: "pricing.json" });

const gateway = await startGateway({
  port: 8787,
  onExchange: createUsageRecorder(store, pricing),
});
```

## What it does

- Binds to `127.0.0.1` only. Auth headers are passed through and never stored.
- Routes by path: `/v1/messages*` goes to Anthropic, `/v1/chat/completions` and
  `/v1/responses` to OpenAI. For shared paths such as `/v1/models` the credential header decides.
- Forwards request and response bytes untouched, including compressed bodies. Streams are never
  buffered.
- Reads token usage from a copy of each successful response, without delaying it: Anthropic
  streams, OpenAI chat completion streams (when the agent asks for usage), the Responses API,
  and plain JSON bodies, gzip, deflate or Brotli encoded.
- Reports each request to `onExchange`. Errors thrown there never affect traffic.

## Usage records

One row per inference request (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`): time,
provider, model asked for and model that answered, status, streaming or not, input, output and
cached tokens, cost, time to first byte, total time and any error. Token counts are normalized:
input never includes cached tokens.

Requests whose response carries no usage are still recorded, with empty token columns. OpenAI
chat completion streams only include usage when the agent sets `stream_options.include_usage`;
the gateway does not change requests to add it.

## Pricing

Prices come from OpenRouter's public model list, cached on disk for a day. Anthropic API ids
(`claude-haiku-4-5-20251001`) and OpenRouter ids (`anthropic/claude-haiku-4.5`) are matched after
normalizing. Cost is fixed when the request happens. A model with no known price is counted as
unpriced rather than guessed. Offline, the last cache is used, and with none, everything is
unpriced.

Prompt-size price tiers some models list are not applied, so very long prompts may be slightly
underpriced.

## Storage

Records go through the `UsageStore` interface. The default is SQLite via `node:sqlite`, which
Node marks experimental in v22; the schema is versioned and migrated on open.
