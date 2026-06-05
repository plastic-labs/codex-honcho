import { loadConfig, sessionName } from "../config.ts";
import { openSession, renderContext } from "../memory.ts";

interface RecallInput {
  cwd?: string;
  session_id?: string;
}

// Injected once at session start so the model actively queries memory through
// the Honcho MCP tools rather than relying only on this passive context.
const TOOL_HINT =
  "Honcho memory tools are available via MCP — call honcho search / get_context to recall facts " +
  "across sessions, and honcho chat for questions about the user's history. Prefer querying over guessing.";

// SessionStart: materialize the session, surface what we know, and nudge the
// dialectic engine so its reasoning keeps feeding the knowledge graph.
export async function recall(input: RecallInput): Promise<string> {
  const config = loadConfig();
  if (!config || !config.enabled) return "";

  const cwd = input.cwd || process.cwd();
  const name = sessionName(config, cwd);

  const { session, userPeer } = await openSession(config, name);
  const context = await userPeer.context({ maxConclusions: 20, includeMostFrequent: true });

  // Dialectic reasoning, bounded and best-effort: results aren't displayed, but
  // running them refines Honcho's representation of the user over time.
  if (config.reasoningLevel !== "minimal") {
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
  }

  const block = renderContext(context, config.peerName);
  return block ? `${block}\n${TOOL_HINT}` : TOOL_HINT;
}
