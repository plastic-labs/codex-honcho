import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { redactSensitiveText } from "./redact.ts";

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

export function secureQueueStorage(): void {
  const dir = queueDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Tighten a directory created by an older release without inspecting or
  // copying any queued content.
  try { chmodSync(dir, 0o700); } catch {}
}

function secureFile(path: string): void {
  // Tighten existing queue/sent files in place; do not rewrite their content.
  try { chmodSync(path, 0o600); } catch {}
}

export function enqueue(key: string, entries: QueueEntry[]): void {
  if (entries.length === 0) return;
  secureQueueStorage();
  const safeEntries = entries.map((entry) => ({ ...entry, text: redactSensitiveText(entry.text) }));
  const path = queuePath(key);
  appendFileSync(path, safeEntries.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  secureFile(path);
}

export function readQueue(key: string): QueueEntry[] {
  const path = queuePath(key);
  secureQueueStorage();
  secureFile(path);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
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
  const path = sentPath(key);
  secureQueueStorage();
  secureFile(path);
  try {
    const n = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function setSentCount(key: string, n: number): void {
  secureQueueStorage();
  const path = sentPath(key);
  writeFileSync(path, String(n), { mode: 0o600 });
  secureFile(path);
}

// Entries captured but not yet confirmed sent to Honcho.
export function pending(key: string): QueueEntry[] {
  return readQueue(key).slice(sentCount(key));
}

export function pendingCount(key: string): number {
  return Math.max(0, readQueue(key).length - sentCount(key));
}
