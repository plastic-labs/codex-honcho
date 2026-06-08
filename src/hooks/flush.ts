import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { openSession } from "../memory.ts";
import { readQueue, sentCount, setSentCount, queueDir } from "../queue.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

const MAX_CHARS = 4000;
const CHUNK_SIZE = 25;

function lockPath(key: string): string {
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
  const name = sessionName(config, cwd);
  const key = memoryKey(config, cwd, input.session_id);

  if (!acquireLock(key)) return "";
  try {
    const all = readQueue(key);
    let start = sentCount(key);
    if (all.length - start <= 0) return "";

    const { session, userPeer, aiPeer } = await openSession(config, name);

    // Upload in bounded chunks, advancing the sent marker after each so a
    // failure mid-drain keeps partial progress and retries from the right spot.
    for (let i = start; i < all.length; i += CHUNK_SIZE) {
      const chunk = all.slice(i, i + CHUNK_SIZE);
      const messages = chunk.map((entry) => {
        const peer = entry.role === "user" ? userPeer : aiPeer;
        const text = entry.role === "tool" ? `[tool] ${entry.text}` : entry.text;
        return peer.message(text.slice(0, MAX_CHARS), {
          createdAt: entry.at,
          ...(entry.role === "tool" ? { metadata: { type: "tool" } } : {}),
        });
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
