import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prompt } from "../../src/hooks/prompt.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;

function writeConfig(obj: object) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-prompt-"));
  process.env.HONCHO_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("returns nothing when per-prompt injection is off (default) — no network", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser" });
  const out = await prompt({ prompt: "how is auth done?", cwd: "/tmp/x", session_id: "s1" });
  expect(out).toBe("");
});

test("returns nothing for a trivial prompt even when injection is on", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser", hosts: { codex: { injectPerPrompt: true } } });
  expect(await prompt({ prompt: "ok", cwd: "/tmp/x", session_id: "s1" })).toBe("");
});

test("returns nothing when enabled but there is no cached context (no network)", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser", hosts: { codex: { injectPerPrompt: true } } });
  const out = await prompt({ prompt: "tell me about the project", cwd: "/tmp/x", session_id: "no-cache" });
  expect(out).toBe("");
});
