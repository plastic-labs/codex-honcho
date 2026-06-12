import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./codex.ts";

// Codex discovers agent skills under ~/.codex/skills/<name>/SKILL.md. We ship
// one that tells the model when to actively query and save Honcho memory.

const SKILL_NAME = "honcho-memory";

// Locate the source SKILL.md across the layouts we run in: the bundled build
// (dist/codex-honcho.cjs alongside dist/skills/, copied by build.mjs) and a
// source checkout (src/connectors/skill.ts → ../../skills, used by dev + tests).
function skillSource(): string {
  const candidates: string[] = [];
  const entry = process.argv[1];
  if (entry) candidates.push(join(dirname(entry), "skills", SKILL_NAME, "SKILL.md")); // bundled: dist/skills/...
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(join(dirname(here), "..", "..", "skills", SKILL_NAME, "SKILL.md")); // source: repo/skills/...
  } catch {
    // import.meta unavailable in some bundles — the entry-relative candidate covers that case.
  }
  return candidates.find(existsSync) ?? candidates[candidates.length - 1] ?? "";
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
