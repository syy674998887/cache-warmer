#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { onSessionEnd, onStop } from "./hook.js";

// The Stop and SessionEnd hooks. A systemMessage is shown to the user and never reaches Claude, so the summary costs no turn.
// The data directory comes from `${CLAUDE_PLUGIN_DATA}` substituted into the hook command, as for the monitor.
try {
  const input = JSON.parse(readFileSync(0, "utf8")) as { hook_event_name: string; session_id: string; transcript_path: string };
  const dataDir = process.argv[2]!;
  if (input.hook_event_name === "SessionEnd") {
    onSessionEnd(dataDir, input.session_id);
  } else {
    const summary = onStop(dataDir, input.session_id, input.transcript_path);
    if (summary) process.stdout.write(JSON.stringify({ systemMessage: summary }));
  }
} catch {
  // A transcript line caught mid-write or a racing state write: the next turn's hook retries, so stay silent.
}
