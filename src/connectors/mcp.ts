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
  const start = content.indexOf(BLOCK_START);
  if (start === -1) return content;
  const end = content.indexOf(BLOCK_END, start);
  if (end === -1) return content;
  const before = content.slice(0, start).replace(/\n*$/, "");
  const after = content.slice(end + BLOCK_END.length).replace(/^\n*/, "");
  return [before, after].filter(Boolean).join("\n\n") + (after ? "" : "\n");
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
