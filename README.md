# codex-honcho

Gives [OpenAI Codex](https://developers.openai.com/codex) a memory. It quietly records your Codex sessions into [Honcho](https://honcho.dev) and feeds the useful bits back at the start of each session, so Codex actually remembers you across conversations.

Sibling to [`claude-honcho`](https://github.com/plastic-labs/claude-honcho) — same memory backend, just wired into Codex's hooks instead.

## Quick start

```bash
git clone https://github.com/plastic-labs/codex-honcho
cd codex-honcho
./install.sh
```

Then restart Codex. That's it.

You'll need three things first:
- **[bun](https://bun.sh)** installed
- **a Honcho API key** — easiest via the CLI: `uv tool install honcho-cli && honcho init` (writes `~/.honcho/config.json`). Or just `export HONCHO_API_KEY=hch-…`.
- **`npx`** on your PATH (used to wire up the Honcho MCP)

No key yet? `install.sh` still sets up the hooks and tells you what to do — just re-run it after `honcho init`.

## Living with it

```bash
bun run bin/codex-honcho.ts status     # what's installed + how many messages are waiting to upload
bun run bin/codex-honcho.ts remove     # clean uninstall — only touches what we added
tail -f ~/.honcho/codex/queue/*.jsonl  # watch it record you, live
```

Your memory shows up at [app.honcho.dev](https://app.honcho.dev) — look under the workspace named in your config (`codex` if you set one, otherwise whatever your root workspace is).

## How it works

Codex fires hooks at certain moments; we hang four small jobs off them. Capture is local and instant — the only thing that talks to the network is the flush at the end of a turn.

```
in your Codex session (local, instant)          Honcho (your memory)
────────────────────────────────────            ────────────────────
session starts   → recall      → drops a short "here's what I know
                                  about you" note into context  ◀──── reads your profile

you send a turn  → (nothing, by default — Codex
                    can pull more via the MCP tools)  ─────────────▶ search · chat · get_context
                                                                     (mcp.honcho.dev)

a tool runs      → observe     → jots a one-line note to a local queue

turn ends        → writeback   → appends the turn to the queue,
                                  then uploads everything pending ───▶ your session's messages
```

The queue (`~/.honcho/codex/queue/`) is just an append-only file you can read. Nothing is lost if an upload fails — it stays queued and retries next turn.

A bundled `honcho-memory` skill nudges Codex to actually *use* the memory tools when a task depends on your history, instead of guessing.

## What `install` touches

| File | What we do |
|---|---|
| `~/.codex/hooks.json` | add our four hook entries (merged in — your other hooks are untouched) |
| `~/.codex/config.toml` | turn on `[features].hooks` and register the Honcho MCP server |
| `~/.codex/skills/honcho-memory/` | drop in the memory skill |

`remove` strips exactly those and leaves everything else alone.

## Config

All optional. Lives in `~/.honcho/config.json` (shared with the other Honcho tools); Codex-specific bits go under `hosts.codex`.

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

- **`workspace`** — set this to keep Codex memory separate from Claude's. Leave it off and they share one.
- **`sessionStrategy`** — how sessions get named:
  - `per-directory` *(default)* — one per project folder → `groudon`
  - `git-branch` — one per branch → `groudon-main`
  - `chat-instance` — one per Codex conversation → `groudon-019ea7df`
- **`injectPerPrompt`** — `true` re-injects context every turn. Off by default; the MCP tools cover depth.
- **`saveMessages`** — `false` to read memory but never write.

Env overrides: `HONCHO_API_KEY`, `HONCHO_PEER_NAME`, `HONCHO_CONFIG_DIR`.

## Layout

```
bin/codex-honcho.ts      the CLI: install · remove · status · <hook>
src/hooks/               recall · prompt · observe · writeback · flush
src/transcript/codex.ts  reads Codex's rollout (.jsonl) transcripts
src/queue.ts             the local outbox (capture now, upload later)
src/cursor.ts            tracks which turns we've already captured
src/connectors/          writes hooks / MCP / skill into ~/.codex
src/config.ts            resolves the codex host from ~/.honcho/config.json
skills/honcho-memory/    tells Codex when to reach for memory
```

## Development

```bash
bun test
bun run typecheck
```

## License

MIT © Plastic Labs
