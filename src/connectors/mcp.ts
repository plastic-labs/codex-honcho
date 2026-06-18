import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH } from "./codex.ts";

// Honcho runs a hosted MCP server at https://mcp.honcho.dev (streamable HTTP,
// verified at the bare root — /mcp 404s). Rather than ship our own, we register
// it in ~/.codex/config.toml so Codex gets the active recall tools
// (search/chat/get_context/...). Auth is an inline bearer token
// read from ~/.honcho/config.json at install; identity rides as static headers.

export const HONCHO_MCP_URL = "https://mcp.honcho.dev";

// We own a fenced region of config.toml so we can rewrite/remove it cleanly
// without parsing the whole TOML document.
const BLOCK_START = "# >>> codex-honcho (honcho mcp) >>>";
const BLOCK_END = "# <<< codex-honcho (honcho mcp) <<<";

export interface McpIdentity {
  apiKey: string;
  userName: string;
  workspaceId?: string;
  assistantName?: string;
}

// TOML basic strings use the same escaping as JSON for our inputs (keys, names,
// hch- tokens), so JSON.stringify yields a valid quoted TOML value.
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function buildBlock(id: McpIdentity): string {
  // X-Honcho-User-Name is required; workspace/assistant are optional.
  const headers = [`"X-Honcho-User-Name" = ${tomlString(id.userName)}`];
  if (id.workspaceId) headers.push(`"X-Honcho-Workspace-ID" = ${tomlString(id.workspaceId)}`);
  if (id.assistantName) headers.push(`"X-Honcho-Assistant-Name" = ${tomlString(id.assistantName)}`);

  return [
    BLOCK_START,
    "[mcp_servers.honcho]",
    `url = ${tomlString(HONCHO_MCP_URL)}`,
    // bearer_token (inline) keeps the zero-env-var install: the key is read from
    // ~/.honcho/config.json and written here, sent as `Authorization: Bearer …`.
    `bearer_token = ${tomlString(id.apiKey)}`,
    `http_headers = { ${headers.join(", ")} }`,
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
export function setMcpServer(content: string, id: McpIdentity): string {
  const base = stripBlock(content).trimEnd();
  const block = buildBlock(id);
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function clearMcpServer(content: string): string {
  return stripBlock(content).trimEnd() + "\n";
}

export function hasMcpServer(content: string): boolean {
  return content.includes(BLOCK_START);
}

export function installMcpServer(id: McpIdentity, configPath: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  writeFileSync(configPath, setMcpServer(existing, id));
}

export function removeMcpServer(configPath: string = DEFAULT_CONFIG_PATH): boolean {
  if (!existsSync(configPath)) return false;
  const existing = readFileSync(configPath, "utf-8");
  if (!hasMcpServer(existing)) return false;
  writeFileSync(configPath, clearMcpServer(existing));
  return true;
}
