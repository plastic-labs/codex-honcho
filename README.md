# codex-honcho

Harness-level [Honcho](https://honcho.dev) memory for [OpenAI Codex](https://developers.openai.com/codex). Codex lifecycle hooks capture each session to Honcho and inject relevant context at session start, so memory persists across conversations.

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

Requires [Node](https://nodejs.org) on PATH to run the installer, a Honcho API key (from [app.honcho.dev](https://app.honcho.dev), saved via `honcho init` or `HONCHO_API_KEY`), and **[Codex](https://developers.openai.com/codex) ≥ 0.136.0**.

```bash
npm install -g @honcho-ai/codex-honcho
codex-honcho install      # registers hooks + MCP + skill in ~/.codex
```

Restart Codex afterward to load the hooks and `[features].hooks`.

If a Honcho key is already saved in `~/.honcho/config.json`, `install` runs without prompting and registers everything — the tools work after a Codex restart, with no environment variable to set. `install` copies that key into `[mcp_servers.honcho].bearer_token`, so if you ever rotate your key, **re-run `codex-honcho install`** to update it.

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

The clone path runs the TypeScript source directly and so **requires [bun](https://bun.sh)**; it wires the hooks to `bun run <this dir>/bin/codex-honcho.ts`, so keep the clone in place. The npm install instead stages the bundled `dist/codex-honcho.mjs` to `~/.codex/honcho/` and wires hooks to `node "~/.codex/honcho/codex-honcho.mjs"` — node-only, and stable across `npm update`, `npx` cache eviction, or removing the package.

## What install writes

| Path | Change |
|---|---|
| `~/.codex/honcho/` | staged copy of the bundle the hooks run (npm install only; keeps hooks stable across cache eviction) |
| `~/.codex/hooks.json` | adds the four hook entries (merged; existing hooks untouched) |
| `~/.codex/config.toml` | sets `[features].hooks = true`; registers `[mcp_servers.honcho]` → `mcp.honcho.dev` (native HTTP) |
| `~/.codex/skills/honcho-memory/` | active-recall skill |
| `~/.honcho/config.json` | persists the resolved `apiKey` + `peerName` at the root (other fields and `hosts.*` blocks preserved) |

`remove` reverses exactly these.

## Configuration

Backed by `~/.honcho/config.json` (shared with other Honcho integrations). Codex settings resolve from `hosts.codex`, falling back to root fields. The hooks only ever read it; `install` is the one writer — it persists the resolved `apiKey` + `peerName` at the root (your other fields and every `hosts.*` block are left intact).

```json
{
  "apiKey": "hch-…",
  "peerName": "testuser",
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
| `per-directory` | `my-app` | one per project directory (the dir name, e.g. `~/Code/my-app`) |
| `git-branch` | `my-app-main` | one per branch (reads `.git/HEAD`; falls back to dir outside a repo) |
| `chat-instance` | `my-app-019ea7df` | one per Codex conversation |

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
