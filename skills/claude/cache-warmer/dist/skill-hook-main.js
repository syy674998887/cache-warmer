#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestPromptMeta } from "./claude.js";
import { isHookFire, onSkillPrompt } from "./cron.js";
import { onSessionEnd, onStop } from "./hook.js";
import { defaultDataDir } from "./state.js";
try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const dataDir = process.argv[2] || defaultDataDir();
    try {
        logEvent(dataDir, input);
    }
    catch {
        // Logging is only for testing.
    }
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
/**
 * For testing the skill: which hook ran, when, which input fields it got, and what kind of prompt it saw. At the end
 * of a turn, also the metadata of the record that started it, to learn whether fires can be told from typed prompts.
 * The prompt text is never written.
 */
function logEvent(dataDir, input) {
    const line = { at: new Date().toISOString(), event: input.hook_event_name, session: input.session_id, fields: Object.keys(input) };
    if (input.hook_event_name === "UserPromptSubmit") {
        const prompt = (input.prompt ?? "").trimStart();
        line.source = input.source ?? null;
        line.kind = prompt.startsWith("/") ? "command" : isHookFire(prompt) ? "beat" : prompt.startsWith("<") ? "notification" : "other";
    }
    else if (input.hook_event_name === "Stop" && input.transcript_path) {
        line.turnStartedBy = latestPromptMeta(input.transcript_path) ?? null;
    }
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, "hook-events.log"), `${JSON.stringify(line)}\n`);
}
