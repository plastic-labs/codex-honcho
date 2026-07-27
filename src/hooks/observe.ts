import { loadConfig, memoryKey } from "../config.ts";
import { enqueue } from "../queue.ts";
import { readRolloutRecords } from "../transcript/codex.ts";

interface ObserveInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  tool_call_id?: string;
  tool_use_id?: string;
}

// Read-only/inspection commands carry no memory signal — skip them so a single
// review or search turn doesn't flood memory.
const TRIVIAL_SHELL = [
  "cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type",
  "grep", "rg", "find", "fd", "wc", "sed", "awk", "less", "more", "stat",
  "file", "tree", "du", "df", "env", "printf", "sort", "uniq", "cut", "jq",
  "open", "true", "sleep", "date",
  "git status", "git log", "git diff", "git show", "git branch",
];

// Codex names the shell tool "Bash" in hook payloads; "shell"/"local_shell"/
// "exec" are the API/rollout names. Match all so the filter actually applies.
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec"]);

function shellCommand(input: Record<string, unknown>): string {
  const cmd = input.command;
  if (Array.isArray(cmd)) return cmd.join(" ");
  if (typeof cmd === "string") return cmd;
  return "";
}

// Pure: a one-line observation for a tool call, or "" if not worth recording.
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  if (!name) return "";

  // Don't record Honcho's own MCP calls — recording that we queried memory is
  // circular noise that pollutes the representation.
  if (name.startsWith("mcp__honcho")) return "";

  if (SHELL_TOOLS.has(name)) {
    const cmd = shellCommand(input).trim();
    if (!cmd) return "";
    if (TRIVIAL_SHELL.some((t) => cmd === t || cmd.startsWith(t + " "))) return "";
    return `ran: ${cmd.slice(0, 120)}`;
  }

  if (name === "apply_patch") {
    const patch = typeof input.input === "string" ? input.input : typeof input.patch === "string" ? input.patch : "";
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]);
    if (files.length) return `edited: ${files.slice(0, 5).join(", ")}`;
    return "applied a patch";
  }

  return `used ${name}`;
}

// PostToolUse: queue a terse observation of meaningful tool activity. Enqueue
// only — instant, no network. The next writeback (Stop) flushes it along with
// the turn, so frequent tool calls never trigger an upload of their own.
export async function observe(input: ObserveInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";

  const summary = summarizeTool(input.tool_name ?? "", input.tool_input ?? {});
  if (!summary) return "";
  // A tool call has no author/channel fields of its own. Derive its scope only
  // from the authenticated rollout. Without a readable transcript, fail closed
  // and omit the observation rather than leak channel activity into the base
  // direct-user session.
  if (!input.transcript_path) return "";
  const turns = readRolloutRecords(input.transcript_path);
  const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
  if (!lastUser?.source || lastUser.persist === false) return "";

  const cwd = input.cwd || process.cwd();
  const toolId = input.tool_call_id || input.tool_use_id;
  enqueue(memoryKey(config, cwd, input.session_id), [{
    role: "tool",
    text: summary,
    at: new Date().toISOString(),
    scopeId: lastUser.source.channelId,
    ...(toolId ? { receiptId: `codex:tool:${input.session_id || "session"}:${toolId}` } : {}),
  }]);
  return "";
}
