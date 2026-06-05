import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readRollout, readRolloutCwd } from "../../src/transcript/codex.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/codex-rollout.jsonl", import.meta.url));

function writeRollout(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

test("reads user and assistant turns in order", () => {
  const turns = readRollout(FIXTURE);
  expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(turns[0].text).toBe("How is auth handled in this repo?");
  expect(turns[1].text).toContain("JWT middleware");
});

test("ignores reasoning, function_call, and non-response_item events", () => {
  const turns = readRollout(FIXTURE);
  expect(turns.every((t) => !t.text.includes("chain of thought"))).toBe(true);
  expect(turns.length).toBe(4);
});

test("joins multiple input_text blocks", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[2].text).toBe("Add a refresh token flow.\nKeep it backwards compatible.");
});

test("accepts string content as well as block arrays", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[3].text).toContain("/refresh endpoint");
});

test("drops whitespace-only messages", () => {
  // The trailing assistant turn in the fixture is blank and must not appear.
  const turns = readRollout(FIXTURE);
  expect(turns.length).toBe(4);
});

test("carries timestamps through", () => {
  const turns = readRollout(FIXTURE);
  expect(turns[0].at).toBe("2026-06-05T12:00:01.000Z");
});

test("extracts cwd from session_meta", () => {
  expect(readRolloutCwd(FIXTURE)).toBe("/Users/dev/project");
});

test("missing file yields no turns and no cwd", () => {
  expect(readRollout("/no/such/rollout.jsonl")).toEqual([]);
  expect(readRolloutCwd("/no/such/rollout.jsonl")).toBeUndefined();
});

test("skips malformed lines without throwing", () => {
  const path = writeRollout([
    { type: "session_meta", payload: { cwd: "/tmp/x" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } },
  ]);
  // Append a broken line.
  writeFileSync(path, "not json\n", { flag: "a" });
  const turns = readRollout(path);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("hi");
});
