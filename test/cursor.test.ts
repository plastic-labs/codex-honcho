import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCursor, selectNewTurns, writeCursor } from "../src/cursor.ts";
import type { RolloutRecord } from "../src/transcript/codex.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-cursor-"));
  process.env.HONCHO_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

const turns = (n: number): RolloutRecord[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `t${i}`,
    recordId: `r${i}`,
  }));

test("first writeback ships every turn", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(4), { seen: [] });
  expect(fresh).toHaveLength(4);
  expect(nextCursor.seen).toEqual(["r0", "r1", "r2", "r3"]);
});

test("subsequent writeback ships only the new tail", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(6), {
    seen: ["r0", "r1", "r2", "r3"],
  });
  expect(fresh.map((t) => t.text)).toEqual(["t4", "t5"]);
  expect(nextCursor.seen).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
});

test("no new turns yields an empty delta", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(4), {
    seen: ["r0", "r1", "r2", "r3"],
  });
  expect(fresh).toHaveLength(0);
  expect(nextCursor.seen).toEqual(["r0", "r1", "r2", "r3"]);
});

test("insertion before the prior tail does not hide the inserted record", () => {
  const inserted = { role: "user", text: "inserted", recordId: "new" } satisfies RolloutRecord;
  const { fresh } = selectNewTurns([turns(4)[0], inserted, ...turns(4).slice(1)], {
    seen: ["r0", "r1", "r2", "r3"],
  });
  expect(fresh).toEqual([inserted]);
});

test("removed records stay seen if they later reappear", () => {
  const cursor = { seen: ["r0", "r1", "r2"] };
  expect(selectNewTurns(turns(1), cursor).fresh).toHaveLength(0);
  expect(selectNewTurns(turns(3), cursor).fresh).toHaveLength(0);
});

test("legacy count cursor seeds stable identities from the observed prefix", () => {
  const cursorDir = join(dir, "codex", "cursors");
  mkdirSync(cursorDir, { recursive: true });
  writeFileSync(join(cursorDir, "s1.json"), JSON.stringify({ count: 2 }));

  expect(readCursor("s1", turns(4))).toEqual({ seen: ["r0", "r1"] });
});

test("cursor replacement leaves valid JSON on disk", () => {
  writeCursor("s1", { seen: ["r0", "r1"] });
  const raw = readFileSync(join(dir, "codex", "cursors", "s1.json"), "utf-8");
  expect(JSON.parse(raw).seen).toEqual(["r0", "r1"]);
});
