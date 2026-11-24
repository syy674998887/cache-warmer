import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, test } from "node:test";
import { dashboard } from "../src/dashboard.js";
import { expansionArgs, onSessionEnd, onStop } from "../src/hook.js";
import { keeperStatusLine, runSummary, startKeeper, stopKeeper } from "../src/keeper.js";
import { formatClock } from "../src/format.js";
import { BEAT_TEXT, tick } from "../src/monitor.js";
import { lookupModel } from "../src/pricing.js";
import type { SessionSnapshot } from "../src/session.js";
import { finishRun, readHistory, readState, writeHeartbeat, writeState, type KeeperState } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "cache-warmer-keeper-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");

const T0 = new Date("2026-09-22T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const CONTEXT = 500_000;

let counter = 0;
function fixture() {
  counter += 1;
  const sessionId = `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  const dataDir = join(root, `data-${counter}`);
  const transcript = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-proj", `${sessionId}.jsonl`);
  mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-proj"), { recursive: true });
  writeFileSync(transcript, "");
  // The session's monitor is running when the tests start their runs.
  writeHeartbeat(dataDir, sessionId, at(1));
  // The metadata Claude Code 2.1.286 writes on each kind of user record; message text is never read.
  const SOURCES = {
    typed: { origin: { kind: "human" }, promptSource: "typed" },
    command: { origin: { kind: "human" } },
    notification: { origin: { kind: "task-notification" }, promptSource: "system" },
  };
  const request = (minute: number, read: number, write: number, kind: keyof typeof SOURCES = "typed") => {
    const lines = [
      { type: "user", timestamp: at(minute).toISOString(), ...SOURCES[kind], message: { role: "user", content: kind } },
      {
        type: "assistant",
        requestId: `req_${minute}`,
        timestamp: at(minute + 0.05).toISOString(),
        message: {
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 2,
            output_tokens: 10,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: write,
            cache_creation: { ephemeral_1h_input_tokens: write, ephemeral_5m_input_tokens: 0 },
          },
        },
      },
    ];
    appendFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  };
  const snapshot: SessionSnapshot = {
    provider: "claude",
    id: sessionId,
    modelId: "claude-opus-5-5",
    price: lookupModel("claude-opus-5-5"),
    ttlLabel: "1h",
    ttlMinutes: 60,
    leadMinutes: 5,
    contextTokens: CONTEXT,
    lastRequestStart: T0,
    coldBp: 20000,
    overheadScaled: 400 * 20000 + 50 * 50000,
    notes: [],
  };
  const emitted: string[] = [];
  const awake: boolean[] = [];
  const run = (minute: number) =>
    tick({ dataDir, sessionId, now: at(minute), emit: (line) => emitted.push(line), setAwake: (on) => awake.push(on) });
  return { sessionId, dataDir, transcript, request, snapshot, emitted, awake, run, state: () => readState(dataDir, sessionId)! };
}

test("keeps the cache warm across the declared window, costs each refresh, and settles when the user is back", () => {
  const f = fixture();
  f.request(0, CONTEXT - 1000, 1000);
  const message = startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: true, now: at(1) });
  assert.match(message, /已开始保温/);
  assert.equal(f.state().plannedBeats, 2);

  f.run(10);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.awake.at(-1), process.platform === "darwin");

  f.run(56.5); // 55 minutes after the start command's own turn
  assert.equal(f.emitted.length, 1);
  assert.equal(f.emitted[0], BEAT_TEXT);
  f.request(56.6, CONTEXT, 400, "notification");
  f.run(57);
  assert.equal(f.state().beats, 1);
  assert.equal(f.state().awaitingSince, null);

  f.run(111.7);
  assert.equal(f.emitted.length, 2);
  f.request(111.8, CONTEXT + 400, 500, "notification");
  f.run(112);
  assert.equal(f.state().beats, 2);

  f.run(113); // the cache now lasts past the deadline (start + 150 minutes)
  assert.equal(f.state().status, "stopped");
  assert.match(f.state().stopReason!, /保温完成/);
  assert.equal(f.state().outcome, null);
  assert.equal(f.state().warmUntil, at(171.8).toISOString());
  assert.equal(f.awake.at(-1), false);
  assert.equal(f.emitted.length, 2);
  // Each refresh: reads at 0.05x, writes at the 1h rate (2x), 2 uncached input tokens, 10 output tokens at 5x.
  assert.equal(f.state().spentScaled, 258_520_000 + 260_720_000);

  f.request(150, CONTEXT + 900, 50, "typed");
  f.run(150.5);
  assert.equal(f.state().outcome, "warm");
  // A cold resume would have rewritten the context the run started with at 2x instead of reading it at 0.05x.
  assert.equal(f.state().savedScaled, (20000 - 500) * CONTEXT - 519_240_000);
  assert.equal(readHistory(f.dataDir).length, 1);
  assert.equal(f.emitted.length, 2);
});

test("settles as cold when the cache expires before the user is back", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "1h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(56.5);
  f.request(56.6, CONTEXT, 400, "notification");
  f.run(57);
  f.run(58);
  assert.match(f.state().stopReason!, /保温完成/);
  f.run(116);
  assert.equal(f.state().outcome, null);
  f.run(117);
  assert.equal(f.state().outcome, "cold");
  assert.equal(f.state().endedAt, at(116.6).toISOString());
  assert.equal(f.state().savedScaled, -f.state().spentScaled);
  assert.match(runSummary(f.state()), /过期时你还没回来，这次没有省到。$/);
});

test("while waiting, a request before the cache expired extends it; one after expiry rebuilt it and does not", () => {
  const waiting = () => {
    const f = fixture();
    f.request(0, CONTEXT, 100);
    startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "1h", graceText: "30m", force: false, awake: false, now: at(1) });
    f.run(56.5);
    f.request(56.6, CONTEXT, 400, "notification");
    f.run(57);
    f.run(58); // refreshing is over; the cache lasts until 116.6
    return f;
  };
  const extended = waiting();
  extended.request(100, CONTEXT, 50, "command");
  extended.run(117);
  assert.equal(extended.state().outcome, null);
  assert.equal(extended.state().warmUntil, at(160).toISOString());
  extended.run(161);
  assert.equal(extended.state().outcome, "cold");
  assert.equal(extended.state().endedAt, at(160).toISOString());

  const rebuilt = waiting();
  rebuilt.request(130, 30_000, CONTEXT, "command");
  rebuilt.run(131);
  assert.equal(rebuilt.state().outcome, "cold");
  assert.equal(rebuilt.state().endedAt, at(116.6).toISOString());
});

test("stops at the most refreshes the run allows, though the deadline is still ahead", () => {
  const f = fixture();
  f.request(0, CONTEXT - 1000, 1000);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  writeState(f.dataDir, { ...f.state(), beats: 1, maxBeats: 1 });
  f.run(56.5);
  assert.equal(f.emitted.length, 0);
  assert.equal(f.state().status, "stopped");
  assert.match(f.state().stopReason!, /已达到持平点/);
  assert.equal(f.state().outcome, null);
  assert.equal(f.state().warmUntil, at(61).toISOString());
});

test("stops as soon as the user types again", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.request(20, CONTEXT, 300, "typed");
  f.run(21);
  assert.equal(f.state().status, "stopped");
  assert.match(f.state().stopReason!, /你回来了/);
  // Back within the first TTL: the cache would still have been warm without the keeper.
  assert.equal(f.state().outcome, "warm");
  assert.equal(f.state().savedScaled, 0);
  assert.equal(f.emitted.length, 0);
});

test("a machine that slept through the refreshes settles as cold, judged by what the user's own request read", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "4h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.request(200, 30_000, CONTEXT, "typed"); // only the prefix shared with other sessions was still cached
  f.run(200.5);
  assert.equal(f.state().outcome, "cold");
  assert.equal(f.state().savedScaled, 0);
  assert.match(runSummary(f.state()), /你回来时 cache 已经过期，这次没有省到。$/);
});

test("a command run on return after the cache expired makes the run cold, though it was the last request", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "4h", graceText: "30m", force: false, awake: false, now: at(1) });
  // No monitor ran: nothing refreshed the cache until a slash command 10 hours later rebuilt it.
  f.request(600, 30_000, CONTEXT, "command");
  f.request(601, CONTEXT, 100, "typed");
  f.run(601.5);
  assert.equal(f.state().outcome, "cold");
  assert.equal(f.state().savedScaled, 0);
});

test("start refuses when no monitor that reads this state format is running for the session", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  const options = { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false };
  // The heartbeat from minute 1 is stale by minute 3.
  const refused = startKeeper(f.snapshot, { ...options, now: at(3) });
  assert.match(refused, /monitor 没在运行/);
  assert.match(refused, new RegExp(`claude --resume ${f.sessionId}`));
  assert.match(refused, /disableAllHooks/);
  assert.equal(readState(f.dataDir, f.sessionId), undefined);
  // A monitor started before the state format changed writes no heartbeat of this version.
  writeFileSync(join(f.dataDir, "monitors", f.sessionId), "1");
  assert.match(startKeeper(f.snapshot, { ...options, now: at(1) }), /monitor 没在运行/);
  writeHeartbeat(f.dataDir, f.sessionId, at(1));
  assert.match(startKeeper(f.snapshot, { ...options, now: at(1) }), /已开始保温/);
  assert.match(keeperStatusLine(f.dataDir, f.sessionId)!, /monitor 没在运行/);
});

test("slash commands, such as the start command's own record, do not count as the user returning", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.request(1.01, CONTEXT, 300, "command");
  f.run(5);
  assert.equal(f.state().status, "active");
});

test("stops when a refresh reply misses the cache", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(56.5);
  f.request(56.6, 20_000, CONTEXT, "notification");
  f.run(57);
  assert.equal(f.state().status, "stopped");
  assert.match(f.state().stopReason!, /没有命中/);
  assert.equal(f.state().outcome, "failed");
  // The miss rewrote the context at 2x: the dearest request of the run is charged too.
  assert.equal(f.state().spentScaled, 20_000 * 500 + CONTEXT * 20000 + 2 * 10000 + 10 * 50000);
  assert.equal(f.state().savedScaled, -f.state().spentScaled);
});

test("stops silently when the cache already expired, e.g. after the machine slept", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "4h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(90);
  assert.equal(f.state().status, "stopped");
  assert.match(f.state().stopReason!, /已经过期/);
  assert.equal(f.state().outcome, "failed");
  assert.equal(f.emitted.length, 0);
});

test("start refuses past the break-even point unless forced; stop ends an active run", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  const refused = startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "3d", graceText: "30m", force: false, awake: false, now: at(1) });
  assert.match(refused, /没有启动/);
  assert.equal(readState(f.dataDir, f.sessionId), undefined);

  const forced = startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "3d", graceText: "30m", force: true, awake: false, now: at(1) });
  assert.match(forced, /--force/);
  assert.equal(f.state().maxBeats, f.state().plannedBeats);

  assert.match(stopKeeper(f.dataDir, f.sessionId, at(2)), /^Cache Warmer 保温总结：.*刷新 0 次.*没有省到。$/);
  assert.equal(f.state().status, "stopped");
  assert.equal(f.state().outcome, "warm");
  assert.equal(f.state().summaryShown, true);
  assert.match(stopKeeper(f.dataDir, f.sessionId, at(3)), /没有正在进行/);
});

test("starting again settles the session's open run first", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  writeHeartbeat(f.dataDir, f.sessionId, at(5));
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "3h", graceText: "30m", force: false, awake: false, now: at(5) });
  assert.equal(readHistory(f.dataDir).length, 1);
  assert.equal(f.state().status, "active");
  assert.equal(f.state().startedAt, at(5).toISOString());
});

test("a stale snapshot settles nothing once the session moved on, and a settled run is not settled twice", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  const first = f.state();
  writeHeartbeat(f.dataDir, f.sessionId, at(5));
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "3h", graceText: "30m", force: false, awake: false, now: at(5) });
  assert.equal(finishRun(f.dataDir, first, "warm", at(6)), undefined);
  assert.equal(f.state().startedAt, at(5).toISOString());
  assert.equal(readHistory(f.dataDir).length, 1);

  const second = f.state();
  stopKeeper(f.dataDir, f.sessionId, at(7));
  assert.equal(finishRun(f.dataDir, second, "cold", at(8))?.outcome, "warm");
  assert.equal(readHistory(f.dataDir).length, 2);
});

test("the Stop hook shows the summary once the user is back, once per run", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "1h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(56.5);
  f.request(56.6, CONTEXT, 400, "notification");
  f.run(57);
  // The refresh turn ends too, but nobody typed anything.
  assert.equal(onStop(f.dataDir, f.sessionId, f.transcript), undefined);
  f.request(80, CONTEXT + 400, 50, "typed");
  const summary = onStop(f.dataDir, f.sessionId, f.transcript);
  assert.match(summary!, /^Cache Warmer 保温总结：.*刷新 1 次.*你回来时 cache 还热，比冷启动省约 94\.9 万 token 当量 ≈ \$3\.80。$/);
  assert.equal(f.state().outcome, "warm");
  assert.equal(onStop(f.dataDir, f.sessionId, f.transcript), undefined);
  f.run(81);
  assert.equal(readHistory(f.dataDir).length, 1);
});

test("leaving the session with /clear or /resume ends its run with nothing saved, and the old monitor refreshes no more", () => {
  const f = fixture();
  f.request(0, CONTEXT - 1000, 1000);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(56.5);
  f.request(56.6, CONTEXT, 400, "notification");
  f.run(57);
  // Past the first TTL: coming back now would have avoided a cold resume, but this context is left behind.
  onSessionEnd(f.dataDir, f.sessionId, at(90));
  assert.equal(f.state().outcome, "failed");
  assert.equal(f.state().savedScaled, -f.state().spentScaled);
  assert.match(runSummary(f.state()), /切换了会话，保温自动停止，这次没有省到/);
  f.run(111.7);
  assert.equal(f.emitted.length, 1);
  onSessionEnd(f.dataDir, f.sessionId, at(100));
  assert.equal(f.state().endedAt, at(90).toISOString());
  assert.equal(readHistory(f.dataDir).length, 1);
});

test("typed commands that need no model turn map to the CLI; a start with a duration stays with its skill", () => {
  const session = ["--session", "s1", "--data", "/data"];
  assert.deepEqual(expansionArgs("cache-warmer:dashboard", "", "s1", "/data"), ["dashboard", ...session]);
  assert.deepEqual(expansionArgs("cache-warmer:stop", "", "s1", "/data"), ["stop", ...session]);
  assert.deepEqual(expansionArgs("cache-warmer:start", " ", "s1", "/data"), ["start", "--provider", "claude", ...session]);
  assert.equal(expansionArgs("cache-warmer:start", "2h --no-awake", "s1", "/data"), undefined);
  assert.equal(expansionArgs("other:thing", "", "s1", "/data"), undefined);
});

test("the dashboard sums settled runs and marks this session's", () => {
  const f = fixture();
  const view = (minute: number) => dashboard(f.dataDir, f.sessionId, at(minute));
  const project = basename(process.cwd());
  assert.match(view(0), /还没有保温记录/);
  f.request(0, CONTEXT, 100);
  startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "1h", graceText: "30m", force: false, awake: false, now: at(1) });
  f.run(56.5);
  f.request(56.6, CONTEXT, 400, "notification");
  f.run(57);
  writeHeartbeat(f.dataDir, f.sessionId, at(57.5));
  assert.match(view(57.5), new RegExp(`进行中 · ${project} · 已刷新 1/1 次，截止 \\d\\d:\\d\\d（本会话）`));
  f.request(80, CONTEXT + 400, 50, "typed");
  f.run(80.5);
  const text = view(81);
  // Saved: 19,500 x 500,000 - 258,520,000 = 9,491,480,000 scaled, about 949k token-equivalents, $3.80 at $4 per million.
  assert.match(text, /共 1 次，其中 1 次你回来时 cache 还热/);
  assert.match(text, /净节省约 94\.9 万 token 当量（按 API 价 \$3\.80）/);
  assert.ok(text.includes(`${project} · 刷新 1 次，花 2.6 万 · 回来时 cache 还热，省 94.9 万（本会话）`));
});

test("the dashboard settles runs whose monitor is gone, by the user's return or once the cache expired", () => {
  const started = (refreshed: boolean) => {
    const f = fixture();
    f.request(0, CONTEXT, 100);
    startKeeper(f.snapshot, { dataDir: f.dataDir, awayText: "1h", graceText: "30m", force: false, awake: false, now: at(1) });
    if (refreshed) {
      f.run(56.5);
      f.request(56.6, CONTEXT, 400, "notification");
      f.run(57);
      f.run(58); // refreshing is over; the cache lasts until 116.6
    }
    return f;
  };
  // The heartbeat written at minute 1 is long stale in every case below: the session was closed.
  const back = started(false);
  back.request(40, CONTEXT, 50, "typed");
  dashboard(back.dataDir, back.sessionId, at(300));
  assert.equal(back.state().outcome, "warm");

  const brokenOff = started(false);
  assert.match(dashboard(brokenOff.dataDir, brokenOff.sessionId, at(30)), /进行中 · .*（monitor 失联）/);
  assert.equal(brokenOff.state().outcome, null);
  dashboard(brokenOff.dataDir, brokenOff.sessionId, at(300));
  assert.equal(brokenOff.state().outcome, "failed");
  assert.equal(brokenOff.state().endedAt, at(61).toISOString());

  const ranOut = started(true);
  assert.match(dashboard(ranOut.dataDir, ranOut.sessionId, at(300)), /cache 已过期，没有省到/);
  assert.equal(ranOut.state().outcome, "cold");
  assert.equal(ranOut.state().endedAt, at(116.6).toISOString());

  // A command before the cache expired extended it after the monitor was gone.
  const extended = started(true);
  extended.request(100, CONTEXT, 50, "command");
  const waiting = `cache 保持到 ${formatClock(at(160))}（monitor 失联）`;
  assert.ok(dashboard(extended.dataDir, extended.sessionId, at(117)).includes(waiting));
  dashboard(extended.dataDir, extended.sessionId, at(161));
  assert.equal(extended.state().outcome, "cold");
  assert.equal(extended.state().endedAt, at(160).toISOString());
  assert.equal(extended.state().warmUntil, extended.state().endedAt);
  assert.match(runSummary(extended.state()), /过期时你还没回来，这次没有省到。$/);
});

test("the dashboard keeps the sign of the net saving in USD when models of different prices mix", () => {
  const f = fixture();
  const run = (saved: number, usd: number) =>
    ({ ...f.snapshot, version: 3, sessionId: f.sessionId, cwd: "/work/demo", startedAt: at(1).toISOString(), beats: 1, outcome: "warm", spentScaled: 100_000_000, savedScaled: saved, inputUsdPerMTok: usd }) as unknown as KeeperState;
  mkdirSync(f.dataDir, { recursive: true });
  // +100k token-equivalents at $4 per million is +$0.40; -50k at $10 per million is -$0.50.
  writeFileSync(join(f.dataDir, "history.jsonl"), `${JSON.stringify(run(1_000_000_000, 4))}\n${JSON.stringify({ ...run(-500_000_000, 10), startedAt: at(2).toISOString() })}\n`);
  assert.match(dashboard(f.dataDir, f.sessionId, at(3)), /净节省约 5 万 token 当量（按 API 价 -\$0\.10）/);
});

test("Codex start hands the model a sleep plan, or refuses with the Codex command", () => {
  const snapshot: SessionSnapshot = {
    provider: "codex",
    id: "01a0f400-0000-7000-8000-000000000009",
    modelId: "gpt-6-astra",
    price: lookupModel("gpt-6-astra"),
    ttlLabel: "30 分钟",
    ttlMinutes: 30,
    leadMinutes: 5,
    contextTokens: 160_000,
    lastRequestStart: T0,
    coldBp: 10000,
    overheadScaled: 250 * 10000 + 20 * 50000,
    notes: [],
  };
  const started = startKeeper(snapshot, { awayText: "2h", graceText: "30m", force: false, awake: false, now: at(1) });
  assert.match(started, /保温计划：用 sleep 工具睡 5 次，每次 duration_ms=1500000$/);
  const refused = startKeeper(snapshot, { awayText: "8h", graceText: "30m", force: false, awake: false, now: at(1) });
  assert.match(refused, /执行 \$cache-warmer:start 8h --no-awake --force。/);
});
