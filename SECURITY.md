# Security Policy

## Scope

`codex-honcho` is a memory integration for OpenAI Codex. It runs as Codex
lifecycle hooks (a small CLI invoked by Codex) and registers the hosted Honcho
MCP server (`https://mcp.honcho.dev`) in `~/.codex/config.toml`. The primary
surfaces are:

- The CLI/hooks under `bin/` and `src/`, which read session transcripts from
  Codex and write them to a local append-only queue before uploading to Honcho.
- Local config at `~/.honcho/config.json`, which holds your Honcho API key. The
  key is read at install time and written into the MCP server block in
  `~/.codex/config.toml` as an `Authorization` header. Keep both files private.

The integration sends your session content to the Honcho API for memory
storage. Review [Honcho's privacy and security posture](https://honcho.dev)
before connecting accounts that contain sensitive data.

## Credential redaction

When message capture is enabled, codex-honcho redacts common credential forms
before writing them to the local queue and applies the same filter again before
upload. This includes common provider token prefixes, authorization and cookie
headers, JWTs, private-key PEM blocks, URL credentials, and values assigned to
sensitive key names. Tool observations never retain raw commands, patches,
paths, responses, or other tool arguments.

The queue directory is forced to mode `0700`; queue, sent-marker, and lock files
are forced to mode `0600`. Files created by earlier releases are tightened in
place when they are read or updated, without copying their contents.

Redaction is heuristic. It reduces accidental credential persistence but cannot
recognize every proprietary or newly introduced secret format. Do not paste
secrets into prompts, and review the local queue before enabling capture in an
environment that handles credentials or regulated data. Previously queued
entries remain unchanged on disk, although current releases redact them again
at the upload boundary.

## Supported versions

The latest published release on npm (`@honcho-ai/codex-honcho`) is supported.
Earlier versions are not maintained.

## Reporting a vulnerability

If you find a security issue:

1. Do **not** open a public issue.
2. Open a private security advisory via GitHub:
   https://github.com/plastic-labs/codex-honcho/security/advisories/new
3. Include reproduction steps and an impact assessment.

You should expect an initial response within 14 days.

## Out of scope

- Vulnerabilities in third-party dependencies (report upstream).
- Issues in the hosted Honcho API itself (report at https://honcho.dev).
- User-misconfigured credentials (e.g. a world-readable
  `~/.honcho/config.json`); secure your local files per your OS guidance.
