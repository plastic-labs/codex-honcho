import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { getSession } from "../memory.ts";
import { readQueue, sentCount, setSentCount, queueDir } from "../queue.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

const MAX_CHARS = 4000;
const CHUNK_SIZE = 25;

// Split an oversized body into <=MAX_CHARS pieces, preferring a newline/space
// boundary, so a long turn is preserved across parts instead of truncated.
function chunkText(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.25) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.25) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.map((c, i) => `[part ${i + 1}/${chunks.length}] ${c}`);
}

export function lockPath(key: string): string {
  return join(queueDir(), `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.lock`);
}

// Single-flusher lock: skip if another flush holds it (dead owners are taken
// over). Prevents two concurrent flushes from double-sending the same entries.
function acquireLock(key: string): boolean {
  const path = lockPath(key);
  try {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(path, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    try {
      const owner = parseInt(readFileSync(path, "utf-8").trim(), 10);
      process.kill(owner, 0); // throws if the owner is gone
      return false;
    } catch {
      try {
        writeFileSync(path, String(process.pid));
        return true;
      } catch {
        return false;
      }
    }
  }
}

function releaseLock(key: string): void {
  try {
    unlinkSync(lockPath(key));
  } catch {
    // already gone
  }
}

// Background worker: drain pending queue entries to Honcho, in order, and
// advance the sent marker only on success so failures retry next time.
export async function flush(input: FlushInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd, input.session_id);
  const key = memoryKey(config, cwd, input.session_id);

  if (!acquireLock(key)) return "";
  try {
    const all = readQueue(key);
    let start = sentCount(key);
    if (all.length - start <= 0) return "";

    const { session, userPeer, aiPeer } = await getSession(config, name);

    // Upload in bounded chunks, advancing the sent marker after each so a
    // failure mid-drain keeps partial progress and retries from the right spot.
    for (let i = start; i < all.length; i += CHUNK_SIZE) {
      const chunk = all.slice(i, i + CHUNK_SIZE);
      const messages = chunk.flatMap((entry) => {
        const peer = entry.role === "user" ? userPeer : aiPeer;
        const body = entry.role === "tool" ? `[tool] ${entry.text}` : entry.text;
        return chunkText(body).map((piece) =>
          peer.message(piece, {
            createdAt: entry.at,
            ...(entry.role === "tool" ? { metadata: { type: "tool" } } : {}),
          }),
        );
      });
      await session.addMessages(messages);
      start += chunk.length;
      setSentCount(key, start);
    }
  } finally {
    releaseLock(key);
  }
  return "";
}
