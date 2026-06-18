import { resolve, dirname, join } from "node:path";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dispatch, isVerb } from "../src/dispatch.ts";
import {
  installCodexHooks,
  removeCodexHooks,
  hasCodexHooks,
  codexHome,
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

// Read all of stdin (the hook payload Codex pipes in). Node-compatible so the
// bundled build runs under plain `node`; returns "" for an interactive TTY so a
// manual run doesn't hang waiting for EOF.
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

async function runHook(verb: string): Promise<void> {
  const stdin = await readStdin();
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

// The shell command each Codex hook runs. Wire hooks to an entry's *absolute*
// path (PATH-independent; Codex's hook runner may have a minimal PATH). The
// bundled build is JS run under `node` (no bun required); a local/dev clone is
// TypeScript run under `bun`. Detect which by the entry's extension.
function hookInvoke(entry: string): (verb: string) => string {
  const self = resolve(entry);
  const runner = self.endsWith(".ts") ? "bun run" : "node";
  return (verb) => `${runner} ${JSON.stringify(self)} ${verb}`;
}

// Resolve the entry the hooks should point at. A dev/clone `.ts` entry lives in
// a stable repo checkout, so wire hooks straight to it. The bundled `.mjs`,
// however, runs from an *ephemeral* location when installed via `npx` (the npm
// `_npx` cache, which is garbage-collected) or a node_modules that may later be
// pruned — hooks pinned there silently stop firing once it's gone. Copy the
// self-contained bundle (+ its skill asset) into a stable home under CODEX_HOME
// and wire hooks to that copy instead.
function stableEntry(): string {
  const self = resolve(process.argv[1] ?? "");
  if (self.endsWith(".ts")) return self;

  const home = join(codexHome(), "honcho");
  mkdirSync(home, { recursive: true });
  const dest = join(home, "codex-honcho.mjs");
  copyFileSync(self, dest);

  // Ship the skill asset next to the staged bundle so a re-run from the stable
  // copy can still resolve it (skillSource() looks relative to the running entry).
  const srcSkill = join(dirname(self), "skills", "honcho-memory", "SKILL.md");
  if (existsSync(srcSkill)) {
    const destSkill = join(home, "skills", "honcho-memory", "SKILL.md");
    mkdirSync(dirname(destSkill), { recursive: true });
    copyFileSync(srcSkill, destSkill);
  }
  return dest;
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
    // Stage the bundle to a stable home BEFORE installing the skill, while
    // process.argv[1] still points at the original (npx) dist with its assets.
    const entry = stableEntry();
    installCodexHooks({ invoke: hookInvoke(entry) });
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
    // Drop the staged bundle home (no-op for a dev/clone install, which has none).
    const stagedHome = join(codexHome(), "honcho");
    const stagedGone = existsSync(stagedHome);
    if (stagedGone) rmSync(stagedHome, { recursive: true, force: true });
    console.log(hooksGone || mcpGone || skillGone || stagedGone ? "Removed codex-honcho hooks, MCP registration, and skill." : "No codex-honcho install found.");
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
