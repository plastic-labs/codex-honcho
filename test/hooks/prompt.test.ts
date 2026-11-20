import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prompt } from "../../src/hooks/prompt.ts";
import { dispatch } from "../../src/dispatch.ts";
import { renderContext } from "../../src/memory.ts";

let dir = "";
const savedDir = process.env.HONCHO_CONFIG_DIR;

function writeConfig(obj: object) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-honcho-prompt-"));
  process.env.HONCHO_CONFIG_DIR = dir;
});

afterEach(() => {
  if (savedDir === undefined) delete process.env.HONCHO_CONFIG_DIR;
  else process.env.HONCHO_CONFIG_DIR = savedDir;
});

test("returns nothing when per-prompt injection is off (default) — no network", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser" });
  const out = await prompt({ prompt: "how is auth done?", cwd: "/tmp/x", session_id: "s1" });
  expect(out).toBe("");
});

test("returns nothing for a trivial prompt even when injection is on", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser", hosts: { codex: { injectPerPrompt: true } } });
  expect(await prompt({ prompt: "ok", cwd: "/tmp/x", session_id: "s1" })).toBe("");
});

test("returns nothing when enabled but there is no cached context (no network)", async () => {
  writeConfig({ apiKey: "k", peerName: "testuser", hosts: { codex: { injectPerPrompt: true } } });
  const out = await prompt({ prompt: "tell me about the project", cwd: "/tmp/x", session_id: "no-cache" });
  expect(out).toBe("");
});

const representation = [
  "## Explicit Observations",
  ...Array.from({ length: 5 }, (_, index) => `[2026-01-01 00:00:00] Observation ${index}`),
  "## Inductive Observations",
  " **Pattern** [high]: Prefers visible feedback during play.",
  "   **Type**: preference",
  "   **Sources**:",
  "   - Example from a prior conversation",
].join("\n");

test("keeps an inference below the first five lines without treating its sources as observations", () => {
  const context = renderContext({ representation }, "testuser", 5);
  expect(context).toContain("- Inferred: Prefers visible feedback during play.");
  expect(context).toContain("- Observation 3");
  expect(context).not.toContain("Observation 4");
  expect(context).not.toContain("Example from a prior conversation");
});

test("relevant mode requests the observer's context using the prompt and skips the peer card", async () => {
  const requests: Array<{ method: string; url: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ method: request.method, url: request.url });
      if (requests.length > 1) return new Response(null, { status: 503 });
      return Response.json({ representation, peer_card: ["Profile already supplied at session start"] });
    },
  });
  try {
    writeConfig({
      apiKey: "k",
      peerName: "testuser",
      hosts: { codex: { injectPerPrompt: "relevant", workspace: "memory", aiPeer: "assistant", endpoint: { baseUrl: server.url.origin } } },
    });
    const submit = (text: string) => dispatch("prompt", JSON.stringify({ prompt: text }));
    expect(await submit("ok")).toBe("");
    expect(requests).toHaveLength(0);
    const question = "How should the game communicate feedback?";
    const context = await submit(question);
    expect(context).toContain("- Inferred: Prefers visible feedback during play.");
    expect(context).not.toContain("Profile already supplied");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    expect(url.pathname).toBe("/v3/workspaces/memory/peers/assistant/context");
    expect(url.searchParams.get("target")).toBe("testuser");
    expect(url.searchParams.get("search_query")).toBe(question);
    expect(await submit("What did we decide about the controls?")).toBe("");
  } finally {
    server.stop(true);
  }
});
