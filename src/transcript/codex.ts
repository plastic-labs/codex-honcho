import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

// Codex writes each session to a "rollout" JSONL file under
// ~/.codex/sessions/<id>/<id>.jsonl (archived copies live flat under
// ~/.codex/archived_sessions/). Every line is a { type, payload } event.
// Conversation turns are `response_item` events whose payload is a message;
// user text arrives in input_text blocks, assistant text in output_text.

export type Role = "user" | "assistant";

export interface Turn {
  role: Role;
  text: string;
  at?: string;
  source?: DioneSource;
}

export interface RolloutRecord extends Turn {
  // Stable identity of the underlying rollout event. Cursoring and receipts
  // use this instead of an ordinal, because records may be inserted, removed,
  // or replaced before the previously observed tail.
  recordId: string;
  // Boundary-only records advance the durable cursor and clear conversational
  // scope, but are never persisted as authored memory.
  persist?: false;
}

function recordId(event: RolloutEvent, role: Role, text: string): string {
  const nativeId = event.payload?.id;
  const identity = typeof nativeId === "string" && nativeId
    ? { nativeId }
    : {
        timestamp: event.timestamp,
        clientId: event.payload?.client_id,
        role,
        text,
      };
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

export interface DioneSource {
  kind: "dione";
  userId: string;
  userName: string;
  channelId: string;
  messageId: string;
  occurredAt?: string;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

interface RolloutEvent {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: string | ContentBlock[];
    client_id?: string;
    message?: string;
    cwd?: string;
    id?: string;
  };
}

const TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);
const DIONE_PREFIX = "A Discord event arrived through Dione.";

// Codex injects its own context as user-role messages (environment, instruction
// blobs, abort markers). These aren't things the user said, so they're dropped
// from what we persist to Honcho.
const CODEX_SYSTEM_TAGS = [
  "environment_context",
  "turn_aborted",
  "user_instructions",
  "apps_instructions",
  "plugins_instructions",
  "skills_instructions",
  "collaboration_mode",
];

function isInjectedSystemTurn(text: string): boolean {
  const t = text.trimStart();
  if (/^# AGENTS\.md instructions for [^\r\n]+\r?\n(?:[ \t]*\r?\n)+[ \t]*<INSTRUCTIONS>/.test(t)) return true;
  return CODEX_SYSTEM_TAGS.some((tag) => t.startsWith(`<${tag}>`) || t.startsWith(`<${tag} `));
}

function collectText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type && TEXT_BLOCK_TYPES.has(b.type) && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n")
    .trim();
}

function parseDioneTurn(text: string): { text: string; source: DioneSource } | null | "ignored" | "malformed" {
  if (!text.startsWith(DIONE_PREFIX)) return null;
  const jsonStart = text.indexOf("{");
  if (jsonStart < 0) return "malformed";
  try {
    const event = JSON.parse(text.slice(jsonStart)) as {
      jsonrpc?: string;
      method?: string;
      params?: {
        content?: unknown;
        meta?: {
          user_id?: unknown;
          user?: unknown;
          chat_id?: unknown;
          message_id?: unknown;
          ts?: unknown;
          type?: unknown;
        };
      };
    };
    const meta = event.params?.meta;
    if (
      event.jsonrpc !== "2.0"
      || event.method !== "notifications/claude/channel"
      || typeof event.params?.content !== "string"
      || typeof meta?.user_id !== "string"
      || typeof meta.user !== "string"
      || typeof meta.chat_id !== "string"
      || typeof meta.message_id !== "string"
      || (meta.ts !== undefined && typeof meta.ts !== "string")
    ) {
      return "malformed";
    }
    if (meta.type === "reaction") return "ignored";
    return {
      text: event.params.content.trim(),
      source: {
        kind: "dione",
        userId: meta.user_id,
        userName: meta.user,
        channelId: meta.chat_id,
        messageId: meta.message_id,
        occurredAt: meta.ts,
      },
    };
  } catch {
    return "malformed";
  }
}

