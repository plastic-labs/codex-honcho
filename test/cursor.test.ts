import { test, expect } from "bun:test";
import { selectNewTurns } from "../src/cursor.ts";
import type { RolloutRecord } from "../src/transcript/codex.ts";

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
