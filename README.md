# codex-honcho

Harness-level [Honcho](https://honcho.dev) memory for [OpenAI Codex](https://developers.openai.com/codex). Codex lifecycle hooks capture each session to Honcho and inject relevant context at session start, so memory persists across conversations. Sibling to [`claude-honcho`](https://github.com/plastic-labs/claude-honcho) — same backend, Codex's hook system instead of Claude Code's.

## Design

Three properties of Codex's hook model drive the architecture:

- **Stop is turn-scoped; there is no `SessionEnd`.** Writeback runs every turn and ships only the rollout delta since a per-conversation cursor — not a session-end batch.
- **Codex ignores `async: true` and kills detached children when a hook returns.** Background uploads don't survive, so capture is local and the upload runs inline at turn end (`Stop` fires after the model responds, so it doesn't block the visible turn).
- **Hook stdout is injected as model-only context.** Memory is returned as a `hookSpecificOutput.additionalContext` block — fed to the model, not printed to the user.

No daemon, no sidecar DB. Capture writes a local append-only queue; flush drains it to the Honcho API. Active recall goes through Honcho's hosted MCP.

## Hooks

| Codex event | verb | behavior |
|---|---|---|
| `SessionStart` (`startup\|resume\|clear\|compact`) | `recall` | create/materialize the session; inject a lean `<honcho-memory>` context block |
| `UserPromptSubmit` | `prompt` | inject prompt-scoped context — **off by default** (`injectPerPrompt`); MCP tools cover depth |
| `PostToolUse` (`*`) | `observe` | append a one-line note for significant tool calls to the queue |
| `Stop`, `PreCompact` | `writeback` | capture the rollout delta to the queue, then flush inline |

## Write path

```
capture (writeback/observe)  →  ~/.honcho/codex/queue/<key>.jsonl   (append-only, local, instant)
flush (inline, end of turn)  →  drain pending → Honcho session.addMessages (chunked, 25/batch)
                             →  advance <key>.sent high-water-mark
```

Capture never hits the network. `flush` is lock-guarded and advances the sent marker per chunk, so a failed or partial upload stays queued and retries on the next turn. The queue is plain JSONL — inspectable with `tail -f`.

## Install

Requires [Node](https://nodejs.org) on PATH (the published hooks are bundled and run under `node` — no bun needed), a Honcho API key (from [app.honcho.dev](https://app.honcho.dev), saved via `honcho init` or `HONCHO_API_KEY`), and `npx` on PATH (for the MCP `mcp-remote` bridge; ships with Node).

```bash
npm install -g @honcho-ai/codex-honcho
codex-honcho install      # registers hooks + MCP + skill in ~/.codex
```

Restart Codex afterward to load the hooks and `[features].hooks`.

Without a key, install registers the hooks and skill but skips the MCP server (which needs it); save a key and re-run `codex-honcho install` to complete that step.

| command | effect |
|---|---|
| `codex-honcho install` | install hooks + MCP + skill |
| `codex-honcho status` | installed components + pending queue depth |
| `codex-honcho remove` | strip only what this installs |

### From a GitHub clone (no npm)

```bash
git clone https://github.com/plastic-labs/codex-honcho
cd codex-honcho
./install.sh              # bun install + bun run bin/codex-honcho.ts install
```

The clone path runs the TypeScript source directly and so **requires [bun](https://bun.sh)**; it wires the hooks to `bun run <this dir>/bin/codex-honcho.ts`, so keep the clone in place. The npm install instead ships a bundled `dist/codex-honcho.mjs` and wires hooks to `node "<abs path>"` — node-only, and stable across `npm update`.

## What install writes

| Path | Change |
|---|---|
| `~/.codex/hooks.json` | adds the four hook entries (merged; existing hooks untouched) |
| `~/.codex/config.toml` | sets `[features].hooks = true`; registers `[mcp_servers.honcho]` → `mcp.honcho.dev` |
| `~/.codex/skills/honcho-memory/` | active-recall skill |

`remove` reverses exactly these.

## Configuration

Read-only consumer of `~/.honcho/config.json` (shared with other Honcho integrations). Codex settings resolve from `hosts.codex`, falling back to root fields. Never written by this tool.

```json
{
  "apiKey": "hch-…",
  "peerName": "eri",
  "hosts": {
    "codex": {
      "workspace": "codex",
      "sessionStrategy": "per-directory",
      "injectPerPrompt": false,
      "saveMessages": true
    }
  }
}
```

| field | default | effect |
|---|---|---|
| `workspace` | root / `codex` | Honcho workspace; set to isolate Codex memory from other harnesses |
| `sessionStrategy` | `per-directory` | session naming (below) |
| `injectPerPrompt` | `false` | re-inject context every turn vs. session-start only + MCP |
| `saveMessages` | `true` | `false` reads memory but never writes |

`sessionStrategy`:

| value | session name | scope |
|---|---|---|
| `per-directory` | `groudon` | one per project directory |
| `git-branch` | `groudon-main` | one per branch (reads `.git/HEAD`; falls back to dir outside a repo) |
| `chat-instance` | `groudon-019ea7df` | one per Codex conversation |

An explicit `sessions[cwd]` mapping overrides all strategies. Env overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`.

## Layout

```
bin/codex-honcho.ts      CLI: install · remove · status · <hook verb>
src/dispatch.ts          verb → handler routing
src/hooks/               recall · prompt · observe · writeback · flush
src/transcript/codex.ts  Codex rollout (.jsonl) parser
src/queue.ts             append-only outbox + sent high-water-mark
src/cursor.ts            per-conversation rollout delta cursor
src/connectors/          hooks.json · config.toml MCP block · skill writers
src/config.ts            hosts.codex resolution; session naming
skills/honcho-memory/    when-to-recall guidance for the model
```

## Development

```bash
bun test
bun run typecheck
```

## License

MIT © Plastic Labs
