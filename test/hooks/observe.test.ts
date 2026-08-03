import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { observe, summarizeTool } from "../../src/hooks/observe.ts";
import { readQueue } from "../../src/queue.ts";

const savedDir = process.env.HONCHO_CONFIG_DIR;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-observe-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    apiKey: "hch-test",
    peerName: "syn",
  }));
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
  rmSync(dir, { recursive: true, force: true });
});

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

test("scopes tool observations from authenticated rollout provenance", async () => {
  const transcript = join(dir, "rollout.jsonl");
  const dione = [
    "A Discord event arrived through Dione.",
    "",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: {
        content: "please build it",
        meta: {
          chat_id: "1529173139639238738",
          message_id: "1531313256650768474",
          user: "syn",
          user_id: "161358348577406976",
        },
      },
    }),
  ].join("\n");
  writeFileSync(transcript, [
    { type: "event_msg", payload: { type: "user_message", client_id: "dione-1", message: dione } },
  ].map((line) => JSON.stringify(line)).join("\n"));

  await observe({
    tool_name: "Bash",
    tool_input: { command: "npm run build" },
    cwd: "/repo/proj",
    session_id: "s1",
    transcript_path: transcript,
    tool_call_id: "tool-1",
  });

  expect(readQueue("s1")).toMatchObject([{
    role: "tool",
    text: "ran: npm run build",
    scopeId: "1529173139639238738",
    receiptId: "codex:tool:s1:tool-1",
  }]);
});

test("drops tool observations when conversation scope cannot be proven", async () => {
  await observe({
    tool_name: "Bash",
    tool_input: { command: "npm run build" },
    cwd: "/repo/proj",
    session_id: "s2",
  });
  expect(readQueue("s2")).toEqual([]);
});

test("ignored Dione boundary prevents reuse of an earlier channel for tools", async () => {
  const transcript = join(dir, "boundary-rollout.jsonl");
  const message = (content: string, type?: string) => [
    "A Discord event arrived through Dione.",
    "",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          chat_id: "moonpool",
          message_id: type ? "reaction-1" : "message-1",
          user: "syn",
          user_id: "syn-id",
          ...(type ? { type } : {}),
        },
      },
    }),
  ].join("\n");
  writeFileSync(transcript, [
    { type: "event_msg", payload: { type: "user_message", client_id: "dione-1", message: message("hello") } },
    { type: "event_msg", payload: { type: "user_message", client_id: "dione-2", message: message("reacted", "reaction") } },
  ].map((line) => JSON.stringify(line)).join("\n"));

  await observe({
    tool_name: "Bash",
    tool_input: { command: "npm run build" },
    cwd: "/repo/proj",
    session_id: "boundary-tool",
    transcript_path: transcript,
    tool_call_id: "tool-boundary",
  });
  expect(readQueue("boundary-tool")).toEqual([]);
});
