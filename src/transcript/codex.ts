import { readFileSync } from "node:fs";

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
    cwd?: string;
    id?: string;
  };
}

const TEXT_BLOCK_TYPES = new Set(["input_text", "output_text", "text"]);

// Codex injects its own context as user-role messages (environment, instruction
// blobs, goal context, plugin lists, subagent notices, abort markers). These
// aren't things the user said, so they're dropped from what we persist to Honcho.
const CODEX_SYSTEM_TAGS = [
  "environment_context",
  "turn_aborted",
  "user_instructions",
  "apps_instructions",
  "plugins_instructions",
  "skills_instructions",
  "collaboration_mode",
  "codex_internal_context",
  "recommended_plugins",
  "subagent_notification",
];

// Project docs arrive as a markdown heading followed by an <INSTRUCTIONS> block
// ("# AGENTS.md instructions for <cwd>", or without " for <cwd>" when only a
// global AGENTS.md applies), not as a tag. Matching the exact heading and the
// block keeps a user's own "# ... instructions" text intact.
const PROJECT_DOC_TURN = /^# AGENTS\.md instructions(?: for [^\n]+)?\n+<INSTRUCTIONS>/;

// The filter before per-block checks: tags matched only at the start of the
// joined message text. Kept solely to migrate cursors counted under it.
const LEGACY_CODEX_SYSTEM_TAGS = CODEX_SYSTEM_TAGS.slice(0, 7);

function isLegacyInjectedTurn(text: string): boolean {
  const t = text.trimStart();
  return LEGACY_CODEX_SYSTEM_TAGS.some((tag) => t.startsWith(`<${tag}>`) || t.startsWith(`<${tag} `));
}

function isInjectedSystemTurn(text: string): boolean {
  const t = text.trimStart();
  return (
    CODEX_SYSTEM_TAGS.some((tag) => t.startsWith(`<${tag}>`) || t.startsWith(`<${tag} `)) ||
    PROJECT_DOC_TURN.test(t)
  );
}

// Codex bundles several injected blocks into one message (AGENTS.md +
// environment_context, recommended_plugins + both), so user turns are filtered
// per block: injected blocks drop, the user's own blocks survive.
function collectText(content: string | ContentBlock[] | undefined, dropInjected = false): string {
  const keep = (text: string) => !(dropInjected && isInjectedSystemTurn(text));
  if (typeof content === "string") return keep(content) ? content.trim() : "";
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type && TEXT_BLOCK_TYPES.has(b.type) && typeof b.text === "string")
    .map((b) => b.text as string)
    .filter(keep)
    .join("\n")
    .trim();
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

// Map a cursor counted under the legacy filter onto the current one. The
// legacy count marks a position in the rollout (just after its last counted
// turn); the migrated cursor is the number of current turns before that
// position, so nothing already sent is re-sent and nothing after it is skipped.
export function migrateLegacyCursor(path: string, legacyCount: number): number {
  let legacy = 0;
  let current = 0;
  for (const event of events(path)) {
    if (legacy >= legacyCount) break;
    if (event.type !== "response_item") continue;
    const payload = event.payload;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    if (collectText(payload.content, payload.role === "user")) current += 1;
    const joined = collectText(payload.content);
    if (joined && !(payload.role === "user" && isLegacyInjectedTurn(joined))) legacy += 1;
  }
  return current;
}

// Read the full conversation, in order, dropping tool/reasoning/system noise.
export function readRollout(path: string): Turn[] {
  const turns: Turn[] = [];
  for (const event of events(path)) {
    if (event.type !== "response_item") continue;
    const payload = event.payload;
    if (!payload || payload.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;

    const text = collectText(payload.content, payload.role === "user");
    if (!text) continue;

    turns.push({ role: payload.role, text, at: event.timestamp });
  }
  return turns;
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
