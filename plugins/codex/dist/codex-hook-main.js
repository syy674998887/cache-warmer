#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onCodexStop } from "./hook.js";
import { loadPricing } from "./pricing-remote.js";
// The Codex Stop hook. Its systemMessage is shown to the user and never reaches the model, so the summary costs no turn.
try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (input.transcript_path && input.turn_id && !input.stop_hook_active) {
        // It runs on every turn, so it uses a price table fetched earlier and never goes to the network itself.
        const { table } = await loadPricing({ cacheDir: join(tmpdir(), "cache-warmer"), url: null });
        const summary = onCodexStop(input.transcript_path, input.turn_id, table);
        if (summary)
            process.stdout.write(JSON.stringify({ systemMessage: summary }));
    }
}
catch {
    // A line caught mid-write: the summary stays in the dashboard, so stay silent.
}
