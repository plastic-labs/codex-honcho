import { loadConfig, memoryKey } from "../config.ts";
import { readRollout } from "../transcript/codex.ts";
import { readCursor, writeCursor, selectNewTurns } from "../cursor.ts";
import { enqueue } from "../queue.ts";
import { loadPolicy, shouldDrop, capTurn } from "../policy.ts";
import { flush } from "./flush.ts";

interface WritebackInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

// Pure-local: pull the rollout turns not yet captured into the queue and
// advance the rollout cursor. No network — returns how many were enqueued.
// When an ingestion policy is configured, turns it forbids are dropped and long
// turns are capped before enqueue; the cursor still advances past dropped turns
// so they are never re-examined. With no policy present this is a no-op filter
// and behaviour matches the historical default.
export function capture(key: string, rolloutPath: string): number {
  const turns = readRollout(rolloutPath);
  const { fresh, nextCursor } = selectNewTurns(turns, readCursor(key));
  if (fresh.length === 0) return 0;

  const policy = loadPolicy();
  const kept = fresh
    .filter((t) => !shouldDrop(t.text, policy))
    .map((t) => ({ role: t.role, text: capTurn(t.text, policy), at: t.at }));

  if (kept.length > 0) enqueue(key, kept);
  writeCursor(key, nextCursor);
  return kept.length;
}

// Stop / PreCompact (turn-scoped): capture this turn's new rollout tail into
// the queue, then flush inline. Codex kills detached children when the hook
// returns, so the upload must run in-process. Stop fires after the model has
// already responded, so this brief upload doesn't lag the visible turn — and
// it drains any observations queued during the turn too.
export async function writeback(input: WritebackInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";
  if (!input.transcript_path) return "";

  const cwd = input.cwd || process.cwd();
  capture(memoryKey(config, cwd, input.session_id), input.transcript_path);
  await flush({ cwd, session_id: input.session_id });
  return "";
}
