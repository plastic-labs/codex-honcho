import { loadConfig, memoryKey } from "../config.ts";
import { renderContext, retrieveRelevantContext } from "../memory.ts";
import { readContext, lastInjected, markInjected } from "../cache.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|yep|nope|continue|go ahead|do it|proceed)\.?$/i;

// UserPromptSubmit is off by default. Cached mode skips the network, and search
// mode looks up memories related to the prompt.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || config.injectPerPrompt === "off") return "";

  const text = (input.prompt ?? "").trim();
  if (!text || TRIVIAL.test(text)) return "";

  if (config.injectPerPrompt === "search") {
    const context = await retrieveRelevantContext(config, text);
    return renderContext(context, config.peerName, 5);
  }

  const cwd = input.cwd || process.cwd();
  const key = memoryKey(config, cwd, input.session_id);

  const cached = readContext(key);
  if (!cached) return "";

  const block = renderContext(cached, config.peerName, 5);
  if (!block || block === lastInjected(key)) return "";

  markInjected(key, block);
  return block;
}
