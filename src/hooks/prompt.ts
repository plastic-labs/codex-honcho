import { loadConfig, sessionName } from "../config.ts";
import { openSession, renderContext } from "../memory.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|yep|nope|continue|go ahead|do it|proceed)\.?$/i;

// UserPromptSubmit: pull context relevant to this prompt and inject it.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";

  const text = (input.prompt ?? "").trim();
  if (!text || TRIVIAL.test(text)) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);

  const { userPeer } = await openSession(config, name);
  const context = await userPeer.context({
    searchQuery: text,
    searchTopK: 5,
    searchMaxDistance: 0.7,
    maxConclusions: 10,
    includeMostFrequent: true,
  });
  return renderContext(context, config.peerName);
}
