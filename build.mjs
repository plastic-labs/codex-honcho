// Bundle the CLI + hooks into a single self-contained Node script so the hooks
// run under `node` (no bun, no node_modules at the user's site). The Honcho SDK
// is bundled in; the only runtime requirement becomes `node` (the MCP server is
// registered as a native HTTP endpoint — no `npx`/mcp-remote bridge). Run via `npm run build`.
import * as esbuild from "esbuild";
import { rmSync, mkdirSync, copyFileSync, chmodSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

await esbuild.build({
  entryPoints: ["bin/codex-honcho.ts"],
  outfile: "dist/codex-honcho.mjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  banner: { js: "#!/usr/bin/env node" },
});

// esbuild writes 0644; the file is a CLI entry (npm `bin`) with a shebang, so it
// needs the exec bit to run directly (npm sets this at install time, but local
// runs and the git-clone path invoke dist directly).
chmodSync("dist/codex-honcho.mjs", 0o755);

// The installer copies this into ~/.codex/skills/; ship it next to the bundle
// so skillSource() finds it relative to the running entry (dist/skills/...).
mkdirSync("dist/skills/honcho-memory", { recursive: true });
copyFileSync("skills/honcho-memory/SKILL.md", "dist/skills/honcho-memory/SKILL.md");

console.log("Built dist/codex-honcho.mjs (+ dist/skills)");
