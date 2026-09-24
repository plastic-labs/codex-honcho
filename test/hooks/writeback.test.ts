import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture } from "../../src/hooks/writeback.ts";
import { readQueue, pendingCount } from "../../src/queue.ts";

const savedDir = process.env.HONCHO_CONFIG_DIR;
let rollout = "";

function writeRollout(turns: Array<{ role: string; text: string }>) {
  const lines = turns.map((t) => ({
    type: "response_item",
    payload: { type: "message", role: t.role, content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }] },
  }));
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-wb-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  rollout = join(dir, "rollout.jsonl");
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("capture enqueues fresh turns and is incremental across calls", () => {
  writeRollout([{ role: "user", text: "first" }, { role: "assistant", text: "reply" }]);
  expect(capture("s1", rollout)).toBe(2);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["first", "reply"]);

  // Second call with no new turns enqueues nothing.
  expect(capture("s1", rollout)).toBe(0);

  // A new turn appears → only the delta is captured.
  writeRollout([
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second" },
  ]);
  expect(capture("s1", rollout)).toBe(1);
  expect(pendingCount("s1")).toBe(3);
  expect(readQueue("s1").at(-1)?.text).toBe("second");
});

test("capture skips Codex-injected system turns", () => {
  writeRollout([
    { role: "user", text: "<environment_context><cwd>/x</cwd></environment_context>" },
    { role: "user", text: "real prompt" },
  ]);
  expect(capture("s2", rollout)).toBe(1);
  expect(readQueue("s2").map((e) => e.text)).toEqual(["real prompt"]);
});

test("capture skips the AGENTS.md instructions turn Codex injects as a user message", () => {
  writeRollout([
    { role: "user", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" },
    { role: "user", text: "<codex_internal_context>\n<objective>goal</objective>\n</codex_internal_context>" },
    { role: "user", text: "real prompt" },
  ]);
  expect(capture("s3", rollout)).toBe(1);
  expect(readQueue("s3").map((e) => e.text)).toEqual(["real prompt"]);
});

test("a cursor written before per-block filtering is migrated, not reused as an index", () => {
  // An older build kept the AGENTS.md turn, so its cursor of 3 covers [AGENTS.md, first, reply].
  writeRollout([
    { role: "user", text: "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" },
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second" },
    { role: "assistant", text: "second reply" },
  ]);
  const cursors = join(process.env.HONCHO_CONFIG_DIR!, "codex", "cursors");
  mkdirSync(cursors, { recursive: true });
  writeFileSync(join(cursors, "s4.json"), JSON.stringify({ count: 3, at: "2026-09-01T00:00:00.000Z" }));
  expect(capture("s4", rollout)).toBe(2);
  expect(readQueue("s4").map((e) => e.text)).toEqual(["second", "second reply"]);
});
