import { test, expect } from "bun:test";
import { setMcpServer, clearMcpServer, hasMcpServer } from "../../src/connectors/mcp.ts";

const invoke = { command: "node", args: ["/opt/codex-honcho.mjs", "mcp"] };

test("setMcpServer writes a local stdio server without credentials", () => {
  const out = setMcpServer("", invoke);
  expect(out).toContain("[mcp_servers.honcho]");
  expect(out).toContain('command = "node"');
  expect(out).toContain('args = ["/opt/codex-honcho.mjs","mcp"]');
  expect(out).not.toContain("hch-");
  expect(out).not.toContain("Authorization");
  expect(out).not.toContain("http_headers");
  expect(hasMcpServer(out)).toBe(true);
});

test("bun development entry uses bun run", () => {
  const out = setMcpServer("", { command: "bun", args: ["run", "/repo/bin/codex-honcho.ts", "mcp"] });
  expect(out).toContain('command = "bun"');
  expect(out).toContain('args = ["run","/repo/bin/codex-honcho.ts","mcp"]');
});

test("setMcpServer is idempotent — one block after repeated writes", () => {
  let out = setMcpServer("", invoke);
  out = setMcpServer(out, invoke);
  out = setMcpServer(out, { command: "node", args: ["/new/codex-honcho.mjs", "mcp"] });
  expect(out.match(/\[mcp_servers\.honcho\]/g)).toHaveLength(1);
  expect(out).toContain("/new/codex-honcho.mjs");
  expect(out).not.toContain("/opt/codex-honcho.mjs");
});

test("preserves the user's surrounding config", () => {
  const base = 'model = "o3"\n\n[features]\nhooks = true\n';
  const out = setMcpServer(base, invoke);
  expect(out).toContain('model = "o3"');
  expect(out).toContain("[features]");
  expect(out).toContain("[mcp_servers.honcho]");
});

test("clearMcpServer removes only our block", () => {
  const base = 'model = "o3"\n';
  const withBlock = setMcpServer(base, invoke);
  const cleared = clearMcpServer(withBlock);
  expect(hasMcpServer(cleared)).toBe(false);
  expect(cleared).toContain('model = "o3"');
});

test("preserves foreign Codex tables parked inside the managed fence", () => {
  const withBlock = setMcpServer('model = "o3"\n', invoke);
  const parked = withBlock.replace(
    "# <<< codex-honcho (honcho mcp) <<<",
    '[hooks.state]\nenabled = true\n\n# <<< codex-honcho (honcho mcp) <<<',
  );

  const cleared = clearMcpServer(parked);
  expect(cleared).toContain('model = "o3"');
  expect(cleared).toContain("[hooks.state]");
  expect(cleared).toContain("enabled = true");
  expect(cleared).not.toContain("[mcp_servers.honcho]");
  expect(cleared).not.toContain("/opt/codex-honcho.mjs");
});

test("clear on a file without our block is a harmless passthrough", () => {
  const base = "model = \"o3\"\n";
  expect(hasMcpServer(clearMcpServer(base))).toBe(false);
  expect(clearMcpServer(base)).toContain("model");
});
