#!/usr/bin/env bun
import { fileURLToPath } from "node:url";
import { dispatch, isHookVerb } from "../src/dispatch.ts";
import {
  installCodexHooks,
  removeCodexHooks,
  hasCodexHooks,
  DEFAULT_HOOKS_PATH,
  DEFAULT_CONFIG_PATH,
} from "../src/connectors/codex.ts";
import { installMcpServer, removeMcpServer, type McpIdentity } from "../src/connectors/mcp.ts";
import { installSkill, removeSkill, hasSkill } from "../src/connectors/skill.ts";
import { loadConfig } from "../src/config.ts";

const command = process.argv[2] ?? "";

async function runHook(verb: string): Promise<void> {
  const stdin = await Bun.stdin.text();
  if (!isHookVerb(verb)) return;
  try {
    const out = await dispatch(verb, stdin);
    if (out) process.stdout.write(out + "\n");
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
  case "status":
    console.log(hasCodexHooks() ? "codex-honcho hooks: installed" : "codex-honcho hooks: not installed");
    console.log(hasSkill() ? "memory skill: installed" : "memory skill: not installed");
    console.log(loadConfig() ? "honcho config: found" : "honcho config: missing (run `honcho init`)");
    break;
  default:
    await runHook(command);
}

process.exit(0);
