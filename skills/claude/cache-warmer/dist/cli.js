#!/usr/bin/env node
import { run } from "./commands.js";
// Errors go to stdout: skills inject this output into the conversation, so the user sees the reason.
try {
    process.stdout.write(`${await run(process.argv.slice(2))}\n`);
}
catch (error) {
    process.stdout.write(`Cache Warmer 出错：${error instanceof Error ? error.message : String(error)}\n`);
}
