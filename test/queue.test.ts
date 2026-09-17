import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enqueue, readQueue, pending, pendingCount, sentCount, setSentCount } from "../src/queue.ts";

const savedDir = process.env.HONCHO_CONFIG_DIR;

beforeEach(() => {
  process.env.HONCHO_CONFIG_DIR = mkdtempSync(join(tmpdir(), "codex-honcho-q-"));
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("enqueue appends and readQueue returns in order", () => {
  enqueue("k", [{ role: "user", text: "a" }, { role: "assistant", text: "b" }]);
  enqueue("k", [{ role: "tool", text: "ran: bun test" }]);
  expect(readQueue("k").map((e) => e.text)).toEqual(["a", "b", "ran: bun test"]);
});

test("pending reflects unsent entries past the sent marker", () => {
  enqueue("k", [{ role: "user", text: "a" }, { role: "assistant", text: "b" }, { role: "user", text: "c" }]);
  expect(pendingCount("k")).toBe(3);
  setSentCount("k", 2);
  expect(pending("k").map((e) => e.text)).toEqual(["c"]);
  expect(pendingCount("k")).toBe(1);
});

test("append-only: new entries after a partial send are still pending", () => {
  enqueue("k", [{ role: "user", text: "a" }]);
  setSentCount("k", 1);
  enqueue("k", [{ role: "assistant", text: "b" }]);
  expect(pendingCount("k")).toBe(1);
  expect(pending("k")[0].text).toBe("b");
});

test("empty enqueue is a no-op", () => {
  enqueue("k", []);
  expect(readQueue("k")).toEqual([]);
  expect(sentCount("k")).toBe(0);
});

test("missing queue reads as empty", () => {
  expect(readQueue("nope")).toEqual([]);
  expect(pendingCount("nope")).toBe(0);
});

test("legacy integer-only sent marker survives upgrade", () => {
  const queueDir = join(process.env.HONCHO_CONFIG_DIR!, "codex", "queue");
  mkdirSync(queueDir, { recursive: true });
  writeFileSync(join(queueDir, "k.sent"), "2");
  enqueue("k", [
    { role: "user", text: "already sent 1" },
    { role: "assistant", text: "already sent 2" },
    { role: "user", text: "pending" },
  ]);

  expect(sentCount("k")).toBe(2);
  expect(pending("k").map((entry) => entry.text)).toEqual(["pending"]);
});
