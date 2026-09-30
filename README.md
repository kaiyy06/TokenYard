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

## Try it (usage tracking only)

```sh
pnpm install && pnpm build
node packages/cli/dist/cli.mjs start
node packages/cli/dist/cli.mjs stats
```

See [packages/cli](packages/cli/README.md).

## Roadmap

- [ ] `@tokenyard/decider`: a typed client for the `/v1/systemone` decision API
- [x] Pass-through gateway (Anthropic and OpenAI formats) with usage tracking
- [ ] Cache-aware routing policy with a shadow mode
- [ ] `tokenyard init` for Claude Code, Codex and OpenCode
- [ ] Public, reproducible benchmark

## License

[Apache-2.0](LICENSE)
