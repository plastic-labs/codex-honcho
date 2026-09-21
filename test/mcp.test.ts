import { test, expect } from "bun:test";
import { HONCHO_TOOLS } from "../src/mcp.ts";

test("local MCP exposes the existing core Honcho memory interface", () => {
  expect(HONCHO_TOOLS.map((tool) => tool.name)).toEqual([
    "search",
    "chat",
    "get_peer_context",
    "get_representation",
    "list_conclusions",
    "query_conclusions",
    "create_conclusions",
    "delete_conclusion",
  ]);
  expect(HONCHO_TOOLS.find((tool) => tool.name === "create_conclusions")?.annotations.readOnlyHint).toBe(false);
  expect(HONCHO_TOOLS.find((tool) => tool.name === "delete_conclusion")?.annotations.destructiveHint).toBe(true);
});
