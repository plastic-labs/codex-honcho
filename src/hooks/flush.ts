import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { getSession } from "../memory.ts";
import { readQueue, sentCount, setSentCount, queueDir, type QueueEntry } from "../queue.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

const MAX_CHARS = 4000;
const CHUNK_SIZE = 25;

type SessionHandles = Awaited<ReturnType<typeof getSession>>;
type PeerMessage = ReturnType<SessionHandles["userPeer"]["message"]>;

interface PartialProgress {
  entryIndex: number;
  messageIndex: number;
}

interface BatchProgress {
  sentCount: number;
  partial: PartialProgress | null;
}

// Split an oversized body into <=MAX_CHARS pieces, preferring a newline/space
// boundary, so a long turn is preserved across parts instead of truncated.
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

function partialPath(key: string): string {
  return join(queueDir(), `${safeKey(key)}.partial`);
}

function readPartialProgress(key: string, minEntry: number, totalEntries: number): PartialProgress | null {
  try {
    const parsed = JSON.parse(readFileSync(partialPath(key), "utf-8")) as PartialProgress;
    if (
      Number.isInteger(parsed.entryIndex) &&
      Number.isInteger(parsed.messageIndex) &&
      parsed.entryIndex >= minEntry &&
      parsed.entryIndex < totalEntries &&
      parsed.messageIndex > 0
    ) {
      return parsed;
    }
  } catch {
    // no partial progress
  }
  return null;
}

function setPartialProgress(key: string, progress: PartialProgress): void {
  mkdirSync(queueDir(), { recursive: true });
  writeFileSync(partialPath(key), JSON.stringify(progress));
}

function clearPartialProgress(key: string): void {
  try {
    unlinkSync(partialPath(key));
  } catch {
    // already gone
  }
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
    const partial = readPartialProgress(key, start, all.length);
    const startEntry = partial?.entryIndex ?? start;
    if (all.length - startEntry <= 0) {
      clearPartialProgress(key);
      return "";
    }

    const { session, userPeer, aiPeer } = await getSession(config, name);
    let batch: PeerMessage[] = [];
    let progressAfterBatch: BatchProgress = { sentCount: start, partial };

    async function uploadBatch(): Promise<void> {
      if (batch.length === 0) return;
      await session.addMessages(batch);
      setSentCount(key, progressAfterBatch.sentCount);
      if (progressAfterBatch.partial) setPartialProgress(key, progressAfterBatch.partial);
      else clearPartialProgress(key);
      batch = [];
    }

    // Upload in bounded Honcho-message chunks. The sent marker still tracks
    // fully uploaded queue entries; .partial tracks the rare case where one
    // queue entry expands across multiple upload calls.
    for (let i = startEntry; i < all.length; i++) {
      const messages = messagesForEntry(all[i], userPeer, aiPeer);
      const messageStart = partial?.entryIndex === i ? partial.messageIndex : 0;
      for (let j = messageStart; j < messages.length; j++) {
        batch.push(messages[j]);
        progressAfterBatch =
          j === messages.length - 1
            ? { sentCount: i + 1, partial: null }
            : { sentCount: i, partial: { entryIndex: i, messageIndex: j + 1 } };
        if (batch.length === CHUNK_SIZE) await uploadBatch();
      }
    }
    await uploadBatch();
  } finally {
    releaseLock(key);
  }
  return "";
}
