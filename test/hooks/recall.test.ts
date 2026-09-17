import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recall } from "../../src/hooks/recall.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-recall-"));
  process.env.HONCHO_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("Dione routing forbids unscoped SessionStart memory injection", async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    apiKey: "unused",
    peerName: "syn",
    hosts: { codex: { dioneRouting: true } },
  }));

  // Returning before createSession is load-bearing: this test has no Honcho
  // endpoint and would attempt network access if the boundary regressed.
  const out = await recall({ cwd: "/repo", session_id: "thread" });
  expect(out).toContain("Honcho memory tools are available via MCP");
  expect(out).not.toContain("syn");
  expect(out).not.toContain("View this session in Honcho");
});
