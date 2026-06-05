import { loadConfig, sessionName } from "../config.ts";
import { openSession } from "../memory.ts";

interface DialecticInput {
  cwd?: string;
  session_id?: string;
}

// Background worker (spawned detached by recall): nudges Honcho's dialectic
// engine so its representation of the user keeps improving. Results are
// discarded — the value is the server-side reasoning it triggers.
export async function dialectic(input: DialecticInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || config.reasoningLevel === "minimal") return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);
  const { session, userPeer } = await openSession(config, name);

  await Promise.allSettled([
    userPeer.chat(
      `Summarize what you know about ${config.peerName} — preferences, current projects, and working style.`,
      { session, reasoningLevel: config.reasoningLevel },
    ),
    userPeer.chat(`What has ${config.peerName} been working on recently?`, {
      session,
      reasoningLevel: config.reasoningLevel,
    }),
  ]);
  return "";
}
