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

test("extracts edited files from an apply_patch", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** Add File: src/b.ts\n+y\n*** End Patch";
  expect(summarizeTool("apply_patch", { input: patch })).toBe("edited: src/a.ts, src/b.ts");
});

test("falls back to a generic note for unknown tools", () => {
  expect(summarizeTool("mcp__honcho__search", {})).toBe("used mcp__honcho__search");
});

test("empty tool name yields nothing", () => {
  expect(summarizeTool("", {})).toBe("");
});
