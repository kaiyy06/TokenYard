# tokenyard

A local gateway for coding agents that shows what they spend. Pre-alpha: it currently records
usage and passes requests through unchanged. Routing comes later.

```sh
tokenyard init           # point the agents you have installed at the gateway
tokenyard start          # listen on 127.0.0.1:8787
tokenyard doctor         # check that everything is wired up
tokenyard stats          # spend for the last 24 hours
```

`tokenyard init` edits each agent's own settings, so you do not need to set environment
variables by hand. To try an agent once without changing its settings:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude      # Claude Code
OPENAI_BASE_URL=http://127.0.0.1:8787/v1 codex       # Codex, with an API key
```

Use API keys. Subscription (OAuth) logins are not supported yet.

## Commands

`tokenyard start [--port 8787] [--anthropic-upstream <url>] [--openai-upstream <url>]`

Runs the gateway. `--host` changes the bind address (default `127.0.0.1`); use `0.0.0.0` only
inside a container. To send OpenAI-format traffic to another provider, set the upstream, for
example `--openai-upstream https://openrouter.ai/api`.

`tokenyard init [claude|codex|opencode|all] [--port 8787] [--undo] [--force] [--dry-run]`

Points agents at the gateway. With no name it configures every agent whose settings folder
exists. It changes only these settings and leaves the rest of each file alone:

| Agent | File | What it sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL` |
| Codex CLI | `~/.codex/config.toml` | `model_provider` and a `[model_providers.tokenyard]` table, in a marked block |
| OpenCode | `~/.config/opencode/opencode.json` | `provider.anthropic` and `provider.openai` `options.baseURL` |

The first time it changes a file it saves the original next to it as `<file>.tokenyard.bak`.
`--undo` removes only what init added. If a setting already points somewhere else, init stops
and says so; `--force` replaces it. `--dry-run` shows what would change. Files that are not
plain JSON (for example with comments) are never rewritten; edit those by hand. Codex needs
`OPENAI_API_KEY` set, since the provider reads its key from there.

`tokenyard doctor [--port 8787]`

Checks the Node version, `config.yaml`, the decider's API key (when routing is on), whether a
gateway is listening, and whether each agent points at it. Warnings are advice; it exits 1 only
when something is broken.

`tokenyard stats [--since 24h] [--json] [--export jsonl|csv]`

Prints requests, spend, tokens, cache hit rate and latency, with a row per model. `--since`
takes `30m`, `24h`, `7d`, `2w` or `all`. `--export` prints every record instead.

Data lives in `~/.tokenyard` (`usage.db`, `pricing.json`). Override with `--home` or
`$TOKENYARD_HOME`.

## Privacy

Nothing leaves your machine except the requests you send to your provider, and one fetch of the
public OpenRouter price list per day. Prompts and responses are not stored, only token counts.
