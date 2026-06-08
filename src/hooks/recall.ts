import { loadConfig, sessionName, memoryKey } from "../config.ts";
import { createSession, renderContext } from "../memory.ts";
import { readContext, writeContext, isStale, markInjected } from "../cache.ts";

interface RecallInput {
  cwd?: string;
  session_id?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCLUSIONS = 8;

// Injected once at session start so the model actively queries memory through
// the Honcho MCP tools rather than leaning on heavy per-turn injection.
const TOOL_HINT =
  "Honcho memory tools are available via MCP — call honcho search / get_context to recall facts " +
  "across sessions, and honcho chat for questions about the user's history. Prefer querying over guessing.";

// SessionStart: materialize the session and surface a lean snapshot of what we
// know, plus a nudge to use the MCP tools for anything deeper.
export async function recall(input: RecallInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);
  const key = memoryKey(config, cwd, input.session_id);

  // Create + materialize the session once, here at SessionStart.
  const { userPeer } = await createSession(config, name);

  let ctx = !isStale(key, CACHE_TTL_MS) ? readContext(key) : null;
  if (!ctx) {
    const fetched = await userPeer.context({ maxConclusions: MAX_CONCLUSIONS, includeMostFrequent: true });
    writeContext(key, fetched.representation, fetched.peerCard);
    ctx = { representation: fetched.representation, peerCard: fetched.peerCard, at: Date.now() };
  }

  const block = renderContext(ctx, config.peerName, 5);
  if (block) markInjected(key, block);
  return block ? `${block}\n${TOOL_HINT}` : TOOL_HINT;
}
