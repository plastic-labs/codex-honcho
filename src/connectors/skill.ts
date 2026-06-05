import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Codex discovers agent skills under ~/.codex/skills/<name>/SKILL.md. We ship
// one that tells the model when to actively query and save Honcho memory.

const SKILL_NAME = "honcho-memory";
const SKILL_SOURCE = fileURLToPath(new URL("../../skills/honcho-memory/SKILL.md", import.meta.url));

function defaultSkillsDir(): string {
  return join(homedir(), ".codex", "skills");
}

export function installSkill(skillsDir: string = defaultSkillsDir()): string {
  const dest = join(skillsDir, SKILL_NAME, "SKILL.md");
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(SKILL_SOURCE, dest);
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
