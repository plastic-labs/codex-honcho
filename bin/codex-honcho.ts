#!/usr/bin/env bun
import { dispatch, isHookVerb } from "../src/dispatch.ts";
import {
  installCodexHooks,
  removeCodexHooks,
  hasCodexHooks,
  DEFAULT_HOOKS_PATH,
  DEFAULT_CONFIG_PATH,
} from "../src/connectors/codex.ts";

const command = process.argv[2] ?? "";

async function runHook(verb: string): Promise<void> {
  const stdin = await Bun.stdin.text();
  if (!isHookVerb(verb)) return;
  try {
    const out = await dispatch(verb, stdin);
    if (out) process.stdout.write(out + "\n");
  } catch {
    // Never surface a hook failure to Codex.
  }
}

switch (command) {
  case "install":
    installCodexHooks();
    console.log(`Installed Codex hooks → ${DEFAULT_HOOKS_PATH}`);
    console.log(`Enabled [features].hooks → ${DEFAULT_CONFIG_PATH}`);
    break;
  case "remove":
  case "uninstall":
    console.log(removeCodexHooks() ? "Removed Codex hooks." : "No codex-honcho hooks found.");
    break;
  case "status":
    console.log(hasCodexHooks() ? "codex-honcho hooks: installed" : "codex-honcho hooks: not installed");
    break;
  default:
    await runHook(command);
}

process.exit(0);
