import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, realpathSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { currentBranch } from "./git.ts";

export type SessionStrategy = "per-directory" | "git-branch" | "chat-instance";
type PromptInjection = "off" | "cached" | "search";

// codex-honcho shares the ~/.honcho/config.json file with the other Honcho
// integrations. Codex-specific settings live under hosts.codex; root fields
// are the fallback. Hooks only read it. Explicit setup commands update it
// while preserving the other integrations' settings.

const HOST = "codex";

function configPath(): string {
  const dir = process.env.HONCHO_CONFIG_DIR || join(homedir(), ".honcho");
  return join(dir, "config.json");
}

const BASE_URLS = {
  production: "https://api.honcho.dev/v3",
  local: "http://localhost:8000/v3",
} as const;

interface HostBlock {
  apiKey?: string;
  workspace?: string;
  aiPeer?: string;
  enabled?: boolean;
  saveMessages?: boolean;
  reasoningLevel?: string;
  injectPerPrompt?: unknown;
  sessionStrategy?: SessionStrategy;
  endpoint?: { environment?: "production" | "local"; baseUrl?: string };
}

interface FileConfig extends HostBlock {
  peerName?: string;
  sessions?: Record<string, string>;
  hosts?: Record<string, HostBlock>;
  globalOverride?: boolean;
}

export interface Config {
  apiKey: string;
  peerName: string;
  workspace: string;
  aiPeer: string;
  enabled: boolean;
  saveMessages: boolean;
  reasoningLevel: string;
  injectPerPrompt: PromptInjection;
  // How Honcho session names are derived (default per-directory).
  sessionStrategy: SessionStrategy;
  endpoint?: { environment?: "production" | "local"; baseUrl?: string };
  sessions?: Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readFile(strict = false): FileConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isObject(raw)) throw new Error("Expected a JSON object");
    if (strict && raw.hosts !== undefined
      && (!isObject(raw.hosts) || (raw.hosts[HOST] !== undefined && !isObject(raw.hosts[HOST])))) {
      throw new Error("Expected hosts and hosts.codex to be objects");
    }
    return raw as FileConfig;
  } catch {
    if (strict) throw new Error(`Cannot read Honcho settings. Check the JSON in ${path}.`);
    return {};
  }
}

export function isPromptInjection(value: unknown): value is PromptInjection {
  return value === "off" || value === "cached" || value === "search";
}

function parsePromptInjection(value: unknown): PromptInjection {
  if (isPromptInjection(value)) return value;
  // Older releases used true to opt into cached prompt context.
  return value === true ? "cached" : "off";
}

function configuredPromptInjection(raw: FileConfig): PromptInjection {
  return parsePromptInjection(raw.hosts?.[HOST]?.injectPerPrompt ?? raw.injectPerPrompt);
}

export function getPromptInjection(): PromptInjection {
  return configuredPromptInjection(readFile(true));
}

export function setPromptInjection(mode: PromptInjection): string {
  const raw = readFile(true);
  raw.hosts ??= {};
  raw.hosts[HOST] ??= {};
  raw.hosts[HOST].injectPerPrompt = mode;
  return writeConfig(raw);
}

// Resolve the peer name: an explicit file value wins, else env, else OS user.
// One source of truth shared by loadConfig (read) and install (save) so the
// precedence can never drift between them.
export function resolvePeerName(filePeer?: string): string {
  return filePeer || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";
}

