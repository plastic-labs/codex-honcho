# codex-honcho

Persistent memory for [OpenAI Codex](https://developers.openai.com/codex) sessions, backed by [Honcho](https://honcho.dev).

A harness-level integration: Codex lifecycle hooks feed every turn into Honcho and surface relevant context back at prompt time, so the model remembers across sessions. Sibling to [`claude-honcho`](https://github.com/plastic-labs/claude-honcho) — same memory backend, different harness.

## Status

Early. Building the harness adapter layer; the Honcho-side logic is shared with the Claude plugin.

## How it works

Codex exposes a hook system (`~/.codex/hooks.json`, gated behind `[features].hooks = true` in `~/.codex/config.toml`). codex-honcho wires four events:

| Event | Role |
|---|---|
| `SessionStart` | warm context, materialize the Honcho session |
| `UserPromptSubmit` | inject relevant memory ahead of the model |
| `PostToolUse` | record tool activity as observations |
| `Stop` | per-turn writeback of the conversation to Honcho |

Codex `Stop` is turn-scoped (there is no final `SessionEnd`), so writeback is incremental: each turn we read the new tail of the session rollout file and ship only the delta.

## Layout

```
src/
  transcript/   Codex rollout (.jsonl) reader
  connectors/   installs/removes the Codex hook + feature flag
  hooks/        the four hook handlers
  mcp/          Honcho memory tools exposed to Codex
```

## License

MIT © Plastic Labs
