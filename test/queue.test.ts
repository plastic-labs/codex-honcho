import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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

test("enqueue redacts secrets at the durable storage boundary", () => {
  const secret = `hch-${"Qw7".repeat(8)}`;
  enqueue("k", [{ role: "user", text: `credential=${secret}` }]);
  const text = readQueue("k")[0].text;
  expect(text).not.toContain(secret);
  expect(text).toContain("[REDACTED]");
});

test("queue directory and new queue/sent files use private permissions", () => {
  enqueue("private", [{ role: "user", text: "hello" }]);
  setSentCount("private", 1);
  const root = join(process.env.HONCHO_CONFIG_DIR!, "codex", "queue");
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "private.jsonl")).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "private.sent")).mode & 0o777).toBe(0o600);
});

test("enqueue tightens permissions created by an older release in place", () => {
  const root = join(process.env.HONCHO_CONFIG_DIR!, "codex", "queue");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  chmodSync(root, 0o755);
  enqueue("legacy", [{ role: "user", text: "preserved" }]);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "legacy.jsonl")).mode & 0o777).toBe(0o600);
  expect(readQueue("legacy")[0].text).toBe("preserved");
});

test("readback tightens existing queue and sent files without rewriting content", () => {
  const root = join(process.env.HONCHO_CONFIG_DIR!, "codex", "queue");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const queue = join(root, "old.jsonl");
  const sent = join(root, "old.sent");
  writeFileSync(queue, `${JSON.stringify({ role: "user", text: "legacy text" })}\n`, { mode: 0o644 });
  writeFileSync(sent, "0", { mode: 0o644 });
  chmodSync(queue, 0o644);
  chmodSync(sent, 0o644);

  expect(readQueue("old")[0].text).toBe("legacy text");
  expect(sentCount("old")).toBe(0);
  expect(statSync(queue).mode & 0o777).toBe(0o600);
  expect(statSync(sent).mode & 0o777).toBe(0o600);
});
