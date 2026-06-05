import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
