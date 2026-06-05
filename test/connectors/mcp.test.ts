import { test, expect } from "bun:test";
import { setMcpServer, clearMcpServer, hasMcpServer, HONCHO_MCP_URL } from "../../src/connectors/mcp.ts";

const id = { apiKey: "hch-secret", userName: "eri", workspaceId: "codex", assistantName: "codex" };

test("setMcpServer writes a honcho mcp block with creds and headers", () => {
  const out = setMcpServer("", id);
  expect(out).toContain("[mcp_servers.honcho]");
  expect(out).toContain(HONCHO_MCP_URL);
  expect(out).toContain("Authorization:Bearer hch-secret");
  expect(out).toContain("X-Honcho-User-Name:eri");
  expect(out).toContain("X-Honcho-Workspace-ID:codex");
  expect(hasMcpServer(out)).toBe(true);
});

test("optional headers are omitted when absent", () => {
  const out = setMcpServer("", { apiKey: "k", userName: "eri" });
  expect(out).not.toContain("X-Honcho-Workspace-ID");
  expect(out).not.toContain("X-Honcho-Assistant-Name");
});

test("setMcpServer is idempotent — one block after repeated writes", () => {
  let out = setMcpServer("", id);
  out = setMcpServer(out, id);
  out = setMcpServer(out, { ...id, apiKey: "hch-rotated" });
  expect(out.match(/\[mcp_servers\.honcho\]/g)).toHaveLength(1);
  // Latest creds win.
  expect(out).toContain("hch-rotated");
  expect(out).not.toContain("hch-secret");
});

test("preserves the user's surrounding config", () => {
  const base = 'model = "o3"\n\n[features]\nhooks = true\n';
  const out = setMcpServer(base, id);
  expect(out).toContain('model = "o3"');
  expect(out).toContain("[features]");
  expect(out).toContain("[mcp_servers.honcho]");
});

test("clearMcpServer removes only our block", () => {
  const base = 'model = "o3"\n';
  const withBlock = setMcpServer(base, id);
  const cleared = clearMcpServer(withBlock);
  expect(hasMcpServer(cleared)).toBe(false);
  expect(cleared).toContain('model = "o3"');
});

test("clear on a file without our block is a harmless passthrough", () => {
  const base = "model = \"o3\"\n";
  expect(hasMcpServer(clearMcpServer(base))).toBe(false);
  expect(clearMcpServer(base)).toContain("model");
});
