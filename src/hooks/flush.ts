import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { getSession } from "../memory.ts";
import { readQueue, sentCount, setSentCount, queueDir, type QueueEntry } from "../queue.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

// Honcho's per-message content ceiling is ~25k chars; stay just under it.
const MAX_CHARS = 24000;
// Honcho rejects an addMessages call with more than 100 messages. SOFT_BATCH is
// the flush target; MAX_BATCH is the hard ceiling we never cross in one call.
const SOFT_BATCH = 50;
const MAX_BATCH = 100;

type SessionHandles = Awaited<ReturnType<typeof getSession>>;
type PeerMessage = ReturnType<SessionHandles["userPeer"]["message"]>;

// Split an oversized body into <=MAX_CHARS pieces, preferring a newline/space
// boundary, so a long turn is preserved across parts instead of truncated.
// Capped at MAX_BATCH parts so one queue entry never exceeds a single upload
// call — a >2.4MB single turn (effectively impossible) drops its overflow tail.
function chunkText(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  let total = 1;
  let chunks: string[] = [];
  for (;;) {
    const labelBudget = `[part ${total}/${total}] `.length;
    const payloadMax = Math.max(1, max - labelBudget);
    chunks = splitText(text, payloadMax);
    if (chunks.length === total || `[part ${chunks.length}/${chunks.length}] `.length === labelBudget) {
      total = chunks.length;
      break;
    }
    total = chunks.length;
  }
  if (chunks.length > MAX_BATCH) chunks = chunks.slice(0, MAX_BATCH);
  total = chunks.length;
  return chunks.map((c, i) => `[part ${i + 1}/${total}] ${c}`);
}

function splitText(text: string, max: number): string[] {
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
  return chunks;
}

function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function lockPath(key: string): string {
  return join(queueDir(), `${safeKey(key)}.lock`);
}

function messagesForEntry(
  entry: QueueEntry,
  userPeer: SessionHandles["userPeer"],
  aiPeer: SessionHandles["aiPeer"],
): PeerMessage[] {
  const peer = entry.role === "user" ? userPeer : aiPeer;
  const body = entry.role === "tool" ? `[tool] ${entry.text}` : entry.text;
  return chunkText(body).map((piece) =>
    peer.message(piece, {
      createdAt: entry.at,
      ...(entry.role === "tool" ? { metadata: { type: "tool" } } : {}),
    }),
  );
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
    const start = sentCount(key);
    if (all.length - start <= 0) return "";

    const { session, userPeer, aiPeer } = await getSession(config, name);
    let batch: PeerMessage[] = [];

    // Drain pending entries in order, flushing only at entry boundaries so the
    // sent marker always lands on a fully-uploaded entry — a failure mid-drain
    // just retries from the last completed entry, no sub-entry bookkeeping.
    // SOFT_BATCH is the flush target; the pre-flush guard keeps any single call
    // within Honcho's MAX_BATCH messages-per-request limit.
    for (let i = start; i < all.length; i++) {
      const messages = messagesForEntry(all[i], userPeer, aiPeer);
      if (batch.length > 0 && batch.length + messages.length > MAX_BATCH) {
        await session.addMessages(batch);
        setSentCount(key, i);
        batch = [];
      }
      batch.push(...messages);
      if (batch.length >= SOFT_BATCH) {
        await session.addMessages(batch);
        setSentCount(key, i + 1);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await session.addMessages(batch);
      setSentCount(key, all.length);
    }
  } finally {
    releaseLock(key);
  }
  return "";
}
