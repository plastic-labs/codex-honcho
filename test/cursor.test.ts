import { test, expect } from "bun:test";
import { selectNewTurns } from "../src/cursor.ts";
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
