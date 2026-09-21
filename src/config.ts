import { homedir } from "node:os";
import { join, basename, dirname, resolve, relative, isAbsolute, parse, sep } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { currentBranch } from "./git.ts";

export type SessionStrategy = "per-directory" | "per-repo" | "git-branch" | "chat-instance";

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
  sessionName?: string;
  splitSubmodules?: boolean;
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
  // Repo-local only: pin the project to one exact session name.
  sessionName?: string;
  // Repo-local only: anchor nested git repositories to their own sessions.
  splitSubmodules?: boolean;
  endpoint?: { environment?: "production" | "local"; baseUrl?: string };
  sessions?: Record<string, string>;
  // Present only when this config includes a repo-local overlay.
  localConfig?: LocalConfigInfo;
}

export interface LocalConfigInfo {
  path: string;
  root: string;
}

function readGlobalFile(): FileConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FileConfig;
  } catch {
    return {};
  }
}

// Resolve the peer name: an explicit file value wins, else env, else OS user.
// One source of truth shared by loadConfig (read) and install (save) so the
// precedence can never drift between them.
export function resolvePeerName(filePeer?: string): string {
  return filePeer || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";
}

function resolveFileConfig(raw: FileConfig): Config | null {
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
    injectPerPrompt: (host?.injectPerPrompt ?? raw.injectPerPrompt) === true,
    sessionStrategy: host?.sessionStrategy ?? raw.sessionStrategy ?? "per-directory",
    endpoint: host?.endpoint ?? raw.endpoint,
    sessions: raw.sessions,
  };
}

const LOCAL_FIELDS = [
  "apiKey",
  "peerName",
  "workspace",
  "aiPeer",
  "enabled",
  "saveMessages",
  "reasoningLevel",
  "injectPerPrompt",
  "sessionStrategy",
  "sessionName",
  "splitSubmodules",
  "endpoint",
] as const;

// Walk upward from cwd to the nearest project-owned .honcho/config.json. The
// shared global config is never treated as a local overlay, including when its
// directory is redirected with HONCHO_CONFIG_DIR.
export function findLocalConfig(cwd: string): LocalConfigInfo | null {
  try {
    const home = resolve(homedir());
    const globalPath = resolve(configPath());
    let dir = resolve(cwd);
    for (let depth = 0; depth < 64; depth++) {
      const path = join(dir, ".honcho", "config.json");
      if (dir !== home && resolve(path) !== globalPath && existsSync(path)) {
        return { path, root: dir };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Invalid or inaccessible cwd: preserve global-only behavior.
  }
  return null;
}

function localField(raw: FileConfig, key: (typeof LOCAL_FIELDS)[number]): unknown {
  const host = raw.hosts?.[HOST] as Record<string, unknown> | undefined;
  return host?.[key] ?? (raw as unknown as Record<string, unknown>)[key];
}

function applyLocalConfig(base: Config | null, local: LocalConfigInfo | null): Config | null {
  if (!local) return base;

  let raw: FileConfig;
  try {
    raw = JSON.parse(readFileSync(local.path, "utf-8")) as FileConfig;
  } catch {
    return base;
  }

  // A local file normally inherits credentials and identity from the shared
  // config, but it can also be fully self-contained when no global config is
  // available.
  const effective = base ? { ...base } : resolveFileConfig(raw);
  if (!effective) return base;

  for (const key of LOCAL_FIELDS) {
    const value = localField(raw, key);
    if (value !== undefined) (effective as unknown as Record<string, unknown>)[key] = value;
  }
  // Preserve the existing explicit environment override above both config
  // files; a repo-local apiKey still works when HONCHO_API_KEY is absent.
  if (process.env.HONCHO_API_KEY) effective.apiKey = process.env.HONCHO_API_KEY;
  if (!effective.apiKey) return base;
  effective.localConfig = local;
  return effective;
}

// Returns null when there's no API key — callers exit quietly in that case.
// When cwd is inside a project with .honcho/config.json, that file overlays the
// resolved global config field-by-field. Local values win; omitted values keep
// inheriting from ~/.honcho/config.json.
export function loadConfig(cwd: string = process.cwd()): Config | null {
  return applyLocalConfig(resolveFileConfig(readGlobalFile()), findLocalConfig(cwd));
}

// The currently-resolved key + peer, read straight from env/file (no defaults
// applied). `install` uses this to decide what's missing and must be prompted.
export function currentIdentity(): { apiKey?: string; peerName?: string } {
  const raw = readGlobalFile();
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
  const raw = readGlobalFile();
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

function withinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

// Find the nearest git root, optionally without escaping a repo-local config's
// project root. A .git file counts too, which covers worktrees/submodules.
export function findNearestGitRoot(cwd: string, projectRoot?: string): string | null {
  try {
    let dir = resolve(cwd);
    const root = projectRoot ? resolve(projectRoot) : parse(dir).root;
    if (!withinRoot(dir, root)) return null;
    for (let depth = 0; depth < 64; depth++) {
      if (existsSync(join(dir, ".git"))) return dir;
      if (dir === root) break;
      const parent = dirname(dir);
      if (parent === dir || !withinRoot(parent, root)) break;
      dir = parent;
    }
  } catch {
    // Fall back to the project root in sessionName().
  }
  return null;
}

// Honcho session name. On the global-only path an explicit sessions[cwd]
// override wins; repo-local configs anchor to their project root instead.
// Otherwise names are derived per strategy:
//   per-directory  → <repo>                 (one session per project dir)
//   per-repo       → <git root>             (one session per git repository)
//   git-branch     → <repo>-<branch>        (per branch; falls back to repo)
//   chat-instance  → <repo>-<short id>      (one session per Codex conversation)
// No peer prefix — the workspace already isolates a user's data.
export function sessionName(config: Config, cwd: string, sessionId?: string): string {
  const local = config.localConfig;
  if (!local) {
    const override = config.sessions?.[cwd];
    if (override) return override;
  }

  if (local && config.sessionName) return slug(config.sessionName);

  const directoryAnchor = local?.root ?? cwd;
  const anchor = config.sessionStrategy === "per-repo"
    ? findNearestGitRoot(cwd, local?.root) ?? directoryAnchor
    : local && config.splitSubmodules
      ? findNearestGitRoot(cwd, local.root) ?? local.root
      : directoryAnchor;

  const repo = slug(basename(anchor));
  switch (config.sessionStrategy) {
    case "git-branch": {
      const branch = currentBranch(anchor);
      return branch ? `${repo}-${slug(branch)}` : repo;
    }
    case "chat-instance":
      return sessionId ? `${repo}-${slug(sessionId).slice(0, 8)}` : repo;
    case "per-repo":
    case "per-directory":
    default:
      return repo;
  }
}

// Stable key for cursor/cache/queue files: the Codex session id when present,
// else the derived session name.
export function memoryKey(config: Config, cwd: string, sessionId?: string): string {
  const key = sessionId || sessionName(config, cwd, sessionId);
  // Keep queues/cursors/context from an existing global session out of a newly
  // activated repo-local workspace. The default path remains byte-for-byte
  // compatible with prior releases.
  return config.localConfig ? `local-${config.workspace}-${key}` : key;
}

// Deep link into the Honcho GUI for a given session. The web app lives at the
// production host regardless of the API endpoint, so we hardcode it (matching
// the other Honcho integrations).
export function honchoSessionUrl(workspace: string, session: string): string {
  return `https://app.honcho.dev/explore?workspace=${encodeURIComponent(workspace)}&view=sessions&session=${encodeURIComponent(session)}`;
}