function* events(path: string): Generator<RolloutEvent> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RolloutEvent;
    } catch {
      // Skip malformed lines rather than failing the whole read.
    }
  }
}

// Read the stable user/assistant record stream. Boundary-only user records are
// retained so a dropped reaction, malformed Dione envelope, or typed internal
// event cannot leave a later assistant attributed to the preceding room.
export function readRolloutRecords(path: string): RolloutRecord[] {
  const rolloutEvents = [...events(path)];
  const turns: RolloutRecord[] = [];
  const identityOccurrences = new Map<string, number>();
  const identityFor = (event: RolloutEvent, role: Role, text: string): string => {
    const base = recordId(event, role, text);
    const occurrence = identityOccurrences.get(base) || 0;
    identityOccurrences.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  };
  for (let index = 0; index < rolloutEvents.length; index += 1) {
    const event = rolloutEvents[index];
    if (event.type === "event_msg" && event.payload?.type === "user_message") {
      const payload = event.payload;
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (!text || isInjectedSystemTurn(text)) {
        turns.push({
          role: "user",
          text: "",
          at: event.timestamp,
          recordId: identityFor(event, "user", text),
          persist: false,
        });
        continue;
      }

      if (payload.client_id && /^dione-\d+$/.test(payload.client_id)) {
        const dione = parseDioneTurn(text);
        if (!dione || dione === "malformed" || dione === "ignored" || !dione.text) {
          turns.push({
            role: "user",
            text: "",
            at: event.timestamp,
            recordId: identityFor(event, "user", text),
            persist: false,
          });
          continue;
        }
        turns.push({
          role: "user",
          text: dione.text,
          at: event.timestamp,
          recordId: identityFor(event, "user", text),
          source: dione.source,
        });
        continue;
      }

      // Typed internal sources (initiative, tend, etc.) are operational input,
      // not peer-authored conversation. Direct operator prompts have no
      // client_id and retain the configured direct-user attribution.
      if (payload.client_id) {
        turns.push({
          role: "user",
          text: "",
          at: event.timestamp,
          recordId: identityFor(event, "user", text),
          persist: false,
        });
        continue;
      }
      turns.push({
        role: "user",
        text,
        at: event.timestamp,
        recordId: identityFor(event, "user", text),
      });
      continue;
    }

    if (event.type !== "response_item") continue;
    const payload = event.payload;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;

    const text = collectText(payload.content);
    if (!text) continue;
    if (payload.role === "user" && isInjectedSystemTurn(text)) continue;

    // Current Codex rollouts write a response_item user record immediately
    // before the authoritative event_msg copy. Prefer that copy only when the
    // adjacent messages match; a user record elsewhere in a mixed/older
    // rollout remains a real direct turn instead of disappearing globally.
    if (payload.role === "user") {
      const next = rolloutEvents[index + 1];
      const nextText = next?.type === "event_msg" && next.payload?.type === "user_message"
        && typeof next.payload.message === "string"
        ? next.payload.message.trim()
        : undefined;
      if (nextText === text) continue;
    }

    // A response_item has no trustworthy transport-origin discriminator.
    // Dione-looking text here is quarantined rather than parsed or attributed.
    if (payload.role === "user" && text.startsWith(DIONE_PREFIX)) {
      turns.push({
        role: "user",
        text: "",
        at: event.timestamp,
        recordId: identityFor(event, "user", text),
        persist: false,
      });
      continue;
    }

    turns.push({
      role: payload.role,
      text,
      at: event.timestamp,
      recordId: identityFor(event, payload.role, text),
    });
  }
  return turns;
}

// Public transcript view contains only authored conversational turns.
export function readRollout(path: string): Turn[] {
  return readRolloutRecords(path)
    .filter((turn) => turn.persist !== false)
    .map(({ recordId: _recordId, persist: _persist, ...turn }) => turn);
}

// The session_meta header line carries the working directory Codex launched in.
export function readRolloutCwd(path: string): string | undefined {
  for (const event of events(path)) {
    if (event.type === "session_meta" && typeof event.payload?.cwd === "string") {
      return event.payload.cwd || undefined;
    }
  }
  return undefined;
}
