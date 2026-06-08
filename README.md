# codex-honcho

Persistent memory for [OpenAI Codex](https://developers.openai.com/codex) sessions, backed by [Honcho](https://honcho.dev).

A harness-level integration: Codex lifecycle hooks feed every turn into Honcho and surface relevant context back at prompt time, so the model remembers across sessions. Sibling to [`claude-honcho`](https://github.com/plastic-labs/claude-honcho) — same memory backend, different harness.

## What it does

```
┌─ Codex session ──────────────────────────────────────────────┐
│                                                               │
│  SessionStart ──▶ recall    ──▶ inject context + dialectic    │
│  UserPromptSubmit ─▶ prompt  ──▶ inject prompt-relevant memory │
│  PostToolUse  ──▶ observe   ──▶ record tool activity          │
│  Stop / PreCompact ─▶ writeback ─▶ ship new turns to Honcho    │
│                                                               │
└───────────────────────────┬───────────────────────────────────┘
                            │  reads/writes
                  ┌─────────▼──────────┐      ┌────────────────────┐
                  │  Honcho API (SDK)  │      │  Honcho hosted MCP  │
                  │  context · messages│      │  mcp.honcho.dev     │
                  └────────────────────┘      │  search · chat · …  │
                                              └────────────────────┘
```

- **Read path** — `recall` (SessionStart) and `prompt` (UserPromptSubmit) print a `<honcho-memory>` block to stdout, which Codex injects as context. `recall` also fires bounded dialectic reasoning to keep Honcho's model of you sharp, and re-runs after compaction.
- **Write path** — `writeback` runs on every `Stop` (Codex is turn-scoped; there's no SessionEnd) and on `PreCompact`. It reads the session rollout and ships only the turns added since the last cursor — no daemon, no duplicates.
- **Active recall** — the hosted Honcho MCP (`mcp.honcho.dev`) is registered in Codex so the model can `search` / `chat` / `get_context` on demand. A bundled `honcho-memory` skill tells it when to.

## Requirements

- [Codex CLI](https://developers.openai.com/codex) with hooks support
- [bun](https://bun.sh)
- A Honcho API key — via the [Honcho CLI](https://honcho.dev): `uv tool install honcho-cli && honcho init` (writes `~/.honcho/config.json`), or `export HONCHO_API_KEY=hch-…`
- `npx` on PATH (the MCP registration uses `mcp-remote`)

## Install

```bash
git clone https://github.com/plastic-labs/codex-honcho
cd codex-honcho
./install.sh
```

Or manually:

```bash
bun install
bun run bin/codex-honcho.ts install
```

Then restart Codex. Check state any time:

```bash
bun run bin/codex-honcho.ts status
bun run bin/codex-honcho.ts remove   # clean uninstall
```

## What install writes

| Path | Change |
|---|---|
| `~/.codex/hooks.json` | adds the codex-honcho hook entries (merged, never clobbers yours) |
| `~/.codex/config.toml` | sets `[features].hooks = true` and registers `[mcp_servers.honcho]` |
| `~/.codex/skills/honcho-memory/` | installs the active-recall skill |

`remove` strips exactly these and leaves everything else intact.

## Configuration

codex-honcho reads `~/.honcho/config.json` (shared with the other Honcho integrations). Codex-specific settings live under `hosts.codex`; root fields are the fallback.

```json
{
  "apiKey": "hch-…",
  "peerName": "eri",
  "hosts": {
    "codex": {
      "workspace": "codex",
      "aiPeer": "codex",
      "reasoningLevel": "low",
      "saveMessages": true,
      "enabled": true,
      "sessionStrategy": "per-directory"
    }
  }
}
```

`sessionStrategy` controls how Honcho session names are derived:

- `per-directory` (default) — one session per project dir (`groudon`)
- `git-branch` — one per branch (`groudon-main`); falls back to the dir outside a repo
- `chat-instance` — one per Codex conversation (`groudon-019ea7df`)

Env overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`.

## Layout

```
bin/codex-honcho.ts      CLI: install · remove · status · <hook-verb>
src/transcript/codex.ts  Codex rollout (.jsonl) reader
src/connectors/          installs hooks · MCP server · skill into ~/.codex
src/hooks/               recall · prompt · observe · writeback
src/cursor.ts            per-turn writeback delta tracker
src/config.ts            resolves the `codex` host from ~/.honcho/config.json
skills/honcho-memory/    active-recall guidance for the model
```

## Development

```bash
bun test          # unit suite
bun run typecheck
```

## License

MIT © Plastic Labs
