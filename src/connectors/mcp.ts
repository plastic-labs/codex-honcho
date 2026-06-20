import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONFIG_PATH } from "./codex.ts";

// Honcho runs a hosted MCP server at https://mcp.honcho.dev (streamable HTTP,
// verified at the bare root — /mcp 404s). Rather than ship our own, we register
// it in ~/.codex/config.toml so Codex gets the active recall tools
// (search/chat/get_context/...). Auth + identity ride as static http_headers
// read from ~/.honcho/config.json at install (Authorization + X-Honcho-*).

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
  // Auth + identity all ride as static http_headers. Codex rejects a top-level
  // `bearer_token` for streamable_http servers ("not supported"), so we send the
  // key as an inline `Authorization: Bearer …` header instead — same wire result,
  // and it keeps the zero-env-var install (key read from ~/.honcho/config.json).
  // X-Honcho-User-Name is required; workspace/assistant are optional.
  const headers = [
    `"Authorization" = ${tomlString(`Bearer ${id.apiKey}`)}`,
    `"X-Honcho-User-Name" = ${tomlString(id.userName)}`,
  ];
  if (id.workspaceId) headers.push(`"X-Honcho-Workspace-ID" = ${tomlString(id.workspaceId)}`);
  if (id.assistantName) headers.push(`"X-Honcho-Assistant-Name" = ${tomlString(id.assistantName)}`);

  return [
    BLOCK_START,
    "[mcp_servers.honcho]",
    `url = ${tomlString(HONCHO_MCP_URL)}`,
    `http_headers = { ${headers.join(", ")} }`,
    BLOCK_END,
  ].join("\n");
}

function stripBlock(content: string): string {
  if (!content.includes(BLOCK_START)) return content;

  // Codex rewrites config.toml and parks tables it owns (e.g. [hooks.state] or
  // tool-approval prefs) inside our fence. Drop only the marker lines and the
  // tables we wrote ([mcp_servers.honcho] + its subtables); keep everything else
  // so an uninstall/reinstall never deletes config we don't own.
  const out: string[] = [];
  let inFence = false;
  let dropTable = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_START) { inFence = true; dropTable = false; continue; }
    if (trimmed === BLOCK_END) { inFence = false; dropTable = false; continue; }
    if (!inFence) { out.push(line); continue; }

    const header = trimmed.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (header) {
      const name = header[1];
      dropTable = name === "mcp_servers.honcho" || name.startsWith("mcp_servers.honcho.");
    }
    if (!dropTable) out.push(line);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "") + "\n";
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
