import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { renderContext } from "../memory.ts";
import { readContext, lastInjected, markInjected } from "../cache.ts";

interface PromptInput {
  prompt?: string;
  cwd?: string;
  session_id?: string;
}

const TRIVIAL = /^(y|n|yes|no|ok|okay|sure|thanks|yep|nope|continue|go ahead|do it|proceed)\.?$/i;

// UserPromptSubmit: off by default — session-start context plus the MCP tools
// cover recall without taxing every turn. When injectPerPrompt is enabled,
// serve the cached snapshot (no network) and never repeat the same block.
export async function prompt(input: PromptInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled || !config.injectPerPrompt) return "";

  const text = (input.prompt ?? "").trim();
  if (!text || TRIVIAL.test(text)) return "";

  const cwd = input.cwd || process.cwd();
  const key = memoryKey(config, cwd, input.session_id);

  const cached = readContext(key);
  if (!cached) return "";

  const block = renderContext(cached, config.peerName, 5);
  if (!block || block === lastInjected(key)) return "";

  markInjected(key, block);
  return block;
}
