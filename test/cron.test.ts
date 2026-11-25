import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { requestsSince } from "../src/claude.js";
import { run } from "../src/commands.js";
import { BEAT_MARKER, cronBeat, isHookFire, cronExpression, cronSnapshot, firePrompt, nextFireAt, onSkillPrompt } from "../src/cron.js";
import { onStop } from "../src/hook.js";
import { startKeeper, stopKeeper } from "../src/keeper.js";
import { tick } from "../src/monitor.js";
import { lookupModel } from "../src/pricing.js";
import type { SessionSnapshot } from "../src/session.js";
import { readHistory, readState, writeState, type KeeperState } from "../src/state.js";

const root = mkdtempSync(join(tmpdir(), "cache-warmer-cron-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");

const T0 = new Date("2026-09-22T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const CONTEXT = 500_000;
/** One request as the state prices it: reads at 0.05x, writes at the 1h rate (2x), 2 uncached input tokens, 10 output tokens at 5x. */
const cost = (read: number, write: number) => read * 500 + write * 20000 + 2 * 10000 + 10 * 50000;

let counter = 0;
function fixture() {
  counter += 1;
  const sessionId = `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`;
  const dataDir = join(root, `data-${counter}`);
  const transcript = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-proj", `${sessionId}.jsonl`);
  mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects", "-proj"), { recursive: true });
  writeFileSync(transcript, "");
  const request = (minute: number, read: number, write: number) => {
    const lines = [
      { type: "user", timestamp: at(minute).toISOString(), origin: { kind: "human" }, promptSource: "typed", message: { role: "user", content: "x" } },
      {
        type: "assistant",
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
  /** A fire turn on the hook route: the fire prompt's request, then the reply after CronCreate's result. */
  const fireTurn = (minute: number, read = CONTEXT, write = 300) => {
    request(minute, read, write);
    request(minute + 0.1, read + write, 100);
  };
  const base: SessionSnapshot = {
    provider: "claude",
    id: sessionId,
    modelId: "claude-opus-5-5",
    price: lookupModel("claude-opus-5-5"),
    ttlLabel: "1h",
    ttlMinutes: 60,
    leadMinutes: 10,
    contextTokens: CONTEXT,
    lastRequestStart: T0,
    coldBp: 20000,
    overheadScaled: 400 * 20000 + 50 * 50000,
    notes: [],
  };
  const start = (awayText: string, minute = 1, via: "hook" | "skill" = "hook") =>
    startKeeper(cronSnapshot(base), { dataDir, awayText, graceText: "30m", force: false, awake: false, driver: "cron", via, now: at(minute) });
  const fire = (minute: number) => onSkillPrompt(dataDir, sessionId, firePrompt("hook"), "schedule_wakeup", at(minute));
  return { sessionId, dataDir, transcript, request, fireTurn, start, fire, base, state: () => readState(dataDir, sessionId)! };
}

test("cron expressions match one local minute, and fires land on whole minutes at least a minute ahead", () => {
  const fire = new Date(2026, 10, 25, 9, 7);
  assert.equal(cronExpression(fire), "7 9 25 11 *");
  const now = new Date(2026, 10, 25, 9, 0, 20).getTime();
  // 1h tier, planned with an 11-minute lead: the fire comes up to a minute later, never earlier, so by 50 minutes.
  assert.deepEqual(nextFireAt(now + 60 * 60_000, 11, now), new Date(2026, 10, 25, 9, 50));
  // A fire due too soon moves to the next whole minute after a full minute.
  assert.deepEqual(nextFireAt(now + 3 * 60_000, 2.5, now), new Date(2026, 10, 25, 9, 2));
  assert.equal(nextFireAt(now + 90_000, 2.5, now), undefined);
  // :00 and :30 may fire up to 90 seconds early, so they move a minute earlier.
  assert.deepEqual(nextFireAt(now + 40 * 60_000, 11, now), new Date(2026, 10, 25, 9, 29));
  // 5m tier: refreshes are never closer together than the 2.5 minutes the plan counted.
  for (let second = 0; second < 60; second += 7) {
    const t = new Date(2026, 10, 25, 9, 10, second).getTime();
    const fire = nextFireAt(t + 5 * 60_000, 2.5, t)!.getTime();
    assert.ok(fire - t >= 2.5 * 60_000 && fire < t + 5 * 60_000 - 60_000);
  }
  assert.ok(firePrompt("hook").includes(BEAT_MARKER));
  assert.equal(firePrompt("skill"), `/${BEAT_MARKER}`);
  assert.ok(isHookFire(`<scheduled>${firePrompt("hook")}</scheduled>`));
  assert.ok(!isHookFire(`把 prompt 含 ${BEAT_MARKER} 的定时任务删掉`));
});

test("the cron route prices each refresh as two requests and uses the skill's own start command", () => {
  const f = fixture();
  const message = f.start("20h");
  // A 20-hour window is past this break-even point, and the refusal names the skill's command.
  assert.match(message, /没有启动/);
  // Two reads a refresh: the plugin route would allow 37 refreshes for this context.
  assert.match(message, /持平点（18 次）/);
  assert.match(message, /执行 \/cache-warmer start 20h /);
});

test("keeps the cache warm with one-shot tasks, charges each fire turn, and settles when the user is back", () => {
  const f = fixture();
  f.request(0, CONTEXT - 1000, 1000);
  const message = f.start("2h");
  assert.match(message, /已开始保温/);
  // The start turn reads the cache at minute 1: the first fire is due 10 minutes before it expires.
  assert.ok(message.includes(`cron="${cronExpression(at(51))}"`));
  assert.ok(message.includes(`prompt="${firePrompt("hook")}"`));
  assert.equal(f.state().driver, "cron");
  assert.equal(f.state().nextFireAt, at(51).toISOString());
  assert.equal(f.state().plannedBeats, 2);

  const first = f.fire(51)!;
  assert.match(first, /第 1 次刷新/);
  assert.ok(first.includes(`cron="${cronExpression(at(101))}"`));
  assert.equal(f.state().beats, 1);
  assert.equal(f.state().awaitingSince, at(51).toISOString());
  f.fireTurn(51);

  // The cache now lasts past the deadline (start + 150 minutes): no further task.
  const second = f.fire(101)!;
  assert.match(second, /保温完成/);
  assert.match(second, /不要再设定时任务/);
  assert.equal(f.state().status, "stopped");
  assert.equal(f.state().beats, 2);
  assert.equal(f.state().warmUntil, at(161).toISOString());
  assert.equal(f.state().spentScaled, cost(CONTEXT, 300) + cost(CONTEXT + 300, 100));
  f.fireTurn(101);

  // Refreshing was over, so there is no task left to delete; the last fire turn is charged on settling.
  assert.equal(onSkillPrompt(f.dataDir, f.sessionId, "我回来了", "user", at(140)), undefined);
  assert.equal(f.state().outcome, "warm");
  assert.equal(f.state().spentScaled, 2 * (cost(CONTEXT, 300) + cost(CONTEXT + 300, 100)));
  assert.equal(readHistory(f.dataDir).length, 1);
  assert.match(onStop(f.dataDir, f.sessionId, f.transcript)!, /保温总结/);
  assert.equal(onStop(f.dataDir, f.sessionId, f.transcript), undefined);
});

test("a user prompt while tasks are pending ends the run and asks Claude to delete them", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("2h");
  f.fire(51);
  f.fireTurn(51);
  // Slash commands, the skill route's beat command and other sources are not the user coming back.
  assert.equal(onSkillPrompt(f.dataDir, f.sessionId, "/cache-warmer", "user", at(60)), undefined);
  assert.equal(onSkillPrompt(f.dataDir, f.sessionId, `/${BEAT_MARKER}`, "schedule_wakeup", at(60)), undefined);
  assert.equal(onSkillPrompt(f.dataDir, f.sessionId, "task done", "system", at(60)), undefined);
  assert.equal(onSkillPrompt(f.dataDir, f.sessionId, "<task-notification>done</task-notification>", undefined, at(60)), undefined);
  assert.equal(f.state().outcome, null);

  // Payloads may omit the source: a plain prompt then counts as the user's, even one that names the fire marker.
  const context = onSkillPrompt(f.dataDir, f.sessionId, `把 prompt 含 ${BEAT_MARKER} 的定时任务删掉`, undefined, at(70))!;
  assert.match(context, /用户回来了/);
  assert.match(context, /CronDelete/);
  assert.equal(f.state().outcome, "warm");
  assert.equal(f.state().spentScaled, cost(CONTEXT, 300) + cost(CONTEXT + 300, 100));
});

test("a fire turn that missed the cache stops the run", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("2h");
  f.fire(51);
  f.fireTurn(51, 30_000, CONTEXT);
  const answer = f.fire(101)!;
  assert.match(answer, /第 1 次刷新没有命中 cache（只读到 6%）/);
  assert.match(answer, /不要再设定时任务/);
  assert.equal(f.state().outcome, "failed");
});

test("a fire that comes after the cache expired stops the run", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("3h");
  f.fire(51);
  f.fireTurn(51);
  assert.match(f.fire(112)!, /cache 已经过期/);
  assert.equal(f.state().outcome, "failed");
});

test("stops scheduling at the most refreshes the run allows", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("2h");
  writeState(f.dataDir, { ...f.state(), maxBeats: 1 });
  assert.match(f.fire(51)!, /已达到持平点/);
  assert.equal(f.state().status, "stopped");
  assert.equal(f.state().nextFireAt, null);
});

test("for testing, the first fire can come soon after the start", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  const message = startKeeper(cronSnapshot({ ...f.base }), {
    dataDir: f.dataDir,
    awayText: "2h",
    graceText: "30m",
    force: false,
    awake: false,
    driver: "cron",
    firstFireInMinutes: 2,
    now: at(1.3),
  });
  assert.ok(message.includes(`cron="${cronExpression(at(3))}"`));
  // The fire after it is due near expiry again.
  assert.ok(f.fire(3)!.includes(`cron="${cronExpression(at(53))}"`));
});

