import { loadConfig, memoryKey } from "../config.ts";
import { renderContext, retrieveRelevantContext } from "../memory.ts";
import { readContext, lastInjected, markInjected } from "../cache.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|yep|nope|continue|go ahead|do it|proceed)\.?$/i;

// UserPromptSubmit is off by default. Boolean opt-in keeps the original cached
// behavior; semantic recall is a separate opt-in.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.injectPerPrompt) return "";

  const text = (input.prompt ?? "").trim();
  if (!text || TRIVIAL.test(text)) return "";

  if (config.injectPerPrompt === "relevant") {
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
