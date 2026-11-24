# Changelog

## Unreleased

- Fixed Codex's generated `# AGENTS.md instructions` preamble being saved to Honcho as a user message.
- Fixed assistant messages on the `analysis` channel (internal working notes) being saved as replies; `final`, `commentary` and channel-less turns are kept.
- `chat-instance` session names now use the full Codex session UUID instead of its first 8 characters, so two conversations whose ids share a prefix no longer write to the same Honcho session.

## 0.1.1

- Fixed uninstall/reinstall wiping foreign config parked inside the honcho comment fence: cleanup now removes only the marker lines and `[mcp_servers.honcho]` tables, preserving anything else Codex left there (e.g. `[hooks.state]`, tool-approval prefs).
- Updated MCP tool names in the docs and plugin descriptions to match the server (`get_peer_context`, `create_conclusions`).

## 0.1.0

- Initial release — harness-level Honcho memory for OpenAI Codex.
- Codex lifecycle hooks (`recall`, `prompt`, `observe`, `writeback`) capture each session and inject context at session start.
- Local-first write path: append-only queue with a lock-guarded background flush to Honcho.
- Native HTTP Honcho MCP server and a `honcho-memory` active-recall skill.
- npm-primary install (`codex-honcho install`) with a GitHub clone fallback.
