import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { loadConfig, scopedSessionName, memoryKey } from "../config.ts";
import { getSession } from "../memory.ts";
import {
  quarantineAndSetSentCount,
  readQueue,
  sentCount,
  setSentCount,
  queueDir,
  safe,
  type QueueEntry,
} from "../queue.ts";

interface FlushInput {
  cwd?: string;
  session_id?: string;
}

// Honcho's per-message content ceiling is ~25k chars; stay just under it.
const MAX_CHARS = 24000;
// Honcho rejects an addMessages call with more than 100 messages, and the SDK
// sends one POST per call without chunking, so we cap each call here.
const BATCH_LIMIT = 100;
const DIONE_PREFIX = "A Discord event arrived through Dione.";

type SessionHandles = Awaited<ReturnType<typeof getSession>>;
type PeerMessage = ReturnType<SessionHandles["userPeer"]["message"]>;
type SessionPeerPolicy = { observeMe: boolean; observeOthers: boolean };

// Split an oversized body into <=MAX_CHARS pieces, preferring a newline/space
// boundary, so a long turn is preserved across parts instead of truncated.
// Capped at BATCH_LIMIT parts so one queue entry never exceeds a single upload
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
  if (chunks.length > BATCH_LIMIT) chunks = chunks.slice(0, BATCH_LIMIT);
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

export function lockPath(key: string): string {
  return join(queueDir(), `${safe(key)}.lock`);
}

function messagesForEntry(
  entry: QueueEntry,
  userPeer: SessionHandles["userPeer"],
  aiPeer: SessionHandles["aiPeer"],
  dionePeers: Map<string, SessionHandles["userPeer"]>,
): PeerMessage[] {
  const peer = entry.role === "user"
    ? (entry.peerId ? dionePeers.get(entry.peerId) : userPeer)
    : aiPeer;
  if (!peer) throw new Error(`missing routed peer: ${entry.peerId}`);
  const body = entry.role === "tool" ? `[tool] ${entry.text}` : entry.text;
  const pieces = chunkText(body);
  return pieces.map((piece, index) =>
    peer.message(piece, {
      createdAt: entry.at,
      ...(entry.role === "tool"
        ? { metadata: {
            type: "tool",
            ...(entry.receiptId ? {
              integration_receipt: `${entry.receiptId}:part:${index + 1}/${pieces.length}`,
            } : {}),
          } }
        : entry.source
          ? { metadata: {
              source: "dione",
              discord_user_id: entry.source.userId,
              discord_user_name: entry.source.userName,
              discord_channel_id: entry.source.channelId,
              discord_message_id: entry.source.messageId,
              ...(entry.receiptId ? {
                integration_receipt: `${entry.receiptId}:part:${index + 1}/${pieces.length}`,
              } : {}),
            } }
          : entry.receiptId
            ? { metadata: {
                integration_receipt: `${entry.receiptId}:part:${index + 1}/${pieces.length}`,
              } }
            : {}),
    }),
  );
}

