import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { currentBranch } from "./git.ts";

export type SessionStrategy = "per-directory" | "git-branch" | "chat-instance";

// codex-honcho shares the ~/.honcho/config.json file with the other Honcho
// integrations. Codex-specific settings live under hosts.codex; root fields
// are the fallback. At runtime we only read it; `install` is the one writer —
// it persists the resolved API key + peer name here (merging, never clobbering
// other integrations' settings) so the shared file is the source of truth.

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
  injectPerPrompt?: boolean;
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
  // Inject prompt-relevant context on every turn. Off by default — lean
  // session-start context plus the MCP tools cover depth on demand.
  injectPerPrompt: boolean;
  // How Honcho session names are derived (default per-directory).
  sessionStrategy: SessionStrategy;
  endpoint?: { environment?: "production" | "local"; baseUrl?: string };
  sessions?: Record<string, string>;
}

function readFile(): FileConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FileConfig;
  } catch {
    return {};
  }
}

// Returns null when there's no API key — callers exit quietly in that case.
export function loadConfig(): Config | null {
  const raw = readFile();
  const host = raw.hosts?.[HOST];

  const apiKey = process.env.HONCHO_API_KEY || host?.apiKey || raw.apiKey;
  if (!apiKey) return null;

  const peerName =
    raw.peerName || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";

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
    injectPerPrompt: (host?.injectPerPrompt ?? raw.injectPerPrompt) === true,
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

  // The file holds the API key, so keep it user-only. mode on mkdir/write only
  // applies when they create the target; chmod then enforces 0600 even if the
  // file already existed with looser perms. (We don't re-chmod the shared
  // ~/.honcho dir — the honcho CLI owns it and intentionally creates it 0755.)
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
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
