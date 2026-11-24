import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findTranscript, readClaudeSession, requestStartsSince } from "../src/claude.js";
import { findRollout, readCodexThread } from "../src/codex.js";
import { readLinesReverse } from "../src/jsonl.js";
import { BUNDLED_PRICING } from "../src/pricing.js";
import { claudeSnapshot, codexSnapshot } from "../src/session.js";

const root = mkdtempSync(join(tmpdir(), "cache-warmer-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (records: object[]) => `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

test("readLinesReverse handles chunk boundaries, long lines and a missing final newline", () => {
  const path = join(root, "lines.txt");
  const long = "x".repeat(5000);
  writeFileSync(path, `first\n${long}\nthird`);
  assert.deepEqual([...readLinesReverse(path, 7)], ["third", long, "first"]);
});

test("Claude transcript: last main request, its start time and TTL tier", () => {
  const sessionId = "11111111-2222-3333-4444-555555555555";
  const dir = join(root, "claude", "projects", "-some-project");
  mkdirSync(dir, { recursive: true });
  const usage = (read: number, write: number, tier: "1h" | "5m") => ({
    input_tokens: 3,
    output_tokens: 40,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation: {
      ephemeral_1h_input_tokens: tier === "1h" ? write : 0,
      ephemeral_5m_input_tokens: tier === "5m" ? write : 0,
    },
  });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    jsonl([
      { type: "user", timestamp: "2026-09-22T10:00:00.000Z", message: { role: "user", content: "hi" } },
      { type: "assistant", requestId: "req_1", timestamp: "2026-09-22T10:00:05.000Z", message: { model: "claude-opus-5-5", usage: usage(0, 20000, "1h") } },
      { type: "user", timestamp: "2026-09-22T10:10:00.000Z", message: { role: "user", content: "next" } },
      { type: "assistant", requestId: "req_2", timestamp: "2026-09-22T10:10:04.000Z", message: { model: "claude-opus-5-5", usage: usage(20000, 500, "1h") } },
      { type: "assistant", requestId: "req_2", timestamp: "2026-09-22T10:10:09.000Z", message: { model: "claude-opus-5-5", usage: usage(20000, 500, "1h") } },
      { type: "assistant", isSidechain: true, requestId: "req_side", timestamp: "2026-09-22T10:11:00.000Z", message: { model: "claude-haiku-4-5", usage: usage(0, 900, "5m") } },
      { type: "assistant", requestId: "req_err", timestamp: "2026-09-22T10:12:00.000Z", message: { model: "<synthetic>", usage: usage(0, 0, "5m") } },
      { type: "user", timestamp: "2026-09-22T10:20:00.000Z", message: { role: "user", content: "waiting for a reply" } },
    ]),
  );
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  const path = findTranscript(sessionId);
  assert.ok(path);
  const state = readClaudeSession(path);
  assert.equal(state.model, "claude-opus-5-5");
  assert.equal(state.contextTokens, 20503);
  assert.equal(state.lastRequestStart.toISOString(), "2026-09-22T10:10:00.000Z");
  assert.equal(state.ttl, "1h");
});

test("Claude snapshot: a refresh fires ten minutes before a 1h cache expires, 45 seconds before a 5m one", () => {
  const config = join(root, "claude-lead");
  const dir = join(config, "projects", "-proj");
  mkdirSync(dir, { recursive: true });
  const session = (sessionId: string, tier: "1h" | "5m") =>
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      jsonl([
        { type: "user", timestamp: "2026-11-04T10:00:00.000Z", message: { role: "user", content: "hi" } },
        {
          type: "assistant",
          timestamp: "2026-11-04T10:00:05.000Z",
          message: {
            model: "claude-opus-5-5",
            usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { [`ephemeral_${tier}_input_tokens`]: 1000 } },
          },
        },
      ]),
    );
  session("aaaaaaaa-0000-4000-8000-000000000001", "1h");
  session("aaaaaaaa-0000-4000-8000-000000000002", "5m");
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const pricing = { table: BUNDLED_PRICING, source: "bundled" as const };
    assert.equal(claudeSnapshot("aaaaaaaa-0000-4000-8000-000000000001", pricing).leadMinutes, 10);
    assert.equal(claudeSnapshot("aaaaaaaa-0000-4000-8000-000000000002", pricing).leadMinutes, 0.75);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test("Claude transcript: every request start after a time, including each step of a tool loop", () => {
  const dir = join(root, "claude-starts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "starts.jsonl");
  const usage = { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 };
  const reply = (requestId: string, at: string) => ({ type: "assistant", requestId, timestamp: at, message: { model: "claude-opus-5-5", usage } });
  writeFileSync(
    path,
    jsonl([
      { type: "user", timestamp: "2026-09-22T10:00:00.000Z", message: { role: "user", content: "before" } },
      reply("req_0", "2026-09-22T10:00:05.000Z"),
      { type: "user", timestamp: "2026-09-22T11:00:00.000Z", message: { role: "user", content: "prompt" } },
      reply("req_1", "2026-09-22T11:00:04.000Z"),
      reply("req_1", "2026-09-22T11:00:05.000Z"),
      { type: "user", timestamp: "2026-09-22T11:00:06.000Z", message: { role: "user", content: [{ type: "tool_result" }] } },
      reply("req_2", "2026-09-22T11:00:09.000Z"),
      { type: "user", timestamp: "2026-09-22T12:00:00.000Z", message: { role: "user", content: "not answered yet" } },
    ]),
  );
  const starts = requestStartsSince(path, new Date("2026-09-22T10:30:00.000Z")).map((d) => d.toISOString());
  assert.deepEqual(starts, ["2026-09-22T11:00:06.000Z", "2026-09-22T11:00:00.000Z"]);
});

test("Codex rollout: last token count, request start, plan type and compaction", () => {
  const threadId = "01a0c58c-e9e1-79e2-93fe-2be6006ef569";
  const cwd = "/work/project";
  const dir = join(root, "codex", "sessions", "2026", "09", "22");
  mkdirSync(dir, { recursive: true });
  const tokenCount = (at: string, input: number, cached: number) => ({
    type: "event_msg",
    timestamp: at,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: cached }, model_context_window: 258400 },
      rate_limits: { plan_type: "prolite", primary: { used_percent: 12, window_minutes: 10080 } },
    },
  });
  writeFileSync(
    join(dir, `rollout-2026-09-22T10-00-00-${threadId}.jsonl`),
    jsonl([
      { type: "session_meta", timestamp: "2026-09-22T10:00:00.000Z", payload: { id: threadId, cwd } },
      { type: "turn_context", timestamp: "2026-09-22T10:00:01.000Z", payload: { model: "gpt-6-astra" } },
      { type: "response_item", timestamp: "2026-09-22T10:00:02.000Z", payload: { type: "message", role: "user" } },
      tokenCount("2026-09-22T10:00:30.000Z", 50000, 0),
      { type: "response_item", timestamp: "2026-09-22T10:05:00.000Z", payload: { type: "function_call_output" } },
      { type: "response_item", timestamp: "2026-09-22T10:05:20.000Z", payload: { type: "message", role: "assistant" } },
      tokenCount("2026-09-22T10:05:40.000Z", 52000, 49000),
      { type: "compacted", timestamp: "2026-09-22T10:06:00.000Z", payload: {} },
    ]),
  );
  process.env.CODEX_HOME = join(root, "codex");
  const path = findRollout(threadId);
  assert.ok(path);
  const state = readCodexThread(path);
  assert.equal(state.model, "gpt-6-astra");
  assert.equal(state.contextTokens, 52000);
  assert.equal(state.planType, "prolite");
  assert.equal(state.lastRequestStart.toISOString(), "2026-09-22T10:05:00.000Z");
  assert.equal(state.compactedSinceLastRequest, true);
});

