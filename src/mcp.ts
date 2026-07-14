import { Honcho } from "@honcho-ai/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { honchoClientOptions, loadConfig } from "./config.ts";

// Match the hosted Honcho MCP's core memory-tool interface so existing prompts
// and the bundled skill keep working, while routing through the resolved local
// SDK endpoint instead of fixed hosted HTTP credentials.
export const HONCHO_TOOLS = [
  {
    name: "search",
    description: "Semantic search across messages. With no scope params, searches the active workspace; peer_id or session_id narrows the search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query." },
        peer_id: { type: "string", description: "Optional: scope to messages authored by this peer." },
        session_id: { type: "string", description: "Optional: scope to messages in this session." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "chat",
    description: "Ask a natural-language question about a peer's knowledge using Honcho's reasoning system.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The peer to query." },
        query: { type: "string", description: "Natural-language question." },
        target_peer_id: { type: "string", description: "Optional target for a directional representation query." },
        session_id: { type: "string", description: "Optional session scope." },
        reasoning_level: { type: "string", enum: ["minimal", "low", "medium", "high", "max"], description: "Reasoning effort." },
      },
      required: ["peer_id", "query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_peer_context",
    description: "Get comprehensive context for a peer, including their representation and peer card.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        target_peer_id: { type: "string", description: "Optional target peer." },
        search_query: { type: "string", description: "Optional semantic filter for conclusions." },
        max_conclusions: { type: "number", description: "Optional maximum conclusions." },
      },
      required: ["peer_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_representation",
    description: "Get the formatted representation for a peer without the peer card.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        target_peer_id: { type: "string", description: "Optional target peer." },
        session_id: { type: "string", description: "Optional session scope." },
        search_query: { type: "string", description: "Optional semantic filter for conclusions." },
        max_conclusions: { type: "number", description: "Optional maximum conclusions." },
      },
      required: ["peer_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_conclusions",
    description: "List conclusions that Honcho has saved about a peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        target_peer_id: { type: "string", description: "Optional target; defaults to self-conclusions." },
      },
      required: ["peer_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "query_conclusions",
    description: "Semantic search across a peer's conclusions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        query: { type: "string", description: "Semantic search query." },
        target_peer_id: { type: "string", description: "Optional target peer." },
        top_k: { type: "number", description: "Maximum results." },
      },
      required: ["peer_id", "query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "create_conclusions",
    description: "Manually save conclusions (facts or observations) about a peer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        target_peer_id: { type: "string", description: "The peer the conclusions are about." },
        conclusions: { type: "array", items: { type: "string" }, description: "Conclusion content strings." },
        session_id: { type: "string", description: "Optional associated session." },
      },
      required: ["peer_id", "target_peer_id", "conclusions"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  {
    name: "delete_conclusion",
    description: "Delete a specific conclusion by ID.",
    inputSchema: {
      type: "object" as const,
      properties: {
        peer_id: { type: "string", description: "The observer peer." },
        target_peer_id: { type: "string", description: "The peer the conclusion is about." },
        conclusion_id: { type: "string", description: "The conclusion to delete." },
      },
      required: ["peer_id", "target_peer_id", "conclusion_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
];

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(error: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

// Local stdio MCP server. Codex starts it in the active workspace when no cwd
// override is configured, so process.cwd() identifies the nearest repo-local
// .honcho/config.json and its project-specific endpoint/workspace.
export async function runMcpServer(cwd: string = process.cwd()): Promise<void> {
  const config = loadConfig(cwd);
  if (!config || !config.enabled) throw new Error("Honcho is not configured for this workspace");

  const honcho = new Honcho(honchoClientOptions(config));
  const server = new Server(
    { name: "codex-honcho", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: "Use these tools to recall and maintain Honcho memory. Prefer read-only lookup tools before creating or deleting conclusions.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...HONCHO_TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const args = params.arguments ?? {};
    try {
      switch (params.name) {
        case "search": {
          const query = String(args.query);
          const messages = args.session_id
            ? await (await honcho.session(String(args.session_id))).search(query)
            : args.peer_id
              ? await (await honcho.peer(String(args.peer_id))).search(query)
              : await honcho.search(query);
          return json(messages.map((message) => ({
            id: message.id,
            content: message.content,
            peerId: message.peerId,
            sessionId: message.sessionId,
            createdAt: message.createdAt,
          })));
        }
        case "chat": {
          const peer = await honcho.peer(String(args.peer_id));
          const session = args.session_id ? await honcho.session(String(args.session_id)) : undefined;
          const response = await peer.chat(String(args.query), {
            ...(args.target_peer_id ? { target: String(args.target_peer_id) } : {}),
            ...(session ? { session } : {}),
            reasoningLevel: args.reasoning_level ? String(args.reasoning_level) : config.reasoningLevel,
          });
          return text(response ?? "No response from Honcho");
        }
        case "get_peer_context": {
          const peer = await honcho.peer(String(args.peer_id));
          const context = await peer.context({
            ...(args.target_peer_id ? { target: String(args.target_peer_id) } : {}),
            ...(args.search_query ? { searchQuery: String(args.search_query) } : {}),
            ...(typeof args.max_conclusions === "number" ? { maxConclusions: args.max_conclusions } : {}),
            includeMostFrequent: true,
          });
          return json({
            representation: context.representation,
            peerCard: context.peerCard,
            peerId: context.peerId,
            targetId: context.targetId,
          });
        }
        case "get_representation": {
          const peer = await honcho.peer(String(args.peer_id));
          const representation = await peer.representation({
            ...(args.target_peer_id ? { target: String(args.target_peer_id) } : {}),
            ...(args.session_id ? { session: String(args.session_id) } : {}),
            ...(args.search_query ? { searchQuery: String(args.search_query) } : {}),
            ...(typeof args.max_conclusions === "number" ? { maxConclusions: args.max_conclusions } : {}),
            includeMostFrequent: true,
          });
          return text(representation);
        }
        case "list_conclusions": {
          const peer = await honcho.peer(String(args.peer_id));
          const scope = peer.conclusionsOf(String(args.target_peer_id ?? args.peer_id));
          const result = await scope.list();
          return json({
            items: result.items.map((item) => ({ id: item.id, content: item.content, sessionId: item.sessionId, createdAt: item.createdAt })),
            total: result.total,
            page: result.page,
            pages: result.pages,
          });
        }
        case "query_conclusions": {
          const peer = await honcho.peer(String(args.peer_id));
          const scope = peer.conclusionsOf(String(args.target_peer_id ?? args.peer_id));
          const results = await scope.query(String(args.query), typeof args.top_k === "number" ? args.top_k : undefined);
          return json(results.map((item) => ({ id: item.id, content: item.content, sessionId: item.sessionId, createdAt: item.createdAt })));
        }
        case "create_conclusions": {
          const peer = await honcho.peer(String(args.peer_id));
          const scope = peer.conclusionsOf(String(args.target_peer_id));
          const conclusions = Array.isArray(args.conclusions) ? args.conclusions.map(String) : [];
          const created = await scope.create(conclusions.map((content) => ({
            content,
            ...(args.session_id ? { sessionId: String(args.session_id) } : {}),
          })));
          return json({ created: created.length, conclusions: created.map((item) => ({ id: item.id, content: item.content })) });
        }
        case "delete_conclusion": {
          const peer = await honcho.peer(String(args.peer_id));
          const scope = peer.conclusionsOf(String(args.target_peer_id));
          await scope.delete(String(args.conclusion_id));
          return text(`Deleted conclusion ${String(args.conclusion_id)}`);
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true };
      }
    } catch (error) {
      return failure(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