// Returns null when there's no API key — callers exit quietly in that case.
export function loadConfig(): Config | null {
  const raw = readFile();
  const host = raw.hosts?.[HOST];

  const apiKey = process.env.HONCHO_API_KEY || host?.apiKey || raw.apiKey;
  if (!apiKey) return null;

  const peerName = resolvePeerName(raw.peerName);

  const workspace = raw.globalOverride
    ? raw.workspace ?? HOST
    : host?.workspace ?? raw.workspace ?? HOST;
  const aiPeer = raw.globalOverride
    ? raw.aiPeer ?? HOST
    : host?.aiPeer ?? raw.aiPeer ?? HOST;

  return {
    apiKey,
    peerName,
    workspace,
    aiPeer,
    enabled: (host?.enabled ?? raw.enabled) !== false,
    saveMessages: (host?.saveMessages ?? raw.saveMessages) !== false,
    reasoningLevel: host?.reasoningLevel ?? raw.reasoningLevel ?? "low",
    injectPerPrompt: configuredPromptInjection(raw),
    sessionStrategy: host?.sessionStrategy ?? raw.sessionStrategy ?? "per-directory",
    endpoint: host?.endpoint ?? raw.endpoint,
    sessions: raw.sessions,
  };
}

// The currently-resolved key + peer, read straight from env/file (no defaults
// applied). `install` uses this to decide what's missing and must be prompted.
export function currentIdentity(): { apiKey?: string; peerName?: string } {
  const raw = readFile();
  return {
    apiKey: process.env.HONCHO_API_KEY || raw.hosts?.[HOST]?.apiKey || raw.apiKey,
    peerName: raw.peerName,
  };
}

// Persist key/peer into ~/.honcho/config.json, merging into the existing file:
// existing root fields and every hosts.* block are preserved. We deliberately
// do NOT seed hosts.codex defaults — writing an explicit workspace would pin it
// and override a root-level `workspace` the user expects codex to inherit.
// Returns the path written.
export function saveConfig(patch: { apiKey?: string; peerName?: string }): string {
  const raw = readFile();
  if (patch.apiKey) raw.apiKey = patch.apiKey;
  if (patch.peerName) raw.peerName = patch.peerName;
  return writeConfig(raw);
}

function writeConfig(raw: FileConfig): string {
  // Write a private temporary file before replacing the shared config so hooks
  // cannot read an incomplete update.
  const path = configPath();
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return path;
}

function baseUrl(config: Config): string {
  const ep = config.endpoint;
  if (ep?.baseUrl) return ep.baseUrl.endsWith("/v3") ? ep.baseUrl : `${ep.baseUrl}/v3`;
  if (ep?.environment === "local") return BASE_URLS.local;
  return BASE_URLS.production;
}

export function honchoClientOptions(config: Config) {
  return {
    apiKey: config.apiKey,
    baseURL: baseUrl(config),
    workspaceId: config.workspace,
    timeout: 8000,
    maxRetries: 1,
  };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}

// Honcho session name. An explicit sessions[cwd] override always wins; otherwise
// derived per strategy:
//   per-directory  → <repo>                 (one session per project dir)
//   git-branch     → <repo>-<branch>        (per branch; falls back to repo)
//   chat-instance  → <repo>-<short id>      (one session per Codex conversation)
// No peer prefix — the workspace already isolates a user's data.
export function sessionName(config: Config, cwd: string, sessionId?: string): string {
  const override = config.sessions?.[cwd];
  if (override) return override;

  const repo = slug(basename(cwd));
  switch (config.sessionStrategy) {
    case "git-branch": {
      const branch = currentBranch(cwd);
      return branch ? `${repo}-${slug(branch)}` : repo;
    }
    case "chat-instance":
      return sessionId ? `${repo}-${slug(sessionId).slice(0, 8)}` : repo;
    case "per-directory":
    default:
      return repo;
  }
}

// Stable key for cursor/cache/queue files: the Codex session id when present,
// else the derived session name.
export function memoryKey(config: Config, cwd: string, sessionId?: string): string {
  return sessionId || sessionName(config, cwd, sessionId);
}

// Deep link into the Honcho GUI for a given session. The web app lives at the
// production host regardless of the API endpoint, so we hardcode it (matching
// the other Honcho integrations).
export function honchoSessionUrl(workspace: string, session: string): string {
  return `https://app.honcho.dev/explore?workspace=${encodeURIComponent(workspace)}&view=sessions&session=${encodeURIComponent(session)}`;
}
