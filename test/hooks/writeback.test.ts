import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capture } from "../../src/hooks/writeback.ts";
import { readQueue, pendingCount } from "../../src/queue.ts";

const savedDir = process.env.HONCHO_CONFIG_DIR;
let rollout = "";

function writeRollout(turns: Array<{ role: string; text: string }>) {
  const lines = turns.map((t) => ({
    type: "response_item",
    payload: { type: "message", role: t.role, content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }] },
  }));
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

function writeAuthenticatedRollout(turns: Array<
  | { role: "assistant"; text: string }
  | { role: "dione"; text: string; clientId: string }
>) {
  const lines = turns.flatMap((t) => {
    if (t.role === "assistant") {
      return [{
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t.text }] },
      }];
    }
    return [{
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: t.text }] },
    }, {
      type: "event_msg",
      payload: { type: "user_message", client_id: t.clientId, message: t.text },
    }];
  });
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "codex-honcho-wb-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  rollout = join(dir, "rollout.jsonl");
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("capture enqueues fresh turns and is incremental across calls", () => {
  writeRollout([{ role: "user", text: "first" }, { role: "assistant", text: "reply" }]);
  expect(capture("s1", rollout)).toBe(2);
  expect(readQueue("s1").map((e) => e.text)).toEqual(["first", "reply"]);

  // Second call with no new turns enqueues nothing.
  expect(capture("s1", rollout)).toBe(0);

  // A new turn appears → only the delta is captured.
  writeRollout([
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "second" },
  ]);
  expect(capture("s1", rollout)).toBe(1);
  expect(pendingCount("s1")).toBe(3);
  expect(readQueue("s1").at(-1)?.text).toBe("second");
});

test("reused transcript indexes cannot collide after a rollout shrink", () => {
  writeRollout([{ role: "user", text: "old turn" }, { role: "assistant", text: "old reply" }]);
  expect(capture("shrink", rollout)).toBe(2);
  const oldReceipts = readQueue("shrink").map((entry) => entry.receiptId);

  writeRollout([{ role: "user", text: "replacement turn" }]);
  expect(capture("shrink", rollout)).toBe(1);
  const entries = readQueue("shrink");
  expect(entries.at(-1)?.receiptId).not.toBe(oldReceipts[0]);
  expect(entries.at(-1)?.receiptId).toMatch(/^codex:shrink:record:[0-9a-f]{16}$/);
});

test("an inserted record before the previous tail is still captured", () => {
  writeRollout([{ role: "user", text: "first" }, { role: "assistant", text: "reply" }]);
  expect(capture("insert", rollout)).toBe(2);

  writeRollout([
    { role: "user", text: "first" },
    { role: "user", text: "inserted" },
    { role: "assistant", text: "reply" },
  ]);
  expect(capture("insert", rollout)).toBe(1);
  expect(readQueue("insert").map((entry) => entry.text)).toEqual([
    "first",
    "reply",
    "inserted",
  ]);
});

test("equal repeated turns receive distinct stable receipts", () => {
  writeRollout([{ role: "user", text: "same" }]);
  expect(capture("repeat", rollout)).toBe(1);

  writeRollout([
    { role: "user", text: "same" },
    { role: "user", text: "same" },
  ]);
  expect(capture("repeat", rollout)).toBe(1);
  const receipts = readQueue("repeat").map((entry) => entry.receiptId);
  expect(new Set(receipts).size).toBe(2);
});

test("capture skips Codex-injected system turns", () => {
  writeRollout([
    { role: "user", text: "<environment_context><cwd>/x</cwd></environment_context>" },
    { role: "user", text: "real prompt" },
  ]);
  expect(capture("s2", rollout)).toBe(1);
  expect(readQueue("s2").map((e) => e.text)).toEqual(["real prompt"]);
});

test("capture routes complete Dione envelopes by stable user id", () => {
  const dione = (content: string, user: string, userId: string) => [
    "A Discord event arrived through Dione.",
    "",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          chat_id: "moonpool",
          message_id: `${userId}-message`,
          user,
          user_id: userId,
        },
      },
    }),
  ].join("\n");
  writeAuthenticatedRollout([
    { role: "dione", text: dione("from syn", "syn", "syn-id"), clientId: "dione-1" },
    { role: "dione", text: dione("from Vesper", "Vesper", "vesper-id"), clientId: "dione-2" },
    { role: "assistant", text: "from Callisto" },
  ]);

  expect(capture("s3", rollout, { "syn-id": "syn" })).toBe(3);
  const entries = readQueue("s3");
  expect(entries.map((entry) => [entry.text, entry.peerId])).toEqual([
    ["from syn", "syn"],
    ["from Vesper", "discord-vesper-id"],
    ["from Callisto", undefined],
  ]);
  expect(entries.map((entry) => entry.scopeId)).toEqual([
    "moonpool",
    "moonpool",
    "moonpool",
  ]);
  expect(entries[0].source?.messageId).toBe("syn-id-message");
  expect(entries[1].source?.userName).toBe("Vesper");
});

test("same peer in two channels keeps one identity and separate conversation scopes", () => {
  const dione = (content: string, channelId: string, messageId: string) => [
    "A Discord event arrived through Dione.",
    "",
    JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          chat_id: channelId,
          message_id: messageId,
          user: "syn",
          user_id: "syn-id",
        },
      },
    }),
  ].join("\n");
  writeAuthenticatedRollout([
    { role: "dione", text: dione("private", "dm-channel", "m1"), clientId: "dione-10" },
    { role: "assistant", text: "private reply" },
    { role: "dione", text: dione("moonpool", "moonpool", "m2"), clientId: "dione-11" },
    { role: "assistant", text: "moonpool reply" },
  ]);

  expect(capture("s4", rollout, { "syn-id": "syn" })).toBe(4);
  const entries = readQueue("s4");
  expect(entries.map((entry) => entry.peerId)).toEqual(["syn", undefined, "syn", undefined]);
  expect(entries.map((entry) => entry.scopeId)).toEqual([
    "dm-channel",
    "dm-channel",
    "moonpool",
    "moonpool",
  ]);
});

test("ignored Dione user boundary clears scope before a later assistant", () => {
  const dione = (content: string, type?: string) => [
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
  writeAuthenticatedRollout([
    { role: "dione", text: dione("hello"), clientId: "dione-20" },
    { role: "assistant", text: "scoped reply" },
    { role: "dione", text: dione("reacted with 💜", "reaction"), clientId: "dione-21" },
    { role: "assistant", text: "must not inherit moonpool" },
  ]);

  expect(capture("boundary", rollout, { "syn-id": "syn" }, true)).toBe(2);
  const entries = readQueue("boundary");
  expect(entries.map((entry) => [entry.text, entry.scopeId])).toEqual([
    ["hello", "moonpool"],
    ["scoped reply", "moonpool"],
  ]);
});
