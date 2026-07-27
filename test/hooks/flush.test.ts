import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  enqueue,
  readQuarantine,
  sentCount,
  pendingCount,
  setSentCount,
} from "../../src/queue.ts";
import { lockPath } from "../../src/hooks/flush.ts";

// Captured by the mocked memory boundary so flush never hits the network.
interface SentMsg {
  peer: string;
  text: string;
  opts?: { createdAt?: string; metadata?: Record<string, string> };
  metadata?: Record<string, string>;
}
let batches: SentMsg[][] = [];
let batchSessions: string[] = [];
let memberships: Array<{
  session: string;
  peers: Array<[string, { observeMe: boolean; observeOthers: boolean }]>;
}> = [];
let addCalls = 0;
let failOnCalls = new Set<number>();
let failAfterWriteOnCalls = new Set<number>();
let remoteReceipts = new Set<string>();

mock.module("../../src/memory.ts", () => ({
  getSession: async (_config: unknown, name: string) => ({
    session: {
      addPeers: async (peers: Array<[string, { observeMe: boolean; observeOthers: boolean }]>) => {
        memberships.push({ session: name, peers });
      },
      addMessages: async (msgs: SentMsg[]) => {
        addCalls += 1;
        if (failOnCalls.has(addCalls)) throw new Error("simulated upload failure");
        batches.push(msgs);
        batchSessions.push(name);
        for (const msg of msgs) {
          const receipt = msg.metadata?.integration_receipt;
          if (receipt) remoteReceipts.add(receipt);
        }
        if (failAfterWriteOnCalls.has(addCalls)) throw new Error("simulated crash after remote acceptance");
      },
      messages: async (options?: { filters?: { metadata?: { integration_receipt?: string } } }) => ({
        items: remoteReceipts.has(options?.filters?.metadata?.integration_receipt || "") ? [{}] : [],
      }),
    },
    userPeer: { message: (text: string, opts?: SentMsg["opts"]) => ({ peer: "user", text, opts, metadata: opts?.metadata }) },
    aiPeer: { message: (text: string, opts?: SentMsg["opts"]) => ({ peer: "ai", text, opts, metadata: opts?.metadata }) },
    peerFor: async (peerId: string) => ({
      message: (text: string, opts?: SentMsg["opts"]) => ({ peer: peerId, text, opts, metadata: opts?.metadata }),
    }),
  }),
}));

const savedDir = process.env.HONCHO_CONFIG_DIR;
let dir = "";
const CWD = "/repo/proj";
const FLUSH_INPUT = { cwd: CWD, session_id: "s1" };

async function runFlush() {
  const { flush } = await import("../../src/hooks/flush.ts");
  return flush(FLUSH_INPUT);
}

function manyEntries(n: number) {
  return Array.from({ length: n }, (_, i) => ({ role: "user" as const, text: `m${i}`, at: "2026-06-09T00:00:00Z" }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-flush-"));
  process.env.HONCHO_CONFIG_DIR = dir;
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "hch-test", peerName: "tester" }));
  batches = [];
  batchSessions = [];
  memberships = [];
  addCalls = 0;
  failOnCalls = new Set();
  failAfterWriteOnCalls = new Set();
  remoteReceipts = new Set();
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

test("drains all pending entries and advances the sent marker to the total", async () => {
  enqueue("s1", [
    { role: "user", text: "hello", at: "2026-06-09T00:00:00Z" },
    { role: "assistant", text: "hi back", at: "2026-06-09T00:00:01Z" },
  ]);

  await runFlush();

  expect(batches.flat().map((m) => m.text)).toEqual(["hello", "hi back"]);
  expect(sentCount("s1")).toBe(2);
  expect(pendingCount("s1")).toBe(0);
});

test("nothing pending → no upload", async () => {
  await runFlush();
  expect(addCalls).toBe(0);
  expect(batches).toEqual([]);
});

test("a small queue drains in a single call", async () => {
  enqueue("s1", manyEntries(60));

  await runFlush();

  expect(addCalls).toBe(1);
  expect(batches[0].length).toBe(60);
  expect(sentCount("s1")).toBe(60);
});

test("splits a backlog into calls of at most 100 messages, on entry boundaries", async () => {
  enqueue("s1", manyEntries(150));

  await runFlush();

  expect(addCalls).toBe(2);
  expect(batches.map((b) => b.length)).toEqual([100, 50]);
  expect(sentCount("s1")).toBe(150);
});

