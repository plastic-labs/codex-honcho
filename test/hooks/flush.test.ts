import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enqueue, sentCount, pendingCount, setSentCount } from "../../src/queue.ts";
import { lockPath } from "../../src/hooks/flush.ts";

// Captured by the mocked memory boundary so flush never hits the network.
interface SentMsg {
  peer: "user" | "ai";
  text: string;
  opts?: { createdAt?: string; metadata?: { type?: string } };
}
let batches: SentMsg[][] = [];
let addCalls = 0;
let failOnCalls = new Set<number>();

mock.module("../../src/memory.ts", () => ({
  getSession: async () => ({
    session: {
      addMessages: async (msgs: SentMsg[]) => {
        addCalls += 1;
        if (failOnCalls.has(addCalls)) throw new Error("simulated upload failure");
        batches.push(msgs);
      },
    },
    userPeer: { message: (text: string, opts?: SentMsg["opts"]) => ({ peer: "user", text, opts }) },
    aiPeer: { message: (text: string, opts?: SentMsg["opts"]) => ({ peer: "ai", text, opts }) },
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
  addCalls = 0;
  failOnCalls = new Set();
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

test("uploads in chunks of 25 and advances the marker per chunk", async () => {
  enqueue("s1", manyEntries(30));

  await runFlush();

  expect(addCalls).toBe(2);
  expect(batches[0].length).toBe(25);
  expect(batches[1].length).toBe(5);
  expect(sentCount("s1")).toBe(30);
});

test("a mid-drain failure keeps partial progress and resends only the remainder", async () => {
  enqueue("s1", manyEntries(30));
  failOnCalls = new Set([2]); // first chunk lands, second throws

  await expect(runFlush()).rejects.toThrow();

  // First chunk's marker advanced; the failed chunk is still pending.
  expect(sentCount("s1")).toBe(25);
  expect(pendingCount("s1")).toBe(5);

  // Retry: only the remaining 5 go up, no re-send of the first 25.
  batches = [];
  await runFlush();
  expect(batches.flat().length).toBe(5);
  expect(batches.flat().map((m) => m.text)).toEqual(["m25", "m26", "m27", "m28", "m29"]);
  expect(sentCount("s1")).toBe(30);
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

test("splits an oversized message into parts instead of dropping the tail", async () => {
  enqueue("s1", [{ role: "user", text: "x".repeat(5000), at: "2026-06-09T00:00:00Z" }]);
  await runFlush();

  const msgs = batches.flat();
  expect(msgs.length).toBe(2); // 4000 + 1000, each labeled
  // Nothing lost: strip the part labels and the original reassembles.
  const rejoined = msgs.map((m) => m.text.replace(/^\[part \d+\/\d+\] /, "")).join("");
  expect(rejoined).toBe("x".repeat(5000));
  // Still one queue entry → marker advances by 1, not by message count.
  expect(sentCount("s1")).toBe(1);
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
