# Changelog

## Unreleased

- Add an optional dry-run-first Codex memory bootstrap workflow under `examples/`.
- Document how to review, preflight, and explicitly approve legacy memory imports into Honcho.

## 0.1.0

- Initial release — harness-level Honcho memory for OpenAI Codex.
- Codex lifecycle hooks (`recall`, `prompt`, `observe`, `writeback`) capture each session and inject context at session start.
- Local-first write path: append-only queue with a lock-guarded background flush to Honcho.
- Native HTTP Honcho MCP server and a `honcho-memory` active-recall skill.
- npm-primary install (`codex-honcho install`) with a GitHub clone fallback.
