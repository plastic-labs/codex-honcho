import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCursorState, selectNewTurns, writeCursor } from "../src/cursor.ts";
import type { Turn } from "../src/transcript/codex.ts";

const turns = (n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `t${i}` }));

test("first writeback ships every turn", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(4), 0);
  expect(fresh).toHaveLength(4);
  expect(nextCursor).toBe(4);
});

test("subsequent writeback ships only the new tail", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(6), 4);
  expect(fresh.map((t) => t.text)).toEqual(["t4", "t5"]);
  expect(nextCursor).toBe(6);
});

test("no new turns yields an empty delta", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(4), 4);
  expect(fresh).toHaveLength(0);
  expect(nextCursor).toBe(4);
});

test("a shrunken transcript (cursor past end) resets to the full set", () => {
  const { fresh, nextCursor } = selectNewTurns(turns(2), 5);
  expect(fresh).toHaveLength(2);
  expect(nextCursor).toBe(2);
});

test("cursors carry a version so a filter change can migrate older ones", () => {
  const saved = process.env.HONCHO_CONFIG_DIR;
  process.env.HONCHO_CONFIG_DIR = mkdtempSync(join(tmpdir(), "codex-honcho-cursor-"));
  try {
    writeCursor("s", 3);
    expect(readCursorState("s")).toEqual({ count: 3, legacy: false });
    const cursors = join(process.env.HONCHO_CONFIG_DIR, "codex", "cursors");
    writeFileSync(join(cursors, "old.json"), JSON.stringify({ count: 2, at: "2026-09-01T00:00:00.000Z" }));
    expect(readCursorState("old")).toEqual({ count: 2, legacy: true });
    expect(readCursorState("missing")).toEqual({ count: 0, legacy: false });
  } finally {
    if (saved === undefined) delete process.env.HONCHO_CONFIG_DIR;
    else process.env.HONCHO_CONFIG_DIR = saved;
  }
});
