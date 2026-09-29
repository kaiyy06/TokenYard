# @tokenyard/decider

A small, typed client for **System One decision models** such as TypeSafe Jev,
Kev and Upstage Solar Decide. They share one API: you send a `state` and some
typed questions to `POST /v1/systemone`, and you get back typed answers with
probabilities.

It's built for hot paths:

- **It never throws.** Every call resolves to `{ ok: true, decision }` or
  `{ ok: false, error }`, so you can always fall back to a default.
- **It makes one attempt within a strict time budget** (1 s by default). It
  doesn't retry quietly and keep your request waiting.
- **It validates every answer** against the question you asked. A malformed or
  mismatched response is reported as an error and never passed on.
- **Answers are fully typed.** Choice labels are inferred from your criteria.
- It has one dependency ([zod](https://zod.dev)) and works with any provider
  that speaks `/v1/systemone`, including a local Kev server.

## Install

```sh
npm install @tokenyard/decider
```

Requires Node.js 22.5 or later.

## Usage

```ts
import { createDecider, providers } from "@tokenyard/decider";

const decider = createDecider({
  baseURL: providers.openrouter.baseURL,
  model: providers.openrouter.defaultModel, // "typesafe/jev-1.13"
  apiKey: process.env.OPENROUTER_API_KEY,
  timeoutMs: 800,
});

const result = await decider.decide({
  state: "Rename the `userId` variable to `accountId` in src/auth.ts",
  questions: {
    tier: {
      type: "choice",
      instructions: "Which model tier can complete this coding step well?",
      criteria: {
        fast: "Trivial edits, lookups, renames",
        standard: "Typical feature work and bug fixes",
        frontier: "Architecture, hard debugging, ambiguous specs",
      },
    },
    newTask: { type: "noul", instructions: "Is this a new, unrelated task?" },
  },
});

if (result.ok) {
  result.decision.answers.tier.choice; // "fast" | "standard" | "frontier"
  result.decision.answers.newTask.noul; // probability of yes, 0 to 1
} else {
  // result.error.kind is "timeout", "network", "http", "invalid_response", ...
  // fall back to your default
}
```

## Question types

| Type | You provide | You get back |
|---|---|---|
| `noul` | `instructions` | `noul`: the probability of yes |
| `choice` | `criteria`: labels mapped to descriptions | `choice`, `confidence`, `probabilities` |
| `score` | `criteria`: ordered levels, lowest first | `score` (probability-weighted level), `confidence`, `probabilities` |

## Providers

| Preset | Base URL | Default model | API key |
|---|---|---|---|
| `openrouter` | `https://openrouter.ai/api/v1` | `typesafe/jev-1.13` | `OPENROUTER_API_KEY` |
| `typesafe` | `https://api.typesafe.ai/v1` | `jev-1.13` | `TYPESAFE_API_KEY` |
| `kev-local` | `http://127.0.0.1:8009/v1` | `kev-latest` | none |

To use Kev locally with no API key, run
[jaredpalmer/kev](https://github.com/jaredpalmer/kev):

```sh
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

## Errors

| `kind` | Meaning |
|---|---|
| `invalid_request` | The questions are malformed, so nothing was sent |
| `timeout` | The time budget ran out |
| `aborted` | Your `signal` aborted the call |
| `network` | The connection failed |
| `http` | The provider returned a non-2xx status (see `status`) |
| `invalid_response` | The answers don't match the questions you asked |

Every error includes `latencyMs`.

## License

Apache-2.0