test("a mid-drain failure keeps completed entries and resends only the remainder", async () => {
  enqueue("s1", manyEntries(150));
  failOnCalls = new Set([2]); // first batch lands, second throws

  await expect(runFlush()).rejects.toThrow();

  // First batch's marker advanced; the failed batch is still pending.
  expect(sentCount("s1")).toBe(100);
  expect(pendingCount("s1")).toBe(50);

  // Retry: only the remaining 50 go up, no re-send of the first 100.
  batches = [];
  await runFlush();
  expect(batches.flat().length).toBe(50);
  expect(batches.flat().map((m) => m.text)).toEqual(
    Array.from({ length: 50 }, (_, i) => `m${100 + i}`),
  );
  expect(sentCount("s1")).toBe(150);
});

test("a first-chunk failure leaves the marker at zero so the whole batch retries", async () => {
  enqueue("s1", manyEntries(10));
  failOnCalls = new Set([1]);

  await expect(runFlush()).rejects.toThrow();
  expect(sentCount("s1")).toBe(0);
  expect(pendingCount("s1")).toBe(10);

  batches = [];
  failOnCalls = new Set();
  await runFlush();
  expect(batches.flat().length).toBe(10);
  expect(sentCount("s1")).toBe(10);
});

test("a retry after remote acceptance skips the prior receipt instead of duplicating", async () => {
  enqueue("s1", [{
    role: "user",
    text: "exactly once",
    at: "2026-06-09T00:00:00Z",
    receiptId: "codex:s1:turn:0",
  }]);
  failAfterWriteOnCalls = new Set([1]);

  await expect(runFlush()).rejects.toThrow("simulated crash after remote acceptance");
  expect(sentCount("s1")).toBe(0);
  expect(batches.flat().map((message) => message.text)).toEqual(["exactly once"]);

  batches = [];
  batchSessions = [];
  failAfterWriteOnCalls = new Set();
  await runFlush();

  expect(batches).toEqual([]);
  expect(sentCount("s1")).toBe(1);
  expect(remoteReceipts).toEqual(new Set(["codex:s1:turn:0:part:1/1"]));
});

test("duplicate receipts in one pending batch upload exactly once", async () => {
  const duplicate = {
    role: "user" as const,
    text: "captured before cursor acknowledgement",
    receiptId: "codex:s1:turn:0",
  };
  enqueue("s1", [duplicate, duplicate]);

  await runFlush();

  expect(batches.flat().map((message) => message.text)).toEqual([
    "captured before cursor acknowledgement",
  ]);
  expect(sentCount("s1")).toBe(2);
});

test("legacy Dione entries without routing authority are durably quarantined", async () => {
  enqueue("s1", [{
    role: "user",
    text: "old collapsed wrapper",
    source: {
      kind: "dione",
      userId: "syn-id",
      userName: "syn",
      channelId: "moonpool",
      messageId: "m-old",
    },
  }]);

  await runFlush();
  expect(addCalls).toBe(0);
  expect(sentCount("s1")).toBe(1);
  expect(readQuarantine("s1")).toHaveLength(1);
  expect(readQuarantine("s1")[0]).toMatchObject({
    queueIndex: 0,
    reason: "legacy Dione entry lacks scope, receipt, or peer routing authority",
    entry: { text: "old collapsed wrapper" },
  });
});

test("quarantine advancement stores its receipt in the authoritative marker", async () => {
  enqueue("s1", [{
    role: "user",
    text: "A Discord event arrived through Dione.\n\n{}",
  }]);

  await runFlush();
  const marker = JSON.parse(
    readFileSync(join(process.env.HONCHO_CONFIG_DIR!, "codex", "queue", "s1.sent"), "utf-8"),
  );
  expect(marker.count).toBe(1);
  expect(marker.quarantines).toHaveLength(1);
  expect(marker.quarantines[0].entry.text).toContain("Discord event");
});

test("a quarantined legacy entry does not poison later valid messages", async () => {
  enqueue("s1", [
    {
      role: "user",
      text: "old collapsed wrapper",
      source: {
        kind: "dione",
        userId: "unknown",
        userName: "unknown",
        channelId: "moonpool",
        messageId: "m-old",
      },
    },
    { role: "assistant", text: "later valid reply" },
  ]);

  await runFlush();
  expect(batches.flat().map((message) => message.text)).toEqual(["later valid reply"]);
  expect(sentCount("s1")).toBe(2);
  expect(readQuarantine("s1").map((receipt) => receipt.entry.text)).toEqual([
    "old collapsed wrapper",
  ]);
});

