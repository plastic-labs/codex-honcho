import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./codex.ts";

// Codex discovers agent skills under ~/.codex/skills/<name>/SKILL.md. We ship
// one that tells the model when to actively query and save Honcho memory.

const SKILL_NAME = "honcho-memory";

// Locate the source SKILL.md, anchored on the running module's real path
// (import.meta.url, NOT process.argv[1] — that's the bin/ symlink under npm). Two
// layouts: the npm bundle (dist/codex-honcho.mjs → dist/skills/) and a dev checkout
// (src/connectors/skill.ts → repo/skills/, two levels up).
function skillSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = join(here, "skills", SKILL_NAME, "SKILL.md");
  return existsSync(bundled) ? bundled : join(here, "..", "..", "skills", SKILL_NAME, "SKILL.md");
}

function defaultSkillsDir(): string {
  return join(codexHome(), "skills");
}

export function installSkill(skillsDir: string = defaultSkillsDir()): string {
  const dest = join(skillsDir, SKILL_NAME, "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(skillSource(), dest);
  return dest;
}

export function removeSkill(skillsDir: string = defaultSkillsDir()): boolean {
  const dir = join(skillsDir, SKILL_NAME);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function hasSkill(skillsDir: string = defaultSkillsDir()): boolean {
  return existsSync(join(skillsDir, SKILL_NAME, "SKILL.md"));
}
