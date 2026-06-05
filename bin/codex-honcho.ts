#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { dispatch, isVerb } from "../src/dispatch.ts";
import {
  installCodexHooks,
  removeCodexHooks,
  hasCodexHooks,
  DEFAULT_HOOKS_PATH,
  DEFAULT_CONFIG_PATH,
} from "../src/connectors/codex.ts";
import { installMcpServer, removeMcpServer, type McpIdentity } from "../src/connectors/mcp.ts";
import { installSkill, removeSkill, hasSkill } from "../src/connectors/skill.ts";
import { loadConfig, memoryKey } from "../src/config.ts";
import { pendingCount } from "../src/queue.ts";

const command = process.argv[2] ?? "";

// Verbs whose output is injected as model-only context (not shown to the user).
const INJECT_EVENT: Record<string, string> = {
  recall: "SessionStart",
  prompt: "UserPromptSubmit",
};

async function runHook(verb: string): Promise<void> {
  const stdin = await Bun.stdin.text();
  if (!isVerb(verb)) return;

  try {
    const out = await dispatch(verb, stdin);
    if (!out) return;
    const event = INJECT_EVENT[verb];
    const payload = event
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: out } })
      : out;
    process.stdout.write(payload + "\n");
  } catch {
    // Never surface a hook failure to Codex.
  }
}

function mcpIdentity(): McpIdentity | null {
  const config = loadConfig();
  if (!config) return null;
  return {
    apiKey: config.apiKey,
    userName: config.peerName,
    workspaceId: config.workspace,
    assistantName: config.aiPeer,
  };
}

switch (command) {
  case "install": {
    // Wire hooks to this script's absolute path so the Codex hook runner
    // doesn't depend on `codex-honcho` being on PATH.
    const self = fileURLToPath(import.meta.url);
    installCodexHooks({ invoke: (verb) => `bun run ${JSON.stringify(self)} ${verb}` });
    console.log(`Installed Codex hooks → ${DEFAULT_HOOKS_PATH}`);
    console.log(`Enabled [features].hooks → ${DEFAULT_CONFIG_PATH}`);
    console.log(`Installed memory skill → ${installSkill()}`);
    const id = mcpIdentity();
    if (id) {
      installMcpServer(id);
      console.log(`Registered Honcho MCP (mcp.honcho.dev) → ${DEFAULT_CONFIG_PATH}`);
    } else {
      console.log("Skipped MCP registration — no Honcho API key found. Run `honcho init`, then re-run install.");
    }
    break;
  }
  case "remove":
  case "uninstall": {
    const hooksGone = removeCodexHooks();
    const mcpGone = removeMcpServer();
    const skillGone = removeSkill();
    console.log(hooksGone || mcpGone || skillGone ? "Removed codex-honcho hooks, MCP registration, and skill." : "No codex-honcho install found.");
    break;
  }
  case "status": {
    console.log(hasCodexHooks() ? "codex-honcho hooks: installed" : "codex-honcho hooks: not installed");
    console.log(hasSkill() ? "memory skill: installed" : "memory skill: not installed");
    const cfg = loadConfig();
    console.log(cfg ? "honcho config: found" : "honcho config: missing (run `honcho init`)");
    if (cfg) {
      const key = memoryKey(cfg, process.cwd());
      console.log(`queue (${key}): ${pendingCount(key)} pending upload`);
    }
    break;
  }
  default:
    await runHook(command);
}

process.exit(0);
