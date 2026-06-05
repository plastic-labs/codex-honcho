import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/codex-honcho.ts", import.meta.url));

// Codex blocks the turn until a hook command exits, and it ignores async:true.
// So anything slow (uploads, dialectic) is re-run in a detached child and the
// hook returns immediately. CODEX_HONCHO_BG marks the child so it doesn't
// detach again.
export function runDetached(verb: string, stdinText: string): void {
  try {
    const child = spawn("bun", ["run", BIN, verb], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...process.env, CODEX_HONCHO_BG: "1" },
    });
    child.stdin.end(stdinText);
    child.unref();
  } catch {
    // If the spawn fails, drop the work rather than block the turn.
  }
}

export function isBackground(): boolean {
  return process.env.CODEX_HONCHO_BG === "1";
}
