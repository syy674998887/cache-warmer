import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analysis } from "./analysis.js";
import { cronBeat, cronSnapshot, START_SKILL } from "./cron.js";
import { codexDashboard, dashboard } from "./dashboard.js";
import { DEFAULT_GRACE, parseDurationMinutes } from "./duration.js";
import { keeperStatusLine, startKeeper, stopKeeper } from "./keeper.js";
import { loadPricing } from "./pricing-remote.js";
import { claudeSnapshot, codexSnapshot } from "./session.js";
import { defaultDataDir } from "./state.js";
const USAGE = `用法：
  cache-warmer start --provider claude --session <id> --data <目录> [离开时长] [--grace 30m] [--force] [--no-awake]
  cache-warmer start --provider codex --thread <id> [离开时长] [--grace 30m] [--force] [--no-awake]
  cache-warmer stop --session <id> --data <目录>
  cache-warmer dashboard --data <目录> [--session <id>]
  cache-warmer dashboard --provider codex [--thread <id>]
单独的 Claude Code skill（${START_SKILL}）加 --driver cron [--via hook|skill] [--first-in 2m（测试用）]，--data 默认 ~/.claude/cache-warmer：
  cache-warmer [start] [离开时长] --provider claude --session <id> --driver cron
  cache-warmer beat --session <id>
start 不带离开时长时只分析当前 cache，不开始保温。`;
const COMMANDS = ["start", "stop", "dashboard", "beat"];
/** Runs one command of the CLI and returns what it prints. */
export async function run(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            provider: { type: "string" },
            session: { type: "string" },
            thread: { type: "string" },
            data: { type: "string" },
            grace: { type: "string", default: DEFAULT_GRACE },
            force: { type: "boolean" },
            "no-awake": { type: "boolean" },
            driver: { type: "string" },
            via: { type: "string" },
            "first-in": { type: "string" },
        },
    });
    if (values.driver !== undefined && values.driver !== "cron")
        throw new Error(`--driver 只能是 cron\n${USAGE}`);
    if (values.via !== undefined && values.via !== "hook" && values.via !== "skill")
        throw new Error(`--via 只能是 hook 或 skill\n${USAGE}`);
    const cron = values.driver === "cron";
    // The skill has no plugin data directory, and takes `/cache-warmer 2h` as a start.
    if (cron && !values.data)
        values.data = defaultDataDir();
    const startImplied = cron && !COMMANDS.includes(positionals[0] ?? "");
    const [command, ...rest] = startImplied ? ["start", ...positionals] : positionals;
    const awayText = rest.join("").trim();
    switch (command) {
        case "start": {
            const loaded = loadSnapshot(values, await pricingFor(values));
            const snapshot = cron && loaded.provider === "claude" ? cronSnapshot(loaded) : loaded;
            if (awayText === "") {
                const status = values.data && snapshot.provider === "claude" ? keeperStatusLine(values.data, snapshot.id) : undefined;
                return analysis(snapshot, status);
            }
            return startKeeper(snapshot, {
                ...(values.data ? { dataDir: values.data } : {}),
                awayText,
                graceText: values.grace,
                force: values.force ?? false,
                awake: !values["no-awake"],
                ...(cron ? { driver: "cron", via: (values.via ?? "hook") } : {}),
                // Testing only: fire the first refresh soon, to see the chain work without waiting most of an hour.
                ...(cron && values["first-in"] ? { firstFireInMinutes: parseDurationMinutes(values["first-in"]) } : {}),
            });
        }
        case "beat":
            if (!values.session)
                throw new Error("缺少 --session");
            return cronBeat(values.data ?? defaultDataDir(), values.session);
        case "stop":
            if (!values.session)
                throw new Error("缺少 --session");
            return stopKeeper(requireData(values), values.session);
        case "dashboard":
            if (values.provider === "codex")
                return codexDashboard((await pricingFor(values)).table, values.thread);
            return cron ? dashboard(requireData(values), values.session, new Date(), START_SKILL) : dashboard(requireData(values), values.session);
        default:
            return USAGE;
    }
}
/** The plugin data directory doubles as the price table cache; Codex skills get no data directory, so they use a temp one. */
function pricingFor(values) {
    return loadPricing({ cacheDir: values.data ?? join(tmpdir(), "cache-warmer") });
}
function requireData(values) {
    if (!values.data)
        throw new Error("缺少 --data");
    return values.data;
}
function loadSnapshot(values, pricing) {
    if (values.provider === "claude") {
        if (!values.session)
            throw new Error("缺少 --session");
        return claudeSnapshot(values.session, pricing);
    }
    if (values.provider === "codex") {
        if (!values.thread)
            throw new Error("缺少 --thread");
        return codexSnapshot(values.thread, pricing);
    }
    throw new Error(`--provider 只能是 claude 或 codex\n${USAGE}`);
}
