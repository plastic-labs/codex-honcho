import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installSkill, removeSkill, hasSkill } from "../../src/connectors/skill.ts";

function tmpSkills(): string {
  return mkdtempSync(join(tmpdir(), "codex-honcho-skills-"));
}

test("installSkill writes the honcho-memory SKILL.md", () => {
  const dir = tmpSkills();
  const dest = installSkill(dir);
  expect(dest).toBe(join(dir, "honcho-memory", "SKILL.md"));
  expect(existsSync(dest)).toBe(true);
  expect(readFileSync(dest, "utf-8")).toContain("name: honcho-memory");
  expect(hasSkill(dir)).toBe(true);
});

test("installSkill is idempotent", () => {
  const dir = tmpSkills();
  installSkill(dir);
  const dest = installSkill(dir);
  expect(existsSync(dest)).toBe(true);
});

test("removeSkill deletes it and reports state", () => {
  const dir = tmpSkills();
  installSkill(dir);
  expect(removeSkill(dir)).toBe(true);
  expect(hasSkill(dir)).toBe(false);
  expect(removeSkill(dir)).toBe(false);
});