test("Codex snapshot: TTL from the price table, estimated for models it has none for", () => {
  const home = join(root, "codex-ttl");
  const dir = join(home, "sessions", "2026", "09", "30");
  mkdirSync(dir, { recursive: true });
  const rollout = (threadId: string, model: string) =>
    writeFileSync(
      join(dir, `rollout-2026-09-30T10-00-00-${threadId}.jsonl`),
      jsonl([
        { type: "session_meta", timestamp: "2026-09-30T10:00:00.000Z", payload: { id: threadId, cwd: "/work" } },
        { type: "turn_context", timestamp: "2026-09-30T10:00:01.000Z", payload: { model } },
        { type: "response_item", timestamp: "2026-09-30T10:00:02.000Z", payload: { type: "message", role: "user" } },
        {
          type: "event_msg",
          timestamp: "2026-09-30T10:00:30.000Z",
          payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50000, cached_input_tokens: 0 } }, rate_limits: { plan_type: "prolite" } },
        },
      ]),
    );
  rollout("01a0f400-0000-7000-8000-000000000001", "gpt-6.1-sol");
  rollout("01a0f400-0000-7000-8000-000000000002", "gpt-5.5");
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const pricing = { table: BUNDLED_PRICING, source: "bundled" as const };
    const sol = codexSnapshot("01a0f400-0000-7000-8000-000000000001", pricing);
    assert.equal(sol.ttlMinutes, 30);
    assert.equal(sol.ttlLabel, "30 分钟");
    assert.equal(sol.overheadScaled, 250 * 10000 + 20 * 50000);
    const older = codexSnapshot("01a0f400-0000-7000-8000-000000000002", pricing);
    assert.equal(older.ttlMinutes, 30);
    assert.equal(older.ttlLabel, "30 分钟（估算）");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});
