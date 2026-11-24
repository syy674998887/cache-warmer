#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { run } from "./commands.js";
import { expansionArgs } from "./hook.js";

// The UserPromptExpansion hook. Blocking the command shows `reason` to the user and starts no model turn, so these
// commands cost nothing and never rebuild an expired cache. On any failure it stays silent and the skill runs as before.
// suppressOriginalPrompt drops the `Original prompt:` line Claude Code otherwise adds to the message.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as { command_name: string; command_args: string; session_id: string };
  const args = expansionArgs(input.command_name, input.command_args, input.session_id, process.argv[2]!);
  if (args) {
    const reason = await run(args);
    process.stdout.write(JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "UserPromptExpansion", suppressOriginalPrompt: true } }));
  }
} catch {
  // The skill then handles the command.
}