test("actual pre-upgrade wrapper shape is quarantined instead of sent as the operator", async () => {
  enqueue("s1", [{
    role: "user",
    text: "A Discord event arrived through Dione.\n\n{\"jsonrpc\":\"2.0\"}",
    at: "2026-07-27T00:00:00Z",
  }]);

  await runFlush();
  expect(batches).toEqual([]);
  expect(sentCount("s1")).toBe(1);
  expect(readQuarantine("s1")[0]).toMatchObject({
    reason: "legacy Dione wrapper lacks authenticated author and scope",
  });
});

test("tool entries get a [tool] prefix and type metadata; user/assistant route to the right peer", async () => {
  enqueue("s1", [
    { role: "user", text: "do the thing", at: "2026-06-09T00:00:00Z" },
    { role: "tool", text: "ran: bun test", at: "2026-06-09T00:00:01Z" },
    { role: "assistant", text: "done", at: "2026-06-09T00:00:02Z" },
  ]);

  await runFlush();
  const msgs = batches.flat();

  expect(msgs[0]).toMatchObject({ peer: "user", text: "do the thing", opts: { createdAt: "2026-06-09T00:00:00Z" } });
  expect(msgs[1]).toMatchObject({ peer: "ai", text: "[tool] ran: bun test", opts: { metadata: { type: "tool" } } });
  expect(msgs[2]).toMatchObject({ peer: "ai", text: "done" });
  expect(msgs[0].opts?.metadata).toBeUndefined();
});

test("routes Dione entries to distinct peers with source metadata", async () => {
  enqueue("s1", [
    {
      role: "user",
      text: "from syn",
      peerId: "syn",
      scopeId: "moonpool",
      receiptId: "dione:message:moonpool:m1",
      source: {
        kind: "dione",
        userId: "syn-id",
        userName: "syn",
        channelId: "moonpool",
        messageId: "m1",
      },
    },
    {
      role: "user",
      text: "from Vesper",
      peerId: "discord-vesper-id",
      scopeId: "moonpool",
      receiptId: "dione:message:moonpool:m2",
      source: {
        kind: "dione",
        userId: "vesper-id",
        userName: "Vesper",
        channelId: "moonpool",
        messageId: "m2",
      },
    },
    {
      role: "assistant",
      text: "from Callisto",
      scopeId: "moonpool",
      receiptId: "codex:s1:turn:2:reply",
    },
  ]);

  await runFlush();
  const msgs = batches.flat();
  expect(msgs.map((message) => [message.peer, message.text])).toEqual([
    ["syn", "from syn"],
    ["discord-vesper-id", "from Vesper"],
    ["ai", "from Callisto"],
  ]);
  expect(msgs[0].opts?.metadata).toMatchObject({
    source: "dione",
    discord_user_id: "syn-id",
    discord_message_id: "m1",
  });
  expect(sentCount("s1")).toBe(3);
});

test("same peer across two Dione scopes writes to separate authorized sessions", async () => {
  enqueue("s1", [
    {
      role: "user",
      text: "private",
      peerId: "syn",
      scopeId: "dm-channel",
      receiptId: "dione:message:dm-channel:m1",
      source: {
        kind: "dione",
        userId: "syn-id",
        userName: "syn",
        channelId: "dm-channel",
        messageId: "m1",
      },
    },
    {
      role: "assistant",
      text: "private reply",
      scopeId: "dm-channel",
      receiptId: "codex:s1:turn:1:private",
    },
    {
      role: "user",
      text: "moonpool",
      peerId: "syn",
      scopeId: "moonpool",
      receiptId: "dione:message:moonpool:m2",
      source: {
        kind: "dione",
        userId: "syn-id",
        userName: "syn",
        channelId: "moonpool",
        messageId: "m2",
      },
    },
    {
      role: "assistant",
      text: "moonpool reply",
      scopeId: "moonpool",
      receiptId: "codex:s1:turn:3:moonpool",
    },
  ]);

  await runFlush();

  expect(batchSessions).toEqual([
    "proj-discord-dm-channel",
    "proj-discord-moonpool",
  ]);
  expect(batches.map((batch) => batch.map((message) => message.text))).toEqual([
    ["private", "private reply"],
    ["moonpool", "moonpool reply"],
  ]);
  expect(memberships).toEqual([
    {
      session: "proj-discord-dm-channel",
      peers: [
        ["codex", { observeMe: true, observeOthers: true }],
        ["syn", { observeMe: true, observeOthers: false }],
      ],
    },
    {
      session: "proj-discord-moonpool",
      peers: [
        ["codex", { observeMe: true, observeOthers: true }],
        ["syn", { observeMe: true, observeOthers: false }],
      ],
    },
  ]);
});

