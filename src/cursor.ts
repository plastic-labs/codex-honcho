import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RolloutRecord } from "./transcript/codex.ts";

// Codex fires Stop every turn with no final SessionEnd, so writeback runs
// repeatedly over a growing rollout. The cursor records stable rollout record
// identities rather than a count, because earlier records can be inserted,
// removed, or replaced between hook runs.

function cursorDir(): string {
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "cursors");
}

function cursorPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(cursorDir(), `${safe}.json`);
}

export interface Cursor {
  seen: string[];
}

export function readCursor(sessionId: string): Cursor {
  try {
    const value = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8"));
    if (Array.isArray(value.seen) && value.seen.every((id: unknown) => typeof id === "string")) {
      return { seen: value.seen };
    }
    // A count-only cursor cannot safely identify which records it observed.
    // Re-read and rely on queue/remote receipt deduplication during migration.
    return { seen: [] };
  } catch {
    return { seen: [] };
  }
}

export function writeCursor(sessionId: string, cursor: Cursor): void {
  mkdirSync(cursorDir(), { recursive: true });
  writeFileSync(cursorPath(sessionId), JSON.stringify({
    seen: cursor.seen,
    at: new Date().toISOString(),
  }));
}

export interface Delta {
  fresh: RolloutRecord[];
  nextCursor: Cursor;
}

// Pure: pick records whose stable identities have not been observed. Preserve
// identities for records no longer in the transcript so a later reappearance
// cannot be mistaken for a new turn.
export function selectNewTurns(turns: RolloutRecord[], cursor: Cursor): Delta {
  const seen = new Set(cursor.seen);
  const fresh = turns.filter((turn) => !seen.has(turn.recordId));
  return {
    fresh,
    nextCursor: {
      seen: [...cursor.seen, ...fresh.map((turn) => turn.recordId)],
    },
  };
}
