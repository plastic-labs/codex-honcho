import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

async function sessionAndPeers(config: Config, name: string) {
  const honcho = new Honcho(honchoClientOptions(config));
  const [session, userPeer, aiPeer] = await Promise.all([
    honcho.session(name),
    honcho.peer(config.peerName),
    honcho.peer(config.aiPeer),
  ]);
  return {
    session,
    userPeer,
    aiPeer,
    peerFor: (peerId: string) => honcho.peer(peerId),
  };
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

// Render a context result as a plain-text block. Codex injects a hook's stdout
// into the model as developer context, so we print rather than return JSON.
export function renderContext(context: ContextResult | null, peerName: string, max = 8): string {
  if (!context) return "";
  const parts: string[] = [];

  const rep = context.representation;
  if (typeof rep === "string" && rep.trim()) {
    const lines = rep
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, max)
      .map((l) => l.replace(/^[-*]\s*/, "").replace(/^\[.*?\]\s*/, ""));
    if (lines.length) parts.push(lines.map((l) => `- ${l}`).join("\n"));
  }

  if (context.peerCard?.length) {
    parts.push(`Profile: ${context.peerCard.join("; ")}`);
  }

  if (!parts.length) return "";
  return `<honcho-memory peer="${peerName}">\n${parts.join("\n")}\n</honcho-memory>`;
}
