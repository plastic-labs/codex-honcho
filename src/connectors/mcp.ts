import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH } from "./codex.ts";

// Codex launches our local stdio MCP server. It resolves the active cwd's Honcho
// config and calls the SDK directly, so repo-local workspace and endpoint values
// apply without putting credentials in config.toml.

// We own a fenced region of config.toml so we can rewrite/remove it cleanly
// without parsing the whole TOML document.
const BLOCK_START = "# >>> codex-honcho (honcho mcp) >>>";
const BLOCK_END = "# <<< codex-honcho (honcho mcp) <<<";

export interface McpCommand {
  command: string;
  args: string[];
}

// TOML basic strings use the same escaping as JSON for our inputs (keys, names,
// hch- tokens), so JSON.stringify yields a valid quoted TOML value.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildBlock(invoke: McpCommand): string {
  return [
    BLOCK_START,
    "[mcp_servers.honcho]",
    `command = ${tomlString(invoke.command)}`,
    `args = ${JSON.stringify(invoke.args)}`,
    BLOCK_END,
  ].join("\n");
}

function stripBlock(content: string): string {
  if (!content.includes(BLOCK_START)) return content;

  // Codex rewrites config.toml and parks tables it owns (e.g. [hooks.state] or
  // tool-approval prefs) inside our fence. Drop only the marker lines and the
  // tables we wrote ([mcp_servers.honcho] + its subtables); keep everything else
  // so an uninstall/reinstall never deletes config we don't own.
  //
  // Preserved lines accumulate into chunks; every removed line (a fence marker
  // or a honcho-table line) cuts a chunk boundary. We normalize blank lines only
  // at those seams and leave each preserved chunk byte-for-byte intact — never
  // touching blank lines a user (or a multiline TOML string) put in unrelated
  // config.
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let dropTable = false;

  const cut = () => {
    if (current.length) { chunks.push(current.join("\n")); current = []; }
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_START) { inFence = true; dropTable = false; cut(); continue; }
    if (trimmed === BLOCK_END) { inFence = false; dropTable = false; cut(); continue; }
    if (inFence) {
      const header = trimmed.match(/^\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/);
      if (header) {
        const name = header[1];
        dropTable = name === "mcp_servers.honcho" || name.startsWith("mcp_servers.honcho.");
      }
      if (dropTable) { cut(); continue; }
    }
    current.push(line);
  }
  cut();

  const parts = chunks
    .map((c) => c.replace(/^\n+/, "").replace(/\n+$/, ""))
    .filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

// Replace any existing block with a fresh one; idempotent.
export function setMcpServer(content: string, invoke: McpCommand): string {
  const base = stripBlock(content).trimEnd();
  const block = buildBlock(invoke);
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function clearMcpServer(content: string): string {
  return stripBlock(content).trimEnd() + "\n";
}

export function hasMcpServer(content: string): boolean {
  return content.includes(BLOCK_START);
}

export function installMcpServer(invoke: McpCommand, configPath: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  writeFileSync(configPath, setMcpServer(existing, invoke));
}

export function removeMcpServer(configPath: string = DEFAULT_CONFIG_PATH): boolean {
  if (!existsSync(configPath)) return false;
  const existing = readFileSync(configPath, "utf-8");
  if (!hasMcpServer(existing)) return false;
  writeFileSync(configPath, clearMcpServer(existing));
  return true;
}
