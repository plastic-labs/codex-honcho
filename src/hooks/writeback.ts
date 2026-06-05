import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { readRollout } from "../transcript/codex.ts";
import { readCursor, writeCursor, selectNewTurns } from "../cursor.ts";
import { enqueue } from "../queue.ts";
import { runDetached } from "../background.ts";

interface WritebackInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

// Pure-local: pull the rollout turns not yet captured into the queue and
// advance the rollout cursor. No network — returns how many were enqueued.
export function capture(key: string, rolloutPath: string): number {
  const turns = readRollout(rolloutPath);
  const { fresh, nextCursor } = selectNewTurns(turns, readCursor(key));
  if (fresh.length === 0) return 0;
  enqueue(key, fresh.map((t) => ({ role: t.role, text: t.text, at: t.at })));
  writeCursor(key, nextCursor);
  return fresh.length;
}

// Stop / PreCompact (turn-scoped): capture this turn's new rollout tail into
// the queue instantly, then kick a background flush. The upload never blocks.
export async function writeback(input: WritebackInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";
  if (!input.transcript_path) return "";

  const cwd = input.cwd || process.cwd();
  const key = memoryKey(config, cwd, input.session_id);

  if (capture(key, input.transcript_path) > 0) {
    runDetached("flush", JSON.stringify({ cwd, session_id: input.session_id }));
  }
  return "";
}