test("a fire with no open run tells Claude not to reschedule", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  assert.match(cronBeat(f.dataDir, f.sessionId, at(5)), /没有正在进行的保温。不要再设定时任务/);
});

test("stop settles a cron run and asks Claude to delete the pending task; starting again does too", async () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("2h");
  f.fire(51);
  f.fireTurn(51);
  const stopped = stopKeeper(f.dataDir, f.sessionId, at(60));
  assert.match(stopped, /保温总结/);
  assert.match(stopped, /CronDelete/);
  assert.equal(f.state().summaryShown, true);
  assert.equal(f.state().spentScaled, cost(CONTEXT, 300) + cost(CONTEXT + 300, 100));

  const g = fixture();
  g.request(0, CONTEXT, 100);
  g.start("2h");
  const again = g.start("2h", 5);
  assert.match(again, /CronList/);
  assert.equal(readHistory(g.dataDir).length, 1);
});

test("the plugin's monitor leaves cron runs alone", () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  f.start("2h");
  const before: KeeperState = f.state();
  const emitted: string[] = [];
  tick({ dataDir: f.dataDir, sessionId: f.sessionId, now: at(56), emit: (line) => emitted.push(line), setAwake: () => {} });
  assert.deepEqual(emitted, []);
  assert.deepEqual(f.state(), before);
});

test("the beat command and option checks of the CLI", async () => {
  const f = fixture();
  f.request(0, CONTEXT, 100);
  assert.match(await run(["beat", "--session", f.sessionId, "--data", f.dataDir]), /没有正在进行的保温/);
  await assert.rejects(run(["--driver", "monitor"]), /--driver 只能是 cron/);
  await assert.rejects(run(["--driver", "cron", "--via", "x"]), /--via 只能是 hook 或 skill/);
});

test("requests are read with the final usage of each, oldest first", () => {
  const f = fixture();
  f.request(0, 100, 10);
  f.fireTurn(10);
  const requests = requestsSince(f.transcript, at(5));
  assert.deepEqual(
    requests.map((r) => [r.start.toISOString(), r.usage.cacheRead]),
    [
      [at(10).toISOString(), CONTEXT],
      [at(10.1).toISOString(), CONTEXT + 300],
    ],
  );
});
