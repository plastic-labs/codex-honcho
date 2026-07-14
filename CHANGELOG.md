# Changelog

## Unreleased

- Add read-only repo-local `.honcho/config.json` overlays with nearest-ancestor discovery, global-field inheritance, project-root session anchoring, optional pinned session names, and optional nested git-repository splitting.
- Run the Honcho MCP as a credential-free local stdio server so hooks and active-recall tools use the same repo-local endpoint, workspace, and identity.
- Namespace local queue, cursor, and context keys by workspace to prevent messages captured before an override from crossing memory scopes.
- Add the Hermes-compatible `per-repo` session strategy: all directories in a Git repository share the Git root's session name, with a per-directory fallback outside Git.

## 0.1.0

- Initial release — harness-level Honcho memory for OpenAI Codex.
- Codex lifecycle hooks (`recall`, `prompt`, `observe`, `writeback`) capture each session and inject context at session start.
- Local-first write path: append-only queue with a lock-guarded background flush to Honcho.
- Native HTTP Honcho MCP server and a `honcho-memory` active-recall skill.
- npm-primary install (`codex-honcho install`) with a GitHub clone fallback.
