# tokenyard

A local gateway for coding agents that shows what they spend. Pre-alpha: it currently records
usage and passes requests through unchanged. Routing comes later.

```sh
tokenyard start          # listen on 127.0.0.1:8787
tokenyard stats          # spend for the last 24 hours
```

Point an agent at it:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude      # Claude Code
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex       # Codex, with an API key
```

Use API keys. Subscription (OAuth) logins are not supported yet.

## Commands

`tokenyard start [--port 8787] [--anthropic-upstream <url>] [--openai-upstream <url>]`

Runs the gateway. To send OpenAI-format traffic to another provider, set the upstream, for
example `--openai-upstream https://openrouter.ai/api`.

`tokenyard stats [--since 24h] [--json] [--export jsonl|csv]`

Prints requests, spend, tokens, cache hit rate and latency, with a row per model. `--since`
takes `30m`, `24h`, `7d`, `2w` or `all`. `--export` prints every record instead.

Data lives in `~/.tokenyard` (`usage.db`, `pricing.json`). Override with `--home` or
`$TOKENYARD_HOME`.

## Privacy

Nothing leaves your machine except the requests you send to your provider, and one fetch of the
public OpenRouter price list per day. Prompts and responses are not stored, only token counts.
