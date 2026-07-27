import { loadConfig, memoryKey } from "../config.ts";
import { readRolloutRecords } from "../transcript/codex.ts";
import { readCursor, writeCursor, selectNewTurns } from "../cursor.ts";
import { enqueue } from "../queue.ts";
import { flush } from "./flush.ts";
import { createHash } from "node:crypto";

interface WritebackInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

// Pure-local: pull the rollout turns not yet captured into the queue and
// advance the rollout cursor. No network — returns how many were enqueued.
function dionePeerId(userId: string, peers: Record<string, string>): string {
  const configured = peers[userId]?.trim();
  return configured || `discord-${userId}`;
}

function turnReceipt(key: string, recordId: string): string {
  const digest = createHash("sha256")
    .update(recordId)
    .digest("hex")
    .slice(0, 16);
  return `codex:${key}:record:${digest}`;
}

export function capture(
  key: string,
  rolloutPath: string,
  dionePeers: Record<string, string> = {},
  dioneRouting = false,
): number {
  const turns = readRolloutRecords(rolloutPath);
  const { fresh, nextCursor } = selectNewTurns(turns, readCursor(key, turns));
  if (fresh.length === 0) return 0;
  const freshIds = new Set(fresh.map((turn) => turn.recordId));
  let activeScope: string | undefined;
  const entries = turns.flatMap((t, index) => {
    if (t.role === "user") activeScope = t.source?.channelId;
    if (!freshIds.has(t.recordId)) return [];
    if (t.persist === false) return [];
    if (dioneRouting && t.role === "assistant" && !activeScope) {
      console.warn(
        `[codex-honcho] suppressed unscoped assistant record ${t.recordId} while Dione routing is active`,
      );
      return [];
    }
    return [{
      role: t.role,
      text: t.text,
      at: t.at,
      receiptId: t.source
        ? `dione:message:${t.source.channelId}:${t.source.messageId}`
        : turnReceipt(key, t.recordId),
      ...(activeScope ? { scopeId: activeScope } : {}),
      ...(t.source ? {
        peerId: dionePeerId(t.source.userId, dionePeers),
        source: t.source,
      } : {}),
    }];
  });
  enqueue(key, entries);
  writeCursor(key, nextCursor);
  return entries.length;
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
  capture(
    memoryKey(config, cwd, input.session_id),
    input.transcript_path,
    config.dionePeers,
    config.dioneRouting,
  );
  await flush({ cwd, session_id: input.session_id });
  return "";
}
