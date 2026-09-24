import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Turn } from "./transcript/codex.ts";

// Codex fires Stop every turn with no final SessionEnd, so writeback runs
// repeatedly over a growing rollout. The cursor records how many turns we've
// already shipped for a session, so each Stop uploads only the new tail.

function cursorDir(): string {
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "cursors");
}

function cursorPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(cursorDir(), `${safe}.json`);
}

// Version 2 counts turns under per-block injected-context filtering. A cursor
// without it was counted by an older filter and must be migrated before use.
export const CURSOR_VERSION = 2;

export interface CursorState {
  count: number;
  legacy: boolean;
}

export function readCursorState(sessionId: string): CursorState {
  try {
    const { version, count } = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8"));
    return { count: typeof count === "number" && count >= 0 ? count : 0, legacy: version !== CURSOR_VERSION };
  } catch {
    return { count: 0, legacy: false };
  }
}

export function readCursor(sessionId: string): number {
  return readCursorState(sessionId).count;
}

export function writeCursor(sessionId: string, count: number): void {
  mkdirSync(cursorDir(), { recursive: true });
  writeFileSync(cursorPath(sessionId), JSON.stringify({ version: CURSOR_VERSION, count, at: new Date().toISOString() }));
}

export interface Delta {
  fresh: Turn[];
  nextCursor: number;
}

// Pure: pick the turns not yet uploaded. A shrunken transcript (cursor past
// the end, e.g. a cleared session) resets to the full set.
export function selectNewTurns(turns: Turn[], cursor: number): Delta {
  const start = cursor <= turns.length ? cursor : 0;
  return { fresh: turns.slice(start), nextCursor: turns.length };
}
