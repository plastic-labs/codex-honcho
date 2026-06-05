import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, sessionName } from "../src/config.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;
const savedKey = process.env.HONCHO_API_KEY;

function writeConfig(obj: object) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-cfg-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  delete process.env.HONCHO_API_KEY;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
  if (savedKey === undefined) delete process.env.HONCHO_API_KEY;
  else process.env.HONCHO_API_KEY = savedKey;
});

test("returns null without an API key", () => {
  writeConfig({ peerName: "eri" });
  expect(loadConfig()).toBeNull();
});

test("resolves the codex host block over root fields", () => {
  writeConfig({
    apiKey: "root-key",
    peerName: "eri",
    workspace: "root-ws",
    aiPeer: "root-ai",
    hosts: { codex: { workspace: "codex-ws", aiPeer: "codex" } },
  });
  const cfg = loadConfig()!;
  expect(cfg.workspace).toBe("codex-ws");
  expect(cfg.aiPeer).toBe("codex");
  expect(cfg.apiKey).toBe("root-key");
});

test("defaults workspace and aiPeer to 'codex'", () => {
  writeConfig({ apiKey: "k", peerName: "eri" });
  const cfg = loadConfig()!;
  expect(cfg.workspace).toBe("codex");
  expect(cfg.aiPeer).toBe("codex");
});

test("env API key overrides the file", () => {
  writeConfig({ apiKey: "file-key", peerName: "eri" });
  process.env.HONCHO_API_KEY = "env-key";
  expect(loadConfig()!.apiKey).toBe("env-key");
});

test("globalOverride applies flat fields across hosts", () => {
  writeConfig({
    apiKey: "k",
    peerName: "eri",
    workspace: "flat-ws",
    aiPeer: "flat-ai",
    globalOverride: true,
    hosts: { codex: { workspace: "ignored" } },
  });
  expect(loadConfig()!.workspace).toBe("flat-ws");
});

test("session name is the slugged directory, no peer prefix", () => {
  writeConfig({ apiKey: "k", peerName: "Eri" });
  const cfg = loadConfig()!;
  expect(sessionName(cfg, "/Users/eri/My Project")).toBe("my-project");
});

test("explicit session override wins", () => {
  writeConfig({ apiKey: "k", peerName: "eri", sessions: { "/repo/x": "pinned-session" } });
  const cfg = loadConfig()!;
  expect(sessionName(cfg, "/repo/x")).toBe("pinned-session");
});
