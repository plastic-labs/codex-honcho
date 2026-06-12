import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

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

export function enqueue(key: string, entries: QueueEntry[]): void {
  if (entries.length === 0) return;
  mkdirSync(queueDir(), { recursive: true });
  appendFileSync(queuePath(key), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

export function readQueue(key: string): QueueEntry[] {
  try {
    return readFileSync(queuePath(key), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as QueueEntry);
  } catch {
    return [];
  }
}

export function sentCount(key: string): number {
  try {
    const n = parseInt(readFileSync(sentPath(key), "utf-8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function setSentCount(key: string, n: number): void {
  mkdirSync(queueDir(), { recursive: true });
  writeFileSync(sentPath(key), String(n));
}

// Entries captured but not yet confirmed sent to Honcho.
export function pending(key: string): QueueEntry[] {
  return readQueue(key).slice(sentCount(key));
}

export function pendingCount(key: string): number {
  return Math.max(0, readQueue(key).length - sentCount(key));
}
