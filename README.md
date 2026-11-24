<div align="center">

# Cache Warmer

**Keep your prompt cache warm while you are away, only when it costs less than a cold resume.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English · [简体中文](README.zh-CN.md)

</div>

Cache Warmer is a plugin for Claude Code and Codex. You declare how long you will be away; it compares the cost of the refreshes needed to keep the session's prompt cache alive with the cost of a cold resume, and keeps the cache warm only when that is cheaper.

| Claude Opus 5.5 · 1h TTL · 150k context | Base-input tokens | API price |
|---|---|---|
| One refresh | 0.05× × 150k + about 1,050 overhead = 8,550 | ≈ $0.03 |
| Cold resume | 2× × 150k = 300,000 | ≈ $1.20 |
| Break-even | 34 refreshes, one every 50 minutes | Worth it up to 29 h 20 min away, grace included |

It suits sessions of roughly 100–200k tokens that you will return to, and Codex sessions. Above 200k tokens, Claude Code's idle compaction is usually cheaper.

## Installation

Requires Node.js 22.15 or later (23.8 or later on Node 23). Tested on macOS with Claude Code 2.1.331 and Codex 0.171.0.

### Claude Code

```text
/plugin marketplace add syy674998887/cache-warmer
/plugin install cache-warmer@cache-warmer
```

Start a new session afterwards, or `/exit` and run `claude --resume`. The plugin's monitor starts only with a session.

### Codex

```text
codex plugin marketplace add syy674998887/cache-warmer
codex plugin add cache-warmer@cache-warmer
```

Requires a GPT-6 series model, which provides the `sleep` tool. Trust the plugin's Stop hook when Codex prompts at startup, and again after each update. The hook provides the summary on return; nothing else depends on it.

## Usage

| Claude Code | Codex | Action |
|---|---|---|
| `/cache-warmer:start` | `$cache-warmer:start` | Show cache expiry, refresh and cold-resume cost, and the break-even point |
| `/cache-warmer:start 2h` | `$cache-warmer:start 2h` | Keep warm for the stated time if it pays off |
| `/cache-warmer:stop` | Any message, or Esc | Stop early |
| `/cache-warmer:dashboard` | `$cache-warmer:dashboard` | List past runs with cost, outcome and total savings |

Durations are written as `2h`, `90m` or `1h30m`. Options for `start <duration>`:

| Option | Effect |
|---|---|
| `--grace 45m` | Extra time kept warm in case of a late return. Default: 30 minutes. |
| `--force` | Keep warm past the break-even point. By default the plugin refuses and explains why. |
| `--no-awake` | Do not block macOS idle sleep during the run. |

Sending a message on return ends the run and prints a one-line summary of its cost and savings. Command output is in Chinese.

## How it works

| | Claude Code | Codex |
|---|---|---|
| Refresh | The plugin's monitor posts a short "pause and wait" notice; Claude's one-line reply re-reads the cache | The model loops on the `sleep` tool, 25 minutes at a time; each wake-up re-reads the cache |
| Timing | 10 minutes before a 1h cache expires, ahead of idle compaction at about 54 idle minutes; 45 seconds before a 5m cache expires | 5 minutes before the 30-minute retention ends |
| Verification | After every refresh; the run stops if less than 90% came from cache | None per refresh; misses are reported in the summary and dashboard |
| Commands without a model turn | `start` without a duration, `stop`, `dashboard` | None |

Prices come from a dated snapshot of the official price pages ([`src/pricing.json`](src/pricing.json)), updated from this repository at most once a day. Models missing from the table use family default rates, and the output says so.

## Limitations

- Nothing runs while the computer sleeps. The plugin blocks idle sleep, not lid-close sleep.
- Claude Code monitors are experimental and run only in the interactive CLI. `/clear` and `/resume` do not restart the monitor: to keep warm in another session, `/exit` and run `claude --resume`. A run in progress ends when you switch sessions.
- With `disableAllHooks`, the monitor does not start: Claude Code cannot keep warm, and the other commands cost a model turn.
- Each Claude Code refresh leaves a short exchange in the conversation. Codex shows the session as working for the whole run.
- In Claude Code, hook-answered commands appear under `UserPromptExpansion operation blocked by hook:`. Claude Code adds this header; it is not an error.
- Savings are quoted at API prices. On a subscription the saving is quota and waiting time, not money.
- The plugin reads the clients' internal transcript and rollout formats, which can change between versions.
- Codex does not guarantee cache retention: after a 25-minute sleep, a wake-up occasionally hits only part of the cache.

## Privacy

- Reads only token counts, timestamps and record metadata from transcripts and rollouts; never message text or credential files.
- All model requests are made by the official client. The plugin does not call a model API.
- The only network request downloads the price table from this repository.
- Run records stay on the local machine.

## Development

```text
npm install
npm test          # build, then run the tests
npm run package   # copy the runtime into plugins/*/dist; commit it with src/ changes
```

To try the Claude Code plugin locally: `claude --plugin-dir plugins/claude`.

## License

[MIT](LICENSE)
