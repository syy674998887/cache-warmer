#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tick } from "./monitor.js";
import { pruneHeartbeats, writeHeartbeat } from "./state.js";
const POLL_MS = 15_000;
// The data directory comes from `${CLAUDE_PLUGIN_DATA}` substituted into the monitor command:
// the environment variable of the same name can belong to another plugin whose hook exported it.
const dataDir = process.argv[2];
const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
let caffeinate;
function setAwake(on) {
    if (on && !caffeinate && existsSync("/usr/bin/caffeinate")) {
        // -w releases the assertion if this monitor dies with the session.
        caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
        caffeinate.on("exit", () => {
            caffeinate = undefined;
        });
    }
    else if (!on && caffeinate) {
        caffeinate.kill();
        caffeinate = undefined;
    }
}
// A heartbeat on every poll tells the start command that this session has a monitor that reads its state.
if (dataDir && sessionId) {
    try {
        pruneHeartbeats(dataDir);
        writeHeartbeat(dataDir, sessionId);
    }
    catch {
        // The first poll writes it again.
    }
}
// Every stdout line reaches Claude as a notification, so only refresh beats are written there,
// and the process never exits on its own; Claude Code stops it when the session ends.
setInterval(() => {
    if (!dataDir || !sessionId)
        return;
    try {
        writeHeartbeat(dataDir, sessionId);
        tick({ dataDir, sessionId, now: new Date(), emit: (line) => process.stdout.write(`${line}\n`), setAwake });
    }
    catch {
        // A transcript line caught mid-write, or a racing state write; the next poll retries.
    }
}, POLL_MS);
