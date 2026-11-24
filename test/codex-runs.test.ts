import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { readCodexThread } from "../src/codex.js";
import { allKeepWarmRuns, readKeepWarmRuns, settleCodexRun, sleptRecently } from "../src/codex-runs.js";
import { codexDashboard } from "../src/dashboard.js";
import { onCodexStop } from "../src/hook.js";
import { runSummary } from "../src/keeper.js";
import { BUNDLED_PRICING } from "../src/pricing.js";

const root = mkdtempSync(join(tmpdir(), "cache-warmer-codex-"));
after(() => rmSync(root, { recursive: true, force: true }));

const table = BUNDLED_PRICING;
const T0 = Date.parse("2026-11-04T10:00:00.000Z");
const at = (minute: number) => new Date(T0 + minute * 60_000);
const stamp = (minute: number) => at(minute).toISOString();
const SLEEP_MS = 1_500_000;

let counter = 0;

/** The records Codex 0.166 writes, without the text and the fields the plugin does not read. */
function rollout(options: { plan?: string | null; model?: string; home?: string; source?: unknown } = {}) {
  counter += 1;
  const threadId = `01a1a83f-0000-7000-8000-${String(counter).padStart(12, "0")}`;
  const plan = options.plan === undefined ? "pro" : options.plan;
  const records: object[] = [
    { type: "session_meta", timestamp: stamp(-1), payload: { id: threadId, cwd: "/work/project", source: options.source ?? "cli" } },
    // Every rollout lists the tools, so the name of the sleep tool alone says nothing about a call.
    { type: "response_item", timestamp: stamp(-1), payload: { type: "additional_tools", tools: [{ name: "sleep", parameters: { properties: { duration_ms: { type: "integer" } } } }] } },
    { type: "turn_context", timestamp: stamp(-1), payload: { model: options.model ?? "gpt-6-astra", cwd: "/work/project" } },
    { type: "event_msg", timestamp: stamp(-1), payload: { type: "token_count", rate_limits: plan ? { plan_type: plan } : {} } },
  ];
  const event = (minute: number, payload: object) => records.push({ type: "event_msg", timestamp: stamp(minute), payload });
  const r = {
    threadId,
    turn(minute: number, id: string) {
      event(minute, { type: "task_started", turn_id: id });
      return r;
    },
    user(minute: number, id: string) {
      event(minute, { type: "item_completed", turn_id: id, item: { type: "UserMessage" } });
      return r;
    },
    sleep(minute: number, callId: string, durationMs = SLEEP_MS) {
      records.push({
        type: "response_item",
        timestamp: stamp(minute),
        payload: { type: "function_call", name: "sleep", namespace: "clock", call_id: callId, arguments: JSON.stringify({ duration_ms: durationMs }) },
      });
      return r;
    },
    woke(minute: number, callId: string) {
      records.push({ type: "response_item", timestamp: stamp(minute), payload: { type: "function_call_output", call_id: callId } });
      return r;
    },
    usage(minute: number, turnId: string, input: number, cached: number) {
      records.push({
        type: "token_usage_record",
        timestamp: stamp(minute),
        payload: { turn_id: turnId, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 20 } },
      });
      return r;
    },
    aborted(minute: number, id: string) {
      event(minute, { type: "turn_aborted", turn_id: id, reason: "interrupted" });
      return r;
    },
    /** Two sleeps that run their course: the first wake-up and the closing reply are the refreshes. */
    keepWarm(turnId = "t1") {
      return r
        .turn(0, turnId)
        .user(0, turnId)
        .sleep(1, "c1")
        .usage(1, turnId, 200_000, 180_000)
        .woke(26, "c1")
        .sleep(26, "c2")
        .usage(26, turnId, 200_100, 199_900)
        .woke(51, "c2")
        .usage(51, turnId, 200_200, 200_000);
    },
    write(): string {
      const dir = join(options.home ?? join(root, "default"), "sessions", "2026", "11", "04");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-11-04T10-00-00-${threadId}.jsonl`);
      writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
      return path;
    },
  };
  return r;
}

const onlyRun = (path: string) => {
  const runs = readKeepWarmRuns(path, table);
  assert.equal(runs.length, 1);
  return runs[0]!;
};

test("a run that sleeps its plan out: each refresh costs its real usage and the return settles it", () => {
  const path = rollout().keepWarm().turn(60, "t2").user(60, "t2").usage(60, "t2", 200_300, 200_100).write();
  const run = onlyRun(path);
  assert.equal(run.turnId, "t1");
  assert.equal(run.contextTokens, 200_000);
  assert.equal(run.refreshes.length, 2);
  assert.equal(run.returnTurn, "t2");

  const settled = settleCodexRun(run, table, at(61));
  assert.equal(settled.outcome, "warm");
  assert.equal(settled.beats, 2);
  assert.equal(settled.misses, 0);
  // Codex credits: cached at 0.1x, the uncached tail at 1x, 20 output tokens at 5x, for each of the two refreshes.
  assert.equal(settled.spentScaled, 405_900_000);
  // (1x - 0.1x) x 200k against a cold resume, less what the refreshes cost.
  assert.equal(settled.savedScaled, 1_394_100_000);
});

test("a message during a sleep ends the run in the same turn, and its request is the user's, not a refresh", () => {
  const path = rollout()
    .turn(0, "t1")
    .user(0, "t1")
    .sleep(1, "c1")
    .usage(1, "t1", 200_000, 180_000)
    .woke(26, "c1")
    .sleep(26, "c2")
    .usage(26, "t1", 200_100, 199_900)
    .woke(40, "c2")
    .user(40.01, "t1")
    .usage(40.1, "t1", 200_200, 200_000)
    .write();
  const run = onlyRun(path);
  assert.equal(run.returnTurn, "t1");
  assert.equal(run.refreshes.length, 1);
  assert.equal(settleCodexRun(run, table, at(41)).outcome, "warm");
});

test("a sleep cut short by something other than the user does not end the run", () => {
  const path = rollout()
    .turn(0, "t1")
    .user(0, "t1")
    .sleep(1, "c1")
    .usage(1, "t1", 200_000, 180_000)
    .woke(10, "c1")
    .sleep(10, "c2")
    .usage(10, "t1", 200_100, 199_900)
    .woke(35, "c2")
    .usage(35, "t1", 200_200, 200_000)
    .write();
  const run = onlyRun(path);
  assert.equal(run.presentAt, undefined);
  assert.equal(run.refreshes.length, 2);
});

test("Esc ends the run when it is pressed; the summary waits for the next message", () => {
  const path = rollout()
    .turn(0, "t1")
    .user(0, "t1")
    .sleep(1, "c1")
    .usage(1, "t1", 200_000, 180_000)
    .woke(26, "c1")
    .sleep(26, "c2")
    .usage(26, "t1", 200_100, 199_900)
    .aborted(40, "t1")
    .turn(50, "t2")
    .user(50, "t2")
    .write();
  const run = onlyRun(path);
  assert.deepEqual(run.presentAt, at(40));
  assert.equal(run.returnTurn, "t2");
  assert.equal(onCodexStop(path, "t1", table), undefined);
  assert.match(onCodexStop(path, "t2", table)!, /你回来时 cache 还热/);
});

test("coming back after the cache expired is cold, and the run saved nothing", () => {
  const run = onlyRun(rollout().keepWarm().turn(120, "t2").user(120, "t2").write());
  const settled = settleCodexRun(run, table, at(121));
  assert.equal(settled.outcome, "cold");
  assert.equal(settled.savedScaled, -settled.spentScaled);
  assert.match(runSummary(settled), /你回来时 cache 已经过期/);
});

test("while the user is away the run stays open until its cache expires", () => {
  const run = onlyRun(rollout().keepWarm().write());
  const open = settleCodexRun(run, table, at(60));
  assert.equal(open.outcome, null);
  assert.equal(open.warmUntil, stamp(81));
  const expired = settleCodexRun(run, table, at(100));
  assert.equal(expired.outcome, "cold");
  assert.equal(expired.endedAt, stamp(81));
  assert.match(runSummary(expired), /过期时你还没回来/);
});

test("sleeps of any other length are not keep-warm", () => {
  const path = rollout().turn(0, "t1").user(0, "t1").sleep(1, "c1", 30_000).usage(1, "t1", 200_000, 199_000).woke(1.5, "c1").write();
  assert.deepEqual(readKeepWarmRuns(path, table), []);
});

test("a refresh that missed is charged and named, though the run went on", () => {
  const path = rollout()
    .turn(0, "t1")
    .user(0, "t1")
    .sleep(1, "c1")
    .usage(1, "t1", 200_000, 180_000)
    .woke(26, "c1")
    .usage(26, "t1", 200_100, 12_928)
    .turn(40, "t2")
    .user(40, "t2")
    .write();
  const settled = settleCodexRun(onlyRun(path), table, at(41));
  assert.equal(settled.misses, 1);
  assert.equal(settled.spentScaled, 12_928 * 1000 + (200_100 - 12_928) * 10000 + 20 * 50000);
  assert.match(runSummary(settled), /其中 1 次刷新没有命中 cache/);
});

test("on the API a refresh's uncached tail and the avoided rewrite are priced at the write rate", () => {
  const path = rollout({ plan: null }).keepWarm().turn(60, "t2").user(60, "t2").write();
  const settled = settleCodexRun(onlyRun(path), table, at(61));
  assert.equal(settled.spentScaled, 199_900 * 1000 + 200 * 12500 + 20 * 50000 + 200_000 * 1000 + 200 * 12500 + 20 * 50000);
  assert.equal(settled.savedScaled, (12500 - 1000) * 200_000 - settled.spentScaled);
});

test("one rollout can hold several runs; starting again is the user coming back from the first", () => {
  const path = rollout()
    .keepWarm()
    .turn(60, "t2")
    .user(60, "t2")
    .sleep(61, "d1")
    .usage(61, "t2", 201_000, 200_500)
    .woke(86, "d1")
    .usage(86, "t2", 201_100, 200_900)
    .write();
  const runs = readKeepWarmRuns(path, table);
  assert.deepEqual(runs.map((r) => [r.turnId, r.refreshes.length, r.returnTurn]), [
    ["t1", 2, "t2"],
    ["t2", 1, undefined],
  ]);
});

test("the Stop hook shows the summary in the turn the user came back in, and only there", () => {
  const path = rollout().keepWarm().write();
  assert.equal(onCodexStop(path, "t1", table), undefined);

  const back = rollout().keepWarm().turn(60, "t2").user(60, "t2").write();
  assert.equal(onCodexStop(back, "t1", table), undefined);
  const summary = onCodexStop(back, "t2", table);
  assert.match(summary!, /Cache Warmer 保温总结：.*刷新 2 次.*比冷启动省约/);

  const later = rollout().keepWarm().turn(60, "t2").user(60, "t2").turn(70, "t3").user(70, "t3").write();
  assert.equal(sleptRecently(later), false);
  assert.equal(onCodexStop(later, "t3", table), undefined);
});

test("a thread with no completed request yet says what to do, not where the file is", () => {
  const path = rollout().turn(0, "t1").user(0, "t1").write();
  assert.throws(() => readCodexThread(path), /先发一条消息/);
});

test("the Stop hook passes turns in sessions that never kept warm", () => {
  const path = rollout().turn(0, "t1").user(0, "t1").usage(1, "t1", 50_000, 40_000).write();
  assert.equal(sleptRecently(path), false);
  assert.equal(onCodexStop(path, "t1", table), undefined);
});

test("the dashboard adds up every rollout and marks this thread and the runs still open", () => {
  const home = join(root, "dashboard");
  process.env.CODEX_HOME = home;
  assert.match(codexDashboard(table, undefined, at(0)), /还没有保温记录。离开前执行 \$cache-warmer:start/);

  const first = rollout({ home }).keepWarm().turn(60, "t2").user(60, "t2");
  first.write();
  rollout({ home }).keepWarm().turn(120, "t2").user(120, "t2").write();
  rollout({ home }).keepWarm().write();
  rollout({ home }).turn(0, "t1").user(0, "t1").sleep(1, "c1", 30_000).write();
  assert.equal(allKeepWarmRuns(table).length, 3);

  const report = codexDashboard(table, first.threadId, at(70));
  assert.match(report, /共 2 次，其中 1 次你回来时 cache 还热/);
  assert.match(report, /进行中 · project · 已刷新 2 次/);
  assert.match(report, /回来时 cache 还热，省 13\.9 万（本会话）/);
  assert.match(report, /cache 已过期，没有省到/);
});

test("starting again in the same turn is a new run, with a cost of its own", () => {
  const path = rollout()
    .turn(0, "t1")
    .user(0, "t1")
    .sleep(1, "c1")
    .usage(1, "t1", 200_000, 180_000)
    .user(10, "t1") // the start command again, typed during the sleep: the turn goes on
    .woke(10, "c1")
    .sleep(11, "c2")
    .usage(11, "t1", 200_500, 200_000)
    .woke(36, "c2")
    .usage(36, "t1", 200_600, 200_400)
    .write();
  const [first, second] = readKeepWarmRuns(path, table);
  assert.equal(first!.presentAt?.toISOString(), stamp(10));
  assert.equal(first!.refreshes.length, 0);
  assert.equal(second!.startedAt.toISOString(), stamp(11));
  assert.equal(second!.contextTokens, 200_500);
  assert.equal(second!.refreshes.length, 1);
});

test("a subagent forked from a thread repeats its records, and that copy of a run does not count", () => {
  const path = rollout({ source: { subagent: { thread_spawn: { parent_thread_id: "p" } } } }).keepWarm().write();
  assert.deepEqual(readKeepWarmRuns(path, table), []);
});

test("rollouts Codex compressed still count, and a plain file wins over its compressed copy", () => {
  const home = join(root, "compressed");
  process.env.CODEX_HOME = home;
  const compress = (path: string) => writeFileSync(`${path}.zst`, zstdCompressSync(readFileSync(path)));

  const cold = rollout({ home }).keepWarm().write();
  compress(cold);
  rmSync(cold);
  assert.equal(allKeepWarmRuns(table).length, 1);

  // Compressing and restoring both publish the new file before they remove the old one; only the plain one grows.
  const both = rollout({ home }).keepWarm();
  compress(both.write());
  both.turn(60, "t2").user(60, "t2").write();
  const runs = allKeepWarmRuns(table);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.threadId === both.threadId)!.returnTurn, "t2");
});