async function alreadyWritten(
  session: SessionHandles["session"],
  message: PeerMessage,
): Promise<boolean> {
  const receipt = message.metadata?.integration_receipt;
  if (typeof receipt !== "string" || !receipt) return false;
  const page = await session.messages({
    filters: { metadata: { integration_receipt: receipt } },
    size: 1,
  });
  return page.items.length > 0;
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
  const key = memoryKey(config, cwd, input.session_id);

  if (!acquireLock(key)) return "";
  try {
    const all = readQueue(key);
    const start = sentCount(key);
    if (all.length - start <= 0) return "";
    const handlesByScope = new Map<string, SessionHandles>();
    const routedPeersByScope = new Map<string, Map<string, SessionHandles["userPeer"]>>();
    const scopeKey = (scopeId?: string) => scopeId || "";
    const handlesFor = async (scopeId?: string) => {
      const key = scopeKey(scopeId);
      const cached = handlesByScope.get(key);
      if (cached) return cached;
      const handles = await getSession(
        config,
        scopedSessionName(config, cwd, input.session_id, scopeId),
      );
      handlesByScope.set(key, handles);
      routedPeersByScope.set(key, new Map());
      return handles;
    };
    const peersFor = async (scopeId: string | undefined, entries: QueueEntry[]) => {
      const handles = await handlesFor(scopeId);
      const peers = routedPeersByScope.get(scopeKey(scopeId)) as Map<string, SessionHandles["userPeer"]>;
      const routedIds = [...new Set(
        entries
          .filter((entry) => entry.role === "user" && entry.peerId)
          .map((entry) => entry.peerId as string),
      )];
      await Promise.all(routedIds.map(async (peerId) => {
        if (!peers.has(peerId)) peers.set(peerId, await handles.peerFor(peerId));
      }));
      return { handles, peers, routedIds };
    };

    let batch: PeerMessage[] = [];
    let batchEntries: QueueEntry[] = [];
    let batchScope: string | undefined;

    const flushBatch = async (sentThrough: number) => {
      if (batch.length === 0) return;
      const { handles, routedIds } = await peersFor(batchScope, batchEntries);
      const membership: Array<[string, SessionPeerPolicy]> = [
        [config.aiPeer, { observeMe: true, observeOthers: true }],
      ];
      if (batchScope) {
        for (const peerId of routedIds) {
          membership.push([peerId, { observeMe: true, observeOthers: false }]);
        }
      } else {
        membership.push([config.peerName, { observeMe: true, observeOthers: true }]);
      }
      // Membership and observation are explicit authorization. Unknown peers
      // can contribute to this one scoped session but cannot observe others or
      // acquire membership in any other session as a creation side effect.
      await handles.session.addPeers(membership);
      const missing: PeerMessage[] = [];
      const pendingReceipts = new Set<string>();
      for (const message of batch) {
        const receipt = message.metadata?.integration_receipt;
        if (typeof receipt === "string" && receipt) {
          // Capture can append the same record twice if it crashes after queue
          // append but before cursor acknowledgement. Remote lookup alone
          // cannot catch two copies in this still-pending batch.
          if (pendingReceipts.has(receipt)) continue;
          pendingReceipts.add(receipt);
        }
        if (!(await alreadyWritten(handles.session, message))) missing.push(message);
      }
      if (missing.length > 0) await handles.session.addMessages(missing);
      setSentCount(key, sentThrough);
      batch = [];
      batchEntries = [];
    };

    // Drain pending entries in order, flushing only at entry boundaries so the
    // sent marker always lands on a fully-uploaded entry — a failure mid-drain
    // just retries from the last completed entry, no sub-entry bookkeeping. The
    // batch is flushed right before an entry would push it past BATCH_LIMIT, and
    // once more at the end, so no single call exceeds Honcho's per-request limit.
    for (let i = start; i < all.length; i++) {
      const entry = all[i];
      const legacyDioneWrapper = !entry.source && entry.text.startsWith(DIONE_PREFIX);
      if (legacyDioneWrapper || (entry.source?.kind === "dione" &&
          (!entry.scopeId || !entry.receiptId || !entry.peerId))) {
        await flushBatch(i);
        quarantineAndSetSentCount(
          key,
          i,
          entry,
          legacyDioneWrapper
            ? "legacy Dione wrapper lacks authenticated author and scope"
            : "legacy Dione entry lacks scope, receipt, or peer routing authority",
        );
        continue;
      }
      if (batch.length > 0 && entry.scopeId !== batchScope) {
        await flushBatch(i);
      }
      batchScope = entry.scopeId;
      const { handles, peers } = await peersFor(batchScope, [entry]);
      const messages = messagesForEntry(entry, handles.userPeer, handles.aiPeer, peers);
      if (batch.length > 0 && batch.length + messages.length > BATCH_LIMIT) {
        await flushBatch(i);
        batchScope = entry.scopeId;
      }
      batch.push(...messages);
      batchEntries.push(entry);
    }
    if (batch.length > 0) {
      await flushBatch(all.length);
    }
  } finally {
    releaseLock(key);
  }
  return "";
}
