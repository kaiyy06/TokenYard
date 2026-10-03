# TokenYard

> **Status: pre-alpha.** Under active development. Not ready for use yet.

TokenYard is a local gateway for coding agents such as Claude Code, Codex CLI and
OpenCode. It uses small, cheap **decision models** (for example TypeSafe Jev or
the open-weight Kev) to send each task to the cheapest model and reasoning effort
that can handle it, and it shows you exactly how much you saved.

## How it will work

```
coding agent ──► tokenyard (localhost) ──► your model provider
                     │
                     └── asks a decision model: which tier? how much effort? new task?
```

- **Fails open.** If anything goes wrong, requests pass through unchanged.
- **Protects the prompt cache.** It never switches models mid-task in a way that
  costs more than it saves.
- **Shadow mode.** See what TokenYard would do before you let it change anything.
- **Local and private.** It binds to `127.0.0.1`, stores no API keys and logs no
  prompt content by default. It can use a fully local decider (Kev).

## Try it

```sh
pnpm install && pnpm build
alias tokenyard="node $PWD/packages/cli/dist/cli.mjs"
tokenyard init        # points Claude Code, Codex and OpenCode at the gateway (undo: --undo)
tokenyard start       # in a second terminal
tokenyard doctor      # checks the setup
tokenyard stats       # after using an agent for a while
```

Or run it in a container: see [docs/docker.md](docs/docker.md).

See [packages/cli](packages/cli/README.md).

## Try routing in shadow mode

Routing is off until you add `~/.tokenyard/config.yaml`. The smallest useful one:

```yaml
mode: shadow   # shadow logs what it would do; route applies it; off passes everything through
```

Set `OPENROUTER_API_KEY` (the default decider is TypeSafe Jev through OpenRouter), start the
gateway and use your agent as usual. Then run `tokenyard stats` to see which model and effort
each task would have used, how long the decider took, and an estimate of what routing would
have saved. In shadow mode requests are forwarded exactly as the agent sent them.

Every setting, with its default:

```yaml
mode: shadow
decider:
  provider: openrouter          # or typesafe, kev-local
  # model, base_url and api_key_env default from the provider
  timeout_ms: 800               # past this the request goes through unchanged
  send: { max_chars: 4000, include_tool_names: true }
policy:
  upgrade_min_confidence: 0.5   # moving to a bigger model or more effort
  downgrade_min_confidence: 0.75
  task_changed_threshold: 0.7   # moving down needs a new task as well
  expected_remaining_turns: 8   # how long a session is assumed to continue
tiers:
  anthropic: { fast: claude-haiku-4-5, standard: claude-sonnet-5-5, frontier: claude-opus-5-5 }
  # openai has no default; set fast, standard and frontier to route OpenAI traffic
```

A request is only routed when the model it asks for is one of the tier models. Anything else
is treated as a choice the user made and left alone, as are the agent's own cheap-tier calls.

## Roadmap

- [x] `@tokenyard/decider`: a typed client for the `/v1/systemone` decision API
- [x] Pass-through gateway (Anthropic and OpenAI formats) with usage tracking
- [x] Cache-aware routing policy with a shadow mode
- [x] `tokenyard init` and `tokenyard doctor` for Claude Code, Codex and OpenCode
- [x] Docker image
- [ ] Public, reproducible benchmark

## License

[Apache-2.0](LICENSE)