test("splits an oversized message into parts instead of dropping the tail", async () => {
  enqueue("s1", [{ role: "user", text: "x".repeat(30000), at: "2026-06-09T00:00:00Z" }]);
  await runFlush();

  const msgs = batches.flat();
  expect(msgs.length).toBe(2); // ~24000 + remainder, each labeled
  expect(msgs.every((m) => m.text.length <= 24000)).toBe(true);
  // Nothing lost: strip the part labels and the original reassembles.
  const rejoined = msgs.map((m) => m.text.replace(/^\[part \d+\/\d+\] /, "")).join("");
  expect(rejoined).toBe("x".repeat(30000));
  // Still one queue entry → marker advances by 1, not by message count.
  expect(sentCount("s1")).toBe(1);
});

test("an ordinary long turn stays a single message", async () => {
  enqueue("s1", [{ role: "user", text: "x".repeat(20000), at: "2026-06-09T00:00:00Z" }]);
  await runFlush();

  const msgs = batches.flat();
  expect(msgs.length).toBe(1);
  expect(msgs[0].text).toBe("x".repeat(20000)); // no part label, no split
  expect(sentCount("s1")).toBe(1);
});

test("keeps every upload call within Honcho's 100-message limit", async () => {
  // 49 single-message entries build the batch to 49, then one entry whose parts
  // would overflow 100 forces a pre-flush at the entry boundary.
  enqueue("s1", manyEntries(49));
  enqueue("s1", [{ role: "user", text: "x".repeat(60 * 24000), at: "2026-06-09T00:00:00Z" }]);

  await runFlush();

  expect(batches.every((batch) => batch.length <= 100)).toBe(true);
  expect(batches[0].length).toBe(49); // pre-flushed at the boundary before the big entry
  expect(sentCount("s1")).toBe(50);
  expect(pendingCount("s1")).toBe(0);
});

test("clamps a single giant entry to one upload call, never resending it", async () => {
  // ~125 parts unclamped; clamped to the 100-message ceiling so it fits one call.
  enqueue("s1", [{ role: "user", text: "x".repeat(3_000_000), at: "2026-06-09T00:00:00Z" }]);

  await runFlush();

  expect(addCalls).toBe(1);
  expect(batches[0].length).toBe(100);
  // One queue entry, fully uploaded → marker advances by exactly 1.
  expect(sentCount("s1")).toBe(1);
  expect(pendingCount("s1")).toBe(0);
});

test("skips when a live process already holds the lock", async () => {
  enqueue("s1", [{ role: "user", text: "queued", at: "2026-06-09T00:00:00Z" }]);
  // Our own pid is alive, so acquireLock sees a live owner and bails.
  writeFileSync(lockPath("s1"), String(process.pid));

  await runFlush();

  expect(addCalls).toBe(0);
  expect(sentCount("s1")).toBe(0);
});

test("takes over a lock owned by a dead process", async () => {
  enqueue("s1", [{ role: "user", text: "queued", at: "2026-06-09T00:00:00Z" }]);
  // PID 0x7fffffff is not a real process; acquireLock should reclaim the lock.
  writeFileSync(lockPath("s1"), "2147483646");

  await runFlush();

  expect(addCalls).toBe(1);
  expect(sentCount("s1")).toBe(1);
});

test("does not upload when saveMessages is disabled", async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "hch-test", peerName: "tester", saveMessages: false }));
  enqueue("s1", [{ role: "user", text: "queued", at: "2026-06-09T00:00:00Z" }]);

  await runFlush();
  expect(addCalls).toBe(0);
  expect(sentCount("s1")).toBe(0);
});
