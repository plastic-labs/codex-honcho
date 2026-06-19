import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, sessionName, honchoSessionUrl } from "../src/config.ts";

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
  writeConfig({ peerName: "testuser" });
  expect(loadConfig()).toBeNull();
});

test("resolves the codex host block over root fields", () => {
  writeConfig({
    apiKey: "root-key",
    peerName: "testuser",
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
  writeConfig({ apiKey: "k", peerName: "testuser" });
  const cfg = loadConfig()!;
  expect(cfg.workspace).toBe("codex");
  expect(cfg.aiPeer).toBe("codex");
});

test("env API key overrides the file", () => {
  writeConfig({ apiKey: "file-key", peerName: "testuser" });
  process.env.HONCHO_API_KEY = "env-key";
  expect(loadConfig()!.apiKey).toBe("env-key");
});

test("globalOverride applies flat fields across hosts", () => {
  writeConfig({
    apiKey: "k",
    peerName: "testuser",
    workspace: "flat-ws",
    aiPeer: "flat-ai",
    globalOverride: true,
    hosts: { codex: { workspace: "ignored" } },
  });
  expect(loadConfig()!.workspace).toBe("flat-ws");
});

test("session name is the slugged directory, no peer prefix", () => {
  writeConfig({ apiKey: "k", peerName: "testuser" });
  const cfg = loadConfig()!;
  expect(sessionName(cfg, "/Users/testuser/My Project")).toBe("my-project");
});

test("explicit session override wins", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", sessions: { "/repo/x": "pinned-session" } });
  const cfg = loadConfig()!;
  expect(sessionName(cfg, "/repo/x")).toBe("pinned-session");
});

test("chat-instance strategy appends a short Codex session id", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", hosts: { codex: { sessionStrategy: "chat-instance" } } });
  const cfg = loadConfig()!;
  expect(sessionName(cfg, "/repo/my-app", "019ea7df-805e-76d1-af52")).toBe("my-app-019ea7df");
  // No session id → falls back to the directory.
  expect(sessionName(cfg, "/repo/my-app")).toBe("my-app");
});

test("git-branch strategy appends the current branch", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", sessionStrategy: "git-branch" });
  const cfg = loadConfig()!;
  // Build a fake repo dir with a branch ref.
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-repo-"));
  const repoDir = join(repo, "my-app");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/feature/login\n");
  expect(sessionName(cfg, repoDir)).toBe("my-app-feature-login");
});

test("git-branch falls back to directory outside a repo", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", sessionStrategy: "git-branch" });
  const cfg = loadConfig()!;
  const plain = mkdtempSync(join(tmpdir(), "codex-honcho-plain-"));
  expect(sessionName(cfg, plain)).toBe(basename(plain).toLowerCase().replace(/[^a-z0-9-_]/g, "-"));
});

test("honchoSessionUrl builds a GUI deep link and encodes its parts", () => {
  expect(honchoSessionUrl("codex", "my-app")).toBe(
    "https://app.honcho.dev/explore?workspace=codex&view=sessions&session=my-app",
  );
  // chat-instance fallback: empty session, then strip the trailing param.
  expect(honchoSessionUrl("co dex", "").replace(/&session=$/, "")).toBe(
    "https://app.honcho.dev/explore?workspace=co%20dex&view=sessions",
  );
});
