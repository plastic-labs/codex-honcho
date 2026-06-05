import { loadConfig, sessionName } from "../config.ts";
import { openSession } from "../memory.ts";

interface ObserveInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  cwd?: string;
}

// Skip read-only/navigation shell commands that carry no memory signal.
const TRIVIAL_SHELL = ["cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type", "git status", "git log", "git diff"];

function shellCommand(input: Record<string, unknown>): string {
  const cmd = input.command;
  if (Array.isArray(cmd)) return cmd.join(" ");
  if (typeof cmd === "string") return cmd;
  return "";
}

// Pure: a one-line observation for a tool call, or "" if not worth recording.
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  if (!name) return "";

  if (name === "shell" || name === "local_shell" || name === "exec") {
    const cmd = shellCommand(input).trim();
    if (!cmd) return "";
    if (TRIVIAL_SHELL.some((t) => cmd.startsWith(t))) return "";
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

// PostToolUse: record a terse observation of meaningful tool activity.
export async function observe(input: ObserveInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.saveMessages) return "";

  const summary = summarizeTool(input.tool_name ?? "", input.tool_input ?? {});
  if (!summary) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);
  const { session, aiPeer } = await openSession(config, name);
  await session.addMessages([aiPeer.message(`[tool] ${summary}`, { metadata: { type: "tool", session_affinity: name } })]);
  return "";
}
