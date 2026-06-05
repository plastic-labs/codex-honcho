import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Codex loads hooks from ~/.codex/hooks.json, but only when the experimental
// feature is switched on in ~/.codex/config.toml. We own four events; the
// installer merges them in additively and never touches a user's own hooks.

export const DEFAULT_HOOKS_PATH = join(homedir(), ".codex", "hooks.json");
export const DEFAULT_CONFIG_PATH = join(homedir(), ".codex", "config.toml");

// Our own dispatch verbs — the codex-honcho entrypoint routes each to a handler.
export const HOOK_VERBS = ["recall", "prompt", "observe", "writeback"] as const;
export type HookVerb = (typeof HOOK_VERBS)[number];

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookGroup {
  matcher?: string;
  hooks: CommandHook[];
}

interface HooksFile {
  hooks: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

// How each verb maps onto a Codex event. Stop is turn-scoped (Codex has no
// SessionEnd), so writeback runs every turn and ships only the new tail.
function hookGroupsFor(invoke: (verb: HookVerb) => string): Record<string, HookGroup[]> {
  return {
    SessionStart: [
      {
        // Includes `compact` so memory is re-surfaced after a context reset.
        matcher: "startup|resume|clear|compact",
        hooks: [{ type: "command", command: invoke("recall"), timeout: 30, statusMessage: "Recalling Honcho memory" }],
      },
    ],
    UserPromptSubmit: [
      {
        hooks: [{ type: "command", command: invoke("prompt"), timeout: 20, statusMessage: "Searching Honcho memory" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: invoke("observe"), timeout: 10, statusMessage: "Recording Honcho context" }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: invoke("writeback"), timeout: 30, statusMessage: "Saving Honcho memory" }],
      },
    ],
    // Flush the conversation before compaction discards it; the cursor keeps
    // this from duplicating what Stop already shipped.
    PreCompact: [
      {
        matcher: "manual|auto",
        hooks: [{ type: "command", command: invoke("writeback"), timeout: 30, statusMessage: "Flushing Honcho memory" }],
      },
    ],
  };
}

const VERB_PATTERN = new RegExp(`codex-honcho\\b[\\s\\S]*\\b(${HOOK_VERBS.join("|")})\\b`);

function isOwnedCommand(command: unknown): boolean {
  return typeof command === "string" && VERB_PATTERN.test(command);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readHooksFile(path: string): HooksFile {
  if (!existsSync(path)) return { hooks: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) return { hooks: {} };
    if (!isPlainObject(parsed.hooks)) parsed.hooks = {};
    return parsed as HooksFile;
  } catch {
    return { hooks: {} };
  }
}

// Drop only our hooks, keeping any other groups/keys the user has defined.
function withoutOwnHooks(file: HooksFile): { file: HooksFile; removed: boolean } {
  let removed = false;
  const next: HooksFile = { ...file, hooks: {} };

  for (const [event, groups] of Object.entries(file.hooks)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups: HookGroup[] = [];

    for (const group of groups) {
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      const kept = hooks.filter((h) => !isOwnedCommand(h.command));
      if (kept.length !== hooks.length) removed = true;
      // Keep the group only if it still has hooks (an emptied group is ours).
      if (kept.length > 0) keptGroups.push({ ...group, hooks: kept });
    }

    if (keptGroups.length > 0) next.hooks[event] = keptGroups;
  }

  return { file: next, removed };
}

function defaultInvoke(verb: HookVerb): string {
  return `codex-honcho ${verb}`;
}

export interface InstallOptions {
  hooksPath?: string;
  configPath?: string;
  // Builds the shell command for a verb; defaults to the global `codex-honcho` bin.
  invoke?: (verb: HookVerb) => string;
}

export function installCodexHooks(opts: InstallOptions = {}): void {
  const hooksPath = opts.hooksPath ?? DEFAULT_HOOKS_PATH;
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const invoke = opts.invoke ?? defaultInvoke;

  mkdirSync(dirname(hooksPath), { recursive: true });
  enableHooksFeatureFile(configPath);

  // Strip any prior install first so re-running stays idempotent.
  const { file } = withoutOwnHooks(readHooksFile(hooksPath));
  const ours = hookGroupsFor(invoke);
  for (const [event, groups] of Object.entries(ours)) {
    file.hooks[event] = [...(file.hooks[event] ?? []), ...groups];
  }

  writeFileSync(hooksPath, JSON.stringify(file, null, 2) + "\n");
}

export function removeCodexHooks(hooksPath: string = DEFAULT_HOOKS_PATH): boolean {
  if (!existsSync(hooksPath)) return false;
  const { file, removed } = withoutOwnHooks(readHooksFile(hooksPath));
  if (!removed) return false;

  const hasGroups = Object.values(file.hooks).some((g) => Array.isArray(g) && g.length > 0);
  const hasOtherKeys = Object.keys(file).some((k) => k !== "hooks");
  if (!hasGroups && !hasOtherKeys) {
    unlinkSync(hooksPath);
    return true;
  }

  writeFileSync(hooksPath, JSON.stringify(file, null, 2) + "\n");
  return true;
}

export function hasCodexHooks(hooksPath: string = DEFAULT_HOOKS_PATH): boolean {
  if (!existsSync(hooksPath)) return false;
  const file = readHooksFile(hooksPath);
  return Object.values(file.hooks).some(
    (groups) => Array.isArray(groups) && groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => isOwnedCommand(h.command))),
  );
}

// --- config.toml feature flag --------------------------------------------

const FEATURES_HEADER = /^\s*\[features\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[[^\]]+\]\s*(?:#.*)?$/;
const HOOKS_LINE = /^(\s*hooks\s*=\s*).*$/;

// Ensure `[features]\nhooks = true` exists, leaving the rest of the file intact.
export function setHooksFeature(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trimEnd();
  if (!normalized) return "[features]\nhooks = true\n";

  const lines = normalized.split("\n");
  const start = lines.findIndex((l) => FEATURES_HEADER.test(l));
  if (start === -1) return `${normalized}\n\n[features]\nhooks = true\n`;

  let end = lines.length;
  let hooksLine = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADER.test(lines[i])) {
      end = i;
      break;
    }
    if (HOOKS_LINE.test(lines[i])) hooksLine = i;
  }

  if (hooksLine !== -1) {
    lines[hooksLine] = lines[hooksLine].replace(HOOKS_LINE, "$1true");
  } else {
    lines.splice(end, 0, "hooks = true");
  }
  return `${lines.join("\n")}\n`;
}

export function enableHooksFeatureFile(configPath: string = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  const updated = setHooksFeature(existing);
  if (updated !== existing) writeFileSync(configPath, updated);
}
