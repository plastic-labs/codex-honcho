import { homedir } from "node:os";
import { join, basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// codex-honcho shares the ~/.honcho/config.json file with the other Honcho
// integrations. Codex-specific settings live under hosts.codex; root fields
// are the fallback. We only ever read this file — the honcho CLI owns writes.

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
    endpoint: host?.endpoint ?? raw.endpoint,
    sessions: raw.sessions,
  };
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

// One stable session per project directory. No peer prefix — the workspace
// already isolates a user's data, so the directory name alone is enough.
export function sessionName(config: Config, cwd: string): string {
  return config.sessions?.[cwd] ?? slug(basename(cwd));
}

// Stable key for cursor/cache files: the Codex session id when present, else
// the derived session name.
export function memoryKey(config: Config, cwd: string, sessionId?: string): string {
  return sessionId || sessionName(config, cwd);
}
