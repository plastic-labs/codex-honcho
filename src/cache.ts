import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Session-start context is cached so a resume/clear doesn't re-fetch, and so
// the per-prompt hook (when enabled) can serve instantly without a network
// round trip. lastInjected dedupes repeat injections.

const CACHE_DIR = join(process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho"), "codex", "context");

export interface CachedContext {
  representation?: string | null;
  peerCard?: string[] | null;
  at: number;
  lastInjected?: string;
}

function cachePath(key: string): string {
  return join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

export function readContext(key: string): CachedContext | null {
  try {
    return JSON.parse(readFileSync(cachePath(key), "utf-8")) as CachedContext;
  } catch {
    return null;
  }
}

export function writeContext(key: string, representation?: string | null, peerCard?: string[] | null): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const prev = readContext(key);
  writeFileSync(
    cachePath(key),
    JSON.stringify({ representation, peerCard, at: Date.now(), lastInjected: prev?.lastInjected }),
  );
}

export function isStale(key: string, ttlMs: number): boolean {
  const c = readContext(key);
  return !c || Date.now() - c.at > ttlMs;
}

export function lastInjected(key: string): string | undefined {
  return readContext(key)?.lastInjected;
}

export function markInjected(key: string, text: string): void {
  const c = readContext(key);
  if (!c) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath(key), JSON.stringify({ ...c, lastInjected: text }));
}
