#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BEAT_MARKER, onSkillPrompt } from "./cron.js";
import { onSessionEnd, onStop } from "./hook.js";
import { defaultDataDir } from "./state.js";
try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const dataDir = process.argv[2] || defaultDataDir();
    logEvent(dataDir, input);
    if (input.hook_event_name === "UserPromptSubmit") {
        const context = onSkillPrompt(dataDir, input.session_id, input.prompt ?? "", input.source);
        if (context) {
            process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } }));
        }
    }
    else if (input.hook_event_name === "Stop" && input.transcript_path) {
        const summary = onStop(dataDir, input.session_id, input.transcript_path);
        if (summary)
            process.stdout.write(JSON.stringify({ systemMessage: summary }));
    }
    else if (input.hook_event_name === "SessionEnd") {
        onSessionEnd(dataDir, input.session_id);
    }
}
catch {
    // A transcript line caught mid-write or a racing state write: the next prompt or turn retries.
}
/** For testing the skill: which hook ran, when, and what kind of prompt it saw. The prompt text is never written. */
function logEvent(dataDir, input) {
    const prompt = input.prompt ?? "";
    const kind = input.hook_event_name !== "UserPromptSubmit" ? undefined : prompt.trimStart().startsWith("/") ? "command" : prompt.includes(BEAT_MARKER) ? "beat" : "other";
    mkdirSync(dataDir, { recursive: true });
    const line = { at: new Date().toISOString(), event: input.hook_event_name, session: input.session_id, source: input.source ?? null, kind };
    appendFileSync(join(dataDir, "hook-events.log"), `${JSON.stringify(line)}\n`);
}
