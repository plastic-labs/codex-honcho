import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

// A durable, human-readable outbox. Capture hooks append here instantly (local,
// no network) so everything recorded is visible live (`tail -f`); a background
// flush drains pending entries to Honcho and advances a sent high-water-mark.
// Unsent entries stay put and retry on the next flush.

export function queueDir(): string {
  return join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "queue");
}

export interface QueueEntry {
  role: "user" | "assistant" | "tool";
  text: string;
  at?: string;
  peerId?: string;
  // Stable across retries of the same captured rollout event. This is also
  // written into Honcho message metadata so a retry after remote acceptance
  // but before local acknowledgement can detect and skip the prior write.
  receiptId?: string;
  // Explicit conversation authority. Discord channel/DM/thread IDs are kept
  // separate from peer identity so the same peer can participate in multiple
  // sessions without any session inheriting another's history.
  scopeId?: string;
  source?: {
    kind: "dione";
    userId: string;
    userName: string;
    channelId: string;
    messageId: string;
    occurredAt?: string;
  };
}

// Turn a memory key (which can contain "/", ":", ".", spaces from repo paths,
// branches, and session ids) into a safe filename stem. The lock file in
// flush.ts must use this same transform to sit alongside its queue files.
export function safe(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function queuePath(key: string): string {
  return join(queueDir(), `${safe(key)}.jsonl`);
}

function sentPath(key: string): string {
  return join(queueDir(), `${safe(key)}.sent`);
}

function quarantinePath(key: string): string {
  return join(queueDir(), `${safe(key)}.quarantine.jsonl`);
}

export function enqueue(key: string, entries: QueueEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(queueDir(), { recursive: true });
  appendFileSync(queuePath(key), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function readQueue(key: string): QueueEntry[] {
  let raw: string;
  try {
    raw = readFileSync(queuePath(key), "utf-8");
  } catch {
    return [];
  }
  const entries: QueueEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as QueueEntry);
    } catch {
      // Skip a torn line (a write interrupted mid-append) instead of letting one
      // bad line drop the whole queue from the readback.
    }
  }
  return entries;
}

export function sentCount(key: string): number {
  try {
    const raw = readFileSync(sentPath(key), "utf-8").trim();
    const parsed = JSON.parse(raw) as { count?: unknown };
    const n = typeof parsed.count === "number" ? parsed.count : Number.NaN;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    try {
      // Backward compatibility with the original integer-only marker.
      const n = parseInt(readFileSync(sentPath(key), "utf-8").trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }
}

interface SentState {
  count: number;
  quarantines: QuarantineReceipt[];
}

function readSentState(key: string): SentState {
  try {
    const raw = readFileSync(sentPath(key), "utf-8").trim();
    const parsed = JSON.parse(raw) as Partial<SentState>;
    return {
      count: typeof parsed.count === "number" && parsed.count >= 0 ? parsed.count : 0,
      quarantines: Array.isArray(parsed.quarantines) ? parsed.quarantines : [],
    };
  } catch {
    return { count: sentCount(key), quarantines: [] };
  }
}

function writeSentState(key: string, state: SentState): void {
  mkdirSync(queueDir(), { recursive: true });
  const path = sentPath(key);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  const file = openSync(temporary, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(queueDir(), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function setSentCount(key: string, n: number): void {
  const state = readSentState(key);
  writeSentState(key, { ...state, count: n });
}

export interface QuarantineReceipt {
  queueIndex: number;
  reason: string;
  entry: QueueEntry;
  quarantinedAt: string;
}

// Preserve an entry that cannot be safely routed before advancing past it.
// The receipt is appended first, so the original is never silently discarded.
export function quarantine(
  key: string,
  queueIndex: number,
  entry: QueueEntry,
  reason: string,
): void {
  mkdirSync(queueDir(), { recursive: true });
  const receipt: QuarantineReceipt = {
    queueIndex,
    reason,
    entry,
    quarantinedAt: new Date().toISOString(),
  };
  appendFileSync(quarantinePath(key), JSON.stringify(receipt) + "\n");
}

// Commit the quarantine receipt and queue advancement in one atomic marker
// replacement. A crash can leave the old state or the new state, never an
// advanced cursor without its receipt.
export function quarantineAndSetSentCount(
  key: string,
  queueIndex: number,
  entry: QueueEntry,
  reason: string,
): void {
  const state = readSentState(key);
  const receipt: QuarantineReceipt = {
    queueIndex,
    reason,
    entry,
    quarantinedAt: new Date().toISOString(),
  };
  writeSentState(key, {
    count: queueIndex + 1,
    quarantines: [...state.quarantines, receipt],
  });
}

export function readQuarantine(key: string): QuarantineReceipt[] {
  let raw: string;
  try {
    raw = readFileSync(quarantinePath(key), "utf-8");
  } catch {
    return readSentState(key).quarantines;
  }
  const legacy = raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as QuarantineReceipt];
    } catch {
      return [];
    }
  });
  const durable = readSentState(key).quarantines;
  const seen = new Set(legacy.map((receipt) => `${receipt.queueIndex}:${receipt.reason}`));
  return [
    ...legacy,
    ...durable.filter((receipt) => !seen.has(`${receipt.queueIndex}:${receipt.reason}`)),
  ];
}

// Entries captured but not yet confirmed sent to Honcho.
export function pending(key: string): QueueEntry[] {
  return readQueue(key).slice(sentCount(key));
}

export function pendingCount(key: string): number {
  return Math.max(0, readQueue(key).length - sentCount(key));
}
