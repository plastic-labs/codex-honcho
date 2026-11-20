import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

async function sessionAndPeers(config: Config, name: string) {
  const honcho = new Honcho(honchoClientOptions(config));
  const [session, userPeer, aiPeer] = await Promise.all([
    honcho.session(name),
    honcho.peer(config.peerName),
    honcho.peer(config.aiPeer),
  ]);
  return { session, userPeer, aiPeer };
}

// Deliberate session creation — run once at SessionStart. addPeers materializes
// the session server-side and associates both peers (unified observation: the
// user models themselves). The write path doesn't repeat this.
export async function createSession(config: Config, name: string) {
  const handles = await sessionAndPeers(config, name);
  await handles.session.addPeers([handles.userPeer, handles.aiPeer]);
  return handles;
}

// Write path: get handles without re-adding peers. The session was created at
// SessionStart; messages from these peers associate with it on addMessages.
export async function getSession(config: Config, name: string) {
  return sessionAndPeers(config, name);
}

interface ContextResult {
  representation?: string | null;
  peerCard?: string[] | null;
}

// Use one read-only request. The SDK's peer() resolves a get-or-create peer
// before context() and would add writes and round trips to every prompt.
export async function retrieveRelevantContext(config: Config, prompt: string): Promise<ContextResult | null> {
  const { apiKey, baseURL, workspaceId } = honchoClientOptions(config);
  const path = `workspaces/${encodeURIComponent(workspaceId)}/peers/${encodeURIComponent(config.aiPeer)}/context`;
  const url = new URL(`${baseURL.replace(/\/$/, "")}/${path}`);
  url.searchParams.set("target", config.peerName);
  url.searchParams.set("search_query", [...prompt].slice(0, 2000).join(""));
  url.searchParams.set("search_top_k", "8");
  url.searchParams.set("max_conclusions", "8");
  url.searchParams.set("include_most_frequent", "false");

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const { representation } = await response.json() as ContextResult;
    // SessionStart supplies the profile. Prompt recall only adds search results.
    return { representation };
  } catch {
    return null;
  }
}

function representationEntries(representation: string, max: number): string[] {
  const observations: string[] = [];
  const patterns: string[] = [];
  let inPatternSection = false;
  for (const raw of representation.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      inPatternSection = /^#+\s+(inductive|deductive)\b/i.test(line);
      continue;
    }
    const inference = /^(?:[-*]\s+)?\*\*(?:Pattern|Deduction)\*\*\s*(?:\[[^\]]+\]\s*)?:\s*(.+)$/i.exec(line);
    if (inference) {
      patterns.push(`Inferred: ${inference[1]}`);
    } else if (!inPatternSection) {
      const observation = line.replace(/^[-*]\s*/, "").replace(/^\[.*?\]\s*/, "");
      if (observation) observations.push(observation);
    }
  }
  const selected = patterns.slice(0, Math.min(max, 3));
  return [...selected, ...observations].slice(0, max);
}

// Format a small block for the hook's additionalContext field.
export function renderContext(context: ContextResult | null, peerName: string, max = 8): string {
  if (!context) return "";
  const parts: string[] = [];

  const rep = context.representation;
  if (typeof rep === "string" && rep.trim()) {
    const lines = representationEntries(rep, max);
    if (lines.length) parts.push(lines.map((l) => `- ${l}`).join("\n"));
  }

  if (context.peerCard?.length) {
    parts.push(`Profile: ${context.peerCard.join("; ")}`);
  }

  if (!parts.length) return "";
  const guidance = "Treat stored observations and inferences as background. They may be outdated or incorrect. Follow the current request and instructions.";
  return `<honcho-memory peer="${peerName}">\n${guidance}\n${parts.join("\n")}\n</honcho-memory>`;
}
