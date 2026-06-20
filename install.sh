#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required — install it from https://bun.sh, then re-run." >&2
  exit 1
fi

echo "Installing dependencies…"
bun install --silent

if [ ! -f "$HOME/.honcho/config.json" ] && [ -z "${HONCHO_API_KEY:-}" ]; then
  echo
  echo "No Honcho API key found. Get one from https://app.honcho.dev, then put it in ~/.honcho/config.json:"
  echo "  honcho init                                       # writes ~/.honcho/config.json"
  echo "  # no CLI yet?  uv tool install honcho-cli && honcho init"
  echo "  # or by hand: echo '{\"apiKey\":\"hch-...\"}' > ~/.honcho/config.json"
  echo "Then re-run ./install.sh to register the MCP server."
fi

echo
bun run "$DIR/bin/codex-honcho.ts" install
echo
echo "Done. Restart Codex (or start a new session) to load the hooks."
