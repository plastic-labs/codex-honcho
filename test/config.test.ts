import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { honchoClientOptions, loadConfig, memoryKey, saveConfig, sessionName } from "../src/config.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;
const savedKey = process.env.HONCHO_API_KEY;

function writeConfig(obj: object) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

function writeLocalConfig(root: string, obj: object) {
  const localDir = join(root, ".honcho");
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, "config.json"), JSON.stringify(obj));
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

test("per-repo strategy uses the git root from a nested directory", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", sessionStrategy: "per-repo" });
  const parent = mkdtempSync(join(tmpdir(), "codex-honcho-per-repo-"));
  const repo = join(parent, "My Project");
  const child = join(repo, "packages", "app");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(child, { recursive: true });

  expect(sessionName(loadConfig()!, child)).toBe("my-project");
});

test("per-repo strategy falls back to the current directory outside git", () => {
  writeConfig({ apiKey: "k", peerName: "testuser", sessionStrategy: "per-repo" });
  const plain = mkdtempSync(join(tmpdir(), "codex-honcho-no-repo-"));

  expect(sessionName(loadConfig()!, plain)).toBe(
    basename(plain).toLowerCase().replace(/[^a-z0-9-_]/g, "-"),
  );
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

test("repo-local config overlays selected fields and inherits global identity", () => {
  writeConfig({
    apiKey: "global-key",
    peerName: "global-user",
    hosts: { codex: { workspace: "global-ws", aiPeer: "global-ai", reasoningLevel: "low" } },
  });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-local-"));
  const child = join(repo, "packages", "app");
  mkdirSync(child, { recursive: true });
  writeLocalConfig(repo, {
    hosts: {
      codex: {
        workspace: "project-ws",
        reasoningLevel: "high",
        endpoint: { baseUrl: "http://127.0.0.1:18100" },
      },
    },
  });

  const cfg = loadConfig(child)!;
  expect(cfg.apiKey).toBe("global-key");
  expect(cfg.peerName).toBe("global-user");
  expect(cfg.aiPeer).toBe("global-ai");
  expect(cfg.workspace).toBe("project-ws");
  expect(cfg.reasoningLevel).toBe("high");
  expect(honchoClientOptions(cfg).baseURL).toBe("http://127.0.0.1:18100/v3");
  expect(cfg.localConfig).toEqual({ path: join(repo, ".honcho", "config.json"), root: repo });
});

test("repo-local config can be fully self-contained", () => {
  writeConfig({ peerName: "unused-global-user" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-standalone-"));
  writeLocalConfig(repo, { apiKey: "local-key", peerName: "local-user", workspace: "local-ws" });

  const cfg = loadConfig(repo)!;
  expect(cfg.apiKey).toBe("local-key");
  expect(cfg.peerName).toBe("local-user");
  expect(cfg.workspace).toBe("local-ws");
});

test("environment API key remains the highest-precedence override", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser" });
  process.env.HONCHO_API_KEY = "env-key";
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-env-local-"));
  writeLocalConfig(repo, { apiKey: "local-key", workspace: "local-ws" });

  expect(loadConfig(repo)?.apiKey).toBe("env-key");
});

test("nearest repo-local config wins", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-nearest-"));
  const nested = join(repo, "packages", "app");
  const child = join(nested, "src");
  mkdirSync(child, { recursive: true });
  writeLocalConfig(repo, { workspace: "outer-ws" });
  writeLocalConfig(nested, { workspace: "inner-ws" });

  const cfg = loadConfig(child)!;
  expect(cfg.workspace).toBe("inner-ws");
  expect(cfg.localConfig?.root).toBe(nested);
});

test("malformed repo-local config leaves global behavior unchanged", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser", workspace: "global-ws" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-malformed-"));
  const localDir = join(repo, ".honcho");
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, "config.json"), "{not-json");

  const cfg = loadConfig(repo)!;
  expect(cfg.workspace).toBe("global-ws");
  expect(cfg.localConfig).toBeUndefined();
  expect(memoryKey(cfg, repo, "session-1")).toBe("session-1");
});

test("redirected global config is never mistaken for a repo-local overlay", () => {
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-global-dir-"));
  dir = join(repo, ".honcho");
  process.env.HONCHO_CONFIG_DIR = dir;
  writeConfig({ apiKey: "global-key", peerName: "testuser", workspace: "global-ws" });

  const cfg = loadConfig(repo)!;
  expect(cfg.workspace).toBe("global-ws");
  expect(cfg.localConfig).toBeUndefined();
});

test("saveConfig writes only the global file while a local overlay is active", () => {
  writeConfig({ apiKey: "global-key", peerName: "global-user", workspace: "global-ws" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-read-only-"));
  writeLocalConfig(repo, { workspace: "project-ws" });
  const localPath = join(repo, ".honcho", "config.json");
  const before = readFileSync(localPath, "utf-8");

  expect(loadConfig(repo)?.workspace).toBe("project-ws");
  saveConfig({ peerName: "updated-global-user" });

  expect(readFileSync(localPath, "utf-8")).toBe(before);
  expect(loadConfig(repo)?.workspace).toBe("project-ws");
});

test("repo-local sessions anchor to the project root", () => {
  writeConfig({
    apiKey: "global-key",
    peerName: "testuser",
    sessions: { "/ignored": "global-pinned" },
  });
  const parent = mkdtempSync(join(tmpdir(), "codex-honcho-anchor-"));
  const repo = join(parent, "My Project");
  const child = join(repo, "packages", "app");
  mkdirSync(child, { recursive: true });
  writeLocalConfig(repo, { workspace: "project-ws" });

  const cfg = loadConfig(child)!;
  expect(sessionName(cfg, child)).toBe("my-project");
  expect(memoryKey(cfg, child, "session-1")).toBe("local-project-ws-session-1");
});

test("repo-local sessionName pins the exact session", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser", sessionStrategy: "chat-instance" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-pinned-"));
  writeLocalConfig(repo, { workspace: "project-ws", sessionName: "Shared Project Memory" });

  const cfg = loadConfig(repo)!;
  expect(sessionName(cfg, join(repo, "src"), "019ea7df-805e-76d1-af52")).toBe("shared-project-memory");
});

test("splitSubmodules anchors nested git repositories independently", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-submodules-"));
  const submodule = join(repo, "modules", "Payments SDK");
  const child = join(submodule, "src");
  mkdirSync(child, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(submodule, ".git"), "gitdir: ../../.git/modules/payments\n");
  writeLocalConfig(repo, { workspace: "project-ws", splitSubmodules: true });

  const cfg = loadConfig(child)!;
  expect(sessionName(cfg, child)).toBe("payments-sdk");
});

test("repo-local per-repo strategy scopes nested git repositories without splitSubmodules", () => {
  writeConfig({ apiKey: "global-key", peerName: "testuser" });
  const repo = mkdtempSync(join(tmpdir(), "codex-honcho-local-per-repo-"));
  const nestedRepo = join(repo, "worktrees", "Feature Checkout");
  const child = join(nestedRepo, "src");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(child, { recursive: true });
  writeFileSync(join(nestedRepo, ".git"), "gitdir: ../../.git/worktrees/feature\n");
  writeLocalConfig(repo, { workspace: "project-ws", sessionStrategy: "per-repo" });

  expect(sessionName(loadConfig(child)!, child)).toBe("feature-checkout");
});
