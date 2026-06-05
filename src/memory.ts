import { Honcho } from "@honcho-ai/sdk";
import { honchoClientOptions, type Config } from "./config.ts";

// Open the session and both peers, ensuring the session exists server-side.
export async function openSession(config: Config, name: string) {
  const honcho = new Honcho(honchoClientOptions(config));
  const [session, userPeer, aiPeer] = await Promise.all([
    honcho.session(name),
    honcho.peer(config.peerName),
    honcho.peer(config.aiPeer),
  ]);
  await session.addPeers([userPeer, aiPeer]);
  return { session, userPeer, aiPeer };
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
