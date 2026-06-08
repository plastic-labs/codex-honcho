import { existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

// Locate the .git dir by walking up from cwd. Handles worktrees/submodules
// where .git is a file pointing at the real gitdir.
function gitDir(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 25; i++) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
        const m = readFileSync(candidate, "utf-8").match(/gitdir:\s*(.+)/);
        if (m) {
          const p = m[1].trim();
          return p.startsWith("/") ? p : join(dir, p);
        }
      } catch {
        // unreadable — give up on this level
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

// Current branch name, or a short SHA when HEAD is detached. Reads .git/HEAD
// directly — no subprocess. Returns undefined outside a git repo.
export function currentBranch(cwd: string): string | undefined {
  const g = gitDir(cwd);
  if (!g) return undefined;
  try {
    const head = readFileSync(join(g, "HEAD"), "utf-8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (ref) return ref[1];
    if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, 7);
  } catch {
    // no HEAD / unreadable
  }
  return undefined;
}
