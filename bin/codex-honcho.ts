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
import { loadConfig, memoryKey, currentIdentity, saveConfig } from "../src/config.ts";
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

// The shell command each Codex hook runs. When the `codex-honcho` bin is
// installed (npm), wire hooks to its *resolved absolute path* — PATH-independent
// (Codex's hook runner may not have the npm global bin dir on PATH) and stable
// across `npm update` (the global shim path is constant). Fall back to an
// absolute `bun run` against this file for a local/dev clone not yet installed.
function hookInvoke(): (verb: string) => string {
  const bin = Bun.which("codex-honcho");
  if (bin) return (verb) => `${JSON.stringify(bin)} ${verb}`;
  const self = fileURLToPath(import.meta.url);
  return (verb) => `bun run ${JSON.stringify(self)} ${verb}`;
}

// Make ~/.honcho/config.json the source of truth. A key already present (root
// apiKey, hosts.codex, or HONCHO_API_KEY env) is enough to persist the config
// non-interactively — we save the key + peer (existing or a sensible fallback),
// no prompting. Only a truly empty config (no key anywhere) prompts. Returns false if no key is available
// and the user skips — the caller then installs hooks/skill but leaves MCP off.
// Non-interactive runs get null from prompt() and fall through cleanly.
function ensureHonchoConfig(): boolean {
  const { apiKey: existingKey, peerName: existingPeer } = currentIdentity();
  // Mirror loadConfig's precedence: env peer name beats the OS user so we don't
  // persist the wrong peer when HONCHO_PEER_NAME is set but the file has none.
  const fallbackPeer = process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";

  if (existingKey) {
    console.log(`Saved Honcho config → ${saveConfig({ apiKey: existingKey, peerName: existingPeer ?? fallbackPeer })}`);
    return true;
  }

  const apiKey = (prompt("Honcho API key (hch-…, leave blank to skip): ") ?? "").trim();
  if (!apiKey) return false;
  const peerName = existingPeer ?? ((prompt(`Honcho peer name [${fallbackPeer}]: `) ?? "").trim() || fallbackPeer);
  console.log(`Saved Honcho config → ${saveConfig({ apiKey, peerName })}`);
  return true;
}

switch (command) {
  case "install": {
    ensureHonchoConfig();
    installCodexHooks({ invoke: hookInvoke() });
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
