import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPolicy, shouldDrop, capTurn, POLICY_ENV_VAR } from "../src/policy.ts";

const saved = process.env[POLICY_ENV_VAR];
let dir = "";

function writePolicy(obj: object): string {
  const path = join(dir, "memory-policy.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-policy-"));
});

afterEach(() => {
  if (saved === undefined) delete process.env[POLICY_ENV_VAR];
  else process.env[POLICY_ENV_VAR] = saved;
});

test("no policy configured leaves ingestion unfiltered", () => {
  process.env[POLICY_ENV_VAR] = join(dir, "does-not-exist.json");
  const policy = loadPolicy();
  expect(policy.dropPatterns).toHaveLength(0);
  expect(shouldDrop("<recommended_plugins>", policy)).toBe(false);
  expect(capTurn("x".repeat(9000), policy)).toHaveLength(9000);
});

test("malformed policy falls back to unfiltered rather than throwing", () => {
  const path = join(dir, "memory-policy.json");
  writeFileSync(path, "{ not json");
  process.env[POLICY_ENV_VAR] = path;
  expect(loadPolicy().dropPatterns).toHaveLength(0);
});

test("an unparseable rule is skipped without discarding the rest", () => {
  process.env[POLICY_ENV_VAR] = writePolicy({
    ingestion: {
      drop_patterns: [{ pattern: "([unclosed" }, { pattern: "<system-reminder>" }],
    },
  });
  const policy = loadPolicy();
  expect(policy.dropPatterns).toHaveLength(1);
  expect(shouldDrop("<system-reminder>x</system-reminder>", policy)).toBe(true);
});

test("drop patterns honour declared flags", () => {
  process.env[POLICY_ENV_VAR] = writePolicy({
    ingestion: {
      drop_patterns: [{ pattern: "^#\\s*AGENTS\\.md instructions for", flags: "m" }],
    },
  });
  const policy = loadPolicy();
  expect(shouldDrop("intro\n# AGENTS.md instructions for /repo", policy)).toBe(true);
  expect(shouldDrop("a normal decision", policy)).toBe(false);
});

test("caps over-long turns and appends the declared marker", () => {
  process.env[POLICY_ENV_VAR] = writePolicy({
    ingestion: { max_turn_chars: 100, truncation_marker: "…[cut]" },
  });
  const policy = loadPolicy();
  const capped = capTurn("x".repeat(500), policy);
  expect(capped).toBe("x".repeat(100) + "…[cut]");
  expect(capTurn("short", policy)).toBe("short");
  expect(capTurn("y".repeat(100), policy)).toBe("y".repeat(100));
});

test("a representative policy drops harness boilerplate and keeps conversation", () => {
  process.env[POLICY_ENV_VAR] = writePolicy({
    ingestion: {
      max_turn_chars: 2000,
      truncation_marker: "\n…[truncated for memory ingestion]",
      drop_patterns: [
        { pattern: "<recommended_plugins>" },
        { pattern: "^#\\s*AGENTS\\.md instructions for", flags: "m" },
        { pattern: "^#\\s*CLAUDE\\.md instructions for", flags: "m" },
        { pattern: "<system-reminder>" },
      ],
    },
  });
  const policy = loadPolicy();
  expect(shouldDrop("<recommended_plugins> Airtable, Asana", policy)).toBe(true);
  expect(shouldDrop("# AGENTS.md instructions for /Users/x/repo", policy)).toBe(true);
  expect(shouldDrop("# CLAUDE.md instructions for /Users/x/repo", policy)).toBe(true);
  expect(shouldDrop("<system-reminder>noise</system-reminder>", policy)).toBe(true);
  expect(shouldDrop("The payments review is now PASS.", policy)).toBe(false);
});
