import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installCodexHooks,
  removeCodexHooks,
  hasCodexHooks,
  setHooksFeature,
} from "../../src/connectors/codex.ts";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-conn-"));
  return { hooks: join(dir, "hooks.json"), config: join(dir, "config.toml") };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

test("install writes our hook events", () => {
  const { hooks, config } = tmp();
  installCodexHooks({ hooksPath: hooks, configPath: config });
  const file = readJson(hooks);
  expect(Object.keys(file.hooks).sort()).toEqual(["PostToolUse", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]);
  expect(file.hooks.Stop[0].hooks[0].command).toContain("writeback");
  expect(file.hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
  // PreCompact reuses the writeback verb to flush before a context reset.
  expect(file.hooks.PreCompact[0].hooks[0].command).toContain("writeback");
  expect(file.hooks.PreCompact[0].matcher).toBe("manual|auto");
});

test("install enables the hooks feature flag", () => {
  const { hooks, config } = tmp();
  installCodexHooks({ hooksPath: hooks, configPath: config });
  expect(readFileSync(config, "utf-8")).toContain("hooks = true");
  expect(hasCodexHooks(hooks)).toBe(true);
});

test("install is idempotent — no duplicate groups", () => {
  const { hooks, config } = tmp();
  installCodexHooks({ hooksPath: hooks, configPath: config });
  installCodexHooks({ hooksPath: hooks, configPath: config });
  const file = readJson(hooks);
  expect(file.hooks.Stop).toHaveLength(1);
  expect(file.hooks.UserPromptSubmit).toHaveLength(1);
});

test("install preserves a user's existing foreign hooks", () => {
  const { hooks, config } = tmp();
  writeFileSync(
    hooks,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }],
      },
    }),
  );
  installCodexHooks({ hooksPath: hooks, configPath: config });
  const file = readJson(hooks);
  expect(file.hooks.PreToolUse[0].hooks[0].command).toBe("my-own-linter");
  expect(file.hooks.Stop).toBeDefined();
});

test("remove strips ours and deletes the file when nothing else remains", () => {
  const { hooks, config } = tmp();
  installCodexHooks({ hooksPath: hooks, configPath: config });
  expect(removeCodexHooks(hooks)).toBe(true);
  expect(existsSync(hooks)).toBe(false);
});

test("remove keeps foreign hooks and leaves the file in place", () => {
  const { hooks, config } = tmp();
  writeFileSync(
    hooks,
    JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] }] },
    }),
  );
  installCodexHooks({ hooksPath: hooks, configPath: config });
  expect(removeCodexHooks(hooks)).toBe(true);
  const file = readJson(hooks);
  expect(file.hooks.PreToolUse[0].hooks[0].command).toBe("my-own-linter");
  expect(file.hooks.Stop).toBeUndefined();
  expect(hasCodexHooks(hooks)).toBe(false);
});

test("remove is a no-op on a file that has none of ours", () => {
  const { hooks } = tmp();
  writeFileSync(hooks, JSON.stringify({ hooks: {} }));
  expect(removeCodexHooks(hooks)).toBe(false);
});

test("custom invoke builder is honored", () => {
  const { hooks, config } = tmp();
  installCodexHooks({
    hooksPath: hooks,
    configPath: config,
    invoke: (verb) => `bun run /opt/codex-honcho/bin.ts ${verb}`,
  });
  const file = readJson(hooks);
  expect(file.hooks.Stop[0].hooks[0].command).toBe("bun run /opt/codex-honcho/bin.ts writeback");
  // Still recognized as ours for strip/detect.
  expect(hasCodexHooks(hooks)).toBe(true);
  expect(removeCodexHooks(hooks)).toBe(true);
});

test("setHooksFeature: empty file gets a fresh section", () => {
  expect(setHooksFeature("")).toBe("[features]\nhooks = true\n");
});

test("setHooksFeature: appends section when absent", () => {
  const out = setHooksFeature('model = "o3"\n');
  expect(out).toContain('model = "o3"');
  expect(out).toContain("[features]\nhooks = true");
});

test("setHooksFeature: flips an existing hooks = false in place", () => {
  const out = setHooksFeature("[features]\nhooks = false\nother = true\n");
  expect(out).toContain("hooks = true");
  expect(out).not.toContain("hooks = false");
  expect(out).toContain("other = true");
});

test("setHooksFeature: inserts into an existing features section", () => {
  const out = setHooksFeature('[features]\nweb_search = true\n\n[other]\nx = 1\n');
  expect(out).toMatch(/\[features\]\n(?:.*\n)*hooks = true/);
  expect(out).toContain("[other]");
});
