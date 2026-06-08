import { HOOK_VERBS, type HookVerb } from "./connectors/codex.ts";

// Verbs that aren't Codex events — invoked internally or for manual draining.
export const INTERNAL_VERBS = ["flush"] as const;
export type Verb = HookVerb | (typeof INTERNAL_VERBS)[number];

export function isHookVerb(value: string): value is HookVerb {
  return (HOOK_VERBS as readonly string[]).includes(value);
}

export function isVerb(value: string): value is Verb {
  return isHookVerb(value) || (INTERNAL_VERBS as readonly string[]).includes(value);
}

// Route a hook verb to its handler. Every handler is best-effort: any failure
// resolves to an empty string so a hook never blocks or breaks a Codex turn.
export async function dispatch(verb: Verb, stdinText: string): Promise<string> {
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(stdinText || "{}");
  } catch {
    return "";
  }

  try {
    switch (verb) {
      case "recall": {
        const { recall } = await import("./hooks/recall.ts");
        return await recall(input);
      }
      case "prompt": {
        const { prompt } = await import("./hooks/prompt.ts");
        return await prompt(input);
      }
      case "observe": {
        const { observe } = await import("./hooks/observe.ts");
        return await observe(input);
      }
      case "writeback": {
        const { writeback } = await import("./hooks/writeback.ts");
        return await writeback(input);
      }
      case "flush": {
        const { flush } = await import("./hooks/flush.ts");
        return await flush(input);
      }
    }
  } catch {
    return "";
  }
}
