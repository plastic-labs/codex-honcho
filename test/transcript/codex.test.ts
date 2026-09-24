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

test("drops Codex-injected system turns (environment_context, etc.)", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<turn_aborted>interrupted</turn_aborted>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<skills_instructions>use skills</skills_instructions>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question from me" }] } },
  ]);
  const turns = readRollout(path);
  expect(turns).toHaveLength(1);
  expect(turns[0].text).toBe("actual question from me");
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

// Shapes observed in real Codex 0.144–0.156 rollouts: the project-doc turn is a
// markdown-headed block (not a tag) that Codex bundles with environment_context
// (and, in exec/subagent threads, behind recommended_plugins) in ONE message.
const AGENTS_BLOCK = "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nalways run tests\n</INSTRUCTIONS>";
const ENV_BLOCK = "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>";

test("drops the AGENTS.md instructions turn, alone or bundled with environment_context", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: AGENTS_BLOCK }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: AGENTS_BLOCK }, { type: "input_text", text: ENV_BLOCK }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<recommended_plugins>\nx\n</recommended_plugins>" }, { type: "input_text", text: AGENTS_BLOCK }, { type: "input_text", text: ENV_BLOCK }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question from me" }] } },
  ]);
  const turns = readRollout(path);
  expect(turns.map((t) => t.text)).toEqual(["actual question from me"]);
});

test("drops goal context and subagent notifications Codex injects as user turns", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<codex_internal_context>\n<objective>ship it</objective>\n</codex_internal_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<subagent_notification>\n{\"agent\":\"worker\"}\n</subagent_notification>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: "<recommended_plugins>\nx\n</recommended_plugins>" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real prompt" }] } },
  ]);
  expect(readRollout(path).map((t) => t.text)).toEqual(["real prompt"]);
});

test("filters injected blocks per block, keeping the user's own text in the same message", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "keep this" }, { type: "input_text", text: ENV_BLOCK }] } },
  ]);
  expect(readRollout(path).map((t) => t.text)).toEqual(["keep this"]);
});

test("keeps user text that merely mentions an injected marker mid-message", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "why does <environment_context> or # AGENTS.md instructions for appear?" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "# AGENTS.md instructions for x — quoting is fine in replies" }] } },
  ]);
  expect(readRollout(path)).toHaveLength(2);
});

test("drops the project-doc turn when Codex omits ' for <cwd>' from the heading (seen in 0.153.4)", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>" }, { type: "input_text", text: ENV_BLOCK }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions are unclear to me, can you explain?" }] } },
  ]);
  expect(readRollout(path).map((t) => t.text)).toEqual(["# AGENTS.md instructions are unclear to me, can you explain?"]);
});

test("keeps a user block whose own heading merely ends in 'instructions'", () => {
  const path = writeRollout([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# My instructions\n<INSTRUCTIONS>\nkeep me\n</INSTRUCTIONS>" }] } },
  ]);
  expect(readRollout(path)).toHaveLength(1);
});
