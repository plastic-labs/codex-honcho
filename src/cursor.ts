import { homedir } from "node:os";
import { join } from "node:path";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

export function readCursor(sessionId: string, turns: RolloutRecord[] = []): Cursor {
  try {
    const value = JSON.parse(readFileSync(cursorPath(sessionId), "utf-8"));
    if (Array.isArray(value.seen) && value.seen.every((id: unknown) => typeof id === "string")) {
      return { seen: value.seen };
    }
    // Upgrade the original count-only cursor without replaying the already
    // observed prefix. Stable identities make future insertions safe.
    if (typeof value.count === "number" && Number.isFinite(value.count) && value.count >= 0) {
      return { seen: turns.slice(0, value.count).map((turn) => turn.recordId) };
    }
    return { seen: [] };
  } catch {
    return { seen: [] };
  }
}

export function writeCursor(sessionId: string, cursor: Cursor): void {
  mkdirSync(cursorDir(), { recursive: true });
  const path = cursorPath(sessionId);
  const temporary = `${path}.${process.pid}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temporary, JSON.stringify({
      seen: cursor.seen,
      at: new Date().toISOString(),
    }));
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    renamed = true;
    try {
      const directory = openSync(cursorDir(), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch {
      // Directory fsync is a durability enhancement that is not supported on
      // every platform. The atomically replaced cursor remains authoritative.
    }
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to clean up.
      }
    }
  }
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
