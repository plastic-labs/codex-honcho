import { loadConfig, sessionName } from "../config.ts";
import { openSession, renderContext } from "../memory.ts";

interface RecallInput {
  cwd?: string;
  session_id?: string;
}

// SessionStart: materialize the session and surface what we know about the user.
export async function recall(input: RecallInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);

  const { userPeer } = await openSession(config, name);
  const context = await userPeer.context({ maxConclusions: 20, includeMostFrequent: true });
  return renderContext(context, config.peerName);
}
