import { loadConfig, sessionName } from "../config.ts";
import { openSession } from "../memory.ts";
import { readRollout } from "../transcript/codex.ts";
import { readCursor, writeCursor, selectNewTurns } from "../cursor.ts";

interface WritebackInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
}

const MAX_CHARS = 4000;

// Stop (turn-scoped): ship the turns added since the last writeback.
export async function writeback(input: WritebackInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";
  if (!input.transcript_path) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);
  const cursorKey = input.session_id || name;

  const turns = readRollout(input.transcript_path);
  const { fresh, nextCursor } = selectNewTurns(turns, readCursor(cursorKey));
  if (fresh.length === 0) return "";

  const { session, userPeer, aiPeer } = await openSession(config, name);
  const messages = fresh.map((turn) => {
    const peer = turn.role === "user" ? userPeer : aiPeer;
    return peer.message(turn.text.slice(0, MAX_CHARS), { createdAt: turn.at });
  });

  await session.addMessages(messages);
  writeCursor(cursorKey, nextCursor);
  return "";
}
