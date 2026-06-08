import { test, expect } from "bun:test";
import { summarizeTool } from "../../src/hooks/observe.ts";

test("summarizes a shell command from an argv array", () => {
  expect(summarizeTool("shell", { command: ["npm", "run", "build"] })).toBe("ran: npm run build");
});

test("summarizes a shell command from a string", () => {
  expect(summarizeTool("local_shell", { command: "bun test" })).toBe("ran: bun test");
});

test("drops trivial read-only shell commands", () => {
  expect(summarizeTool("shell", { command: ["ls", "-la"] })).toBe("");
  expect(summarizeTool("shell", { command: "git status" })).toBe("");
});

test("matches Codex's 'Bash' tool name (the flood bug) and filters read-only", () => {
  // Codex sends tool_name "Bash" — these must be summarized, not fall through.
  expect(summarizeTool("Bash", { command: "npm run build" })).toBe("ran: npm run build");
  // ...and read-only ones must be dropped, not recorded as "used Bash".
  expect(summarizeTool("Bash", { command: "grep -r foo src" })).toBe("");
  expect(summarizeTool("Bash", { command: "find . -name '*.ts'" })).toBe("");
  expect(summarizeTool("Bash", { command: "git status -s" })).toBe("");
});

test("trivial match respects word boundaries", () => {
  // "catalog" must not be skipped just because it starts with "cat".
  expect(summarizeTool("Bash", { command: "catalog --build" })).toBe("ran: catalog --build");
});

test("extracts edited files from an apply_patch", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** Add File: src/b.ts\n+y\n*** End Patch";
  expect(summarizeTool("apply_patch", { input: patch })).toBe("edited: src/a.ts, src/b.ts");
});

test("falls back to a generic note for unknown tools", () => {
  expect(summarizeTool("mcp__linear__list_issues", {})).toBe("used mcp__linear__list_issues");
});

test("never records Honcho's own MCP calls (circular)", () => {
  expect(summarizeTool("mcp__honcho__chat", {})).toBe("");
  expect(summarizeTool("mcp__honcho__get_peer_card", {})).toBe("");
});

test("empty tool name yields nothing", () => {
  expect(summarizeTool("", {})).toBe("");
});
