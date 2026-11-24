import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { analysis } from "./analysis.js";
import { codexDashboard, dashboard } from "./dashboard.js";
import { DEFAULT_GRACE } from "./duration.js";
import { keeperStatusLine, startKeeper, stopKeeper } from "./keeper.js";
import { loadPricing } from "./pricing-remote.js";
import { claudeSnapshot, codexSnapshot } from "./session.js";
const USAGE = `用法：
  cache-warmer start --provider claude --session <id> --data <目录> [离开时长] [--grace 30m] [--force] [--no-awake]
  cache-warmer start --provider codex --thread <id> [离开时长] [--grace 30m] [--force] [--no-awake]
  cache-warmer stop --session <id> --data <目录>
  cache-warmer dashboard --data <目录> [--session <id>]
  cache-warmer dashboard --provider codex [--thread <id>]
start 不带离开时长时只分析当前 cache，不开始保温。`;
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
        },
    });
    const [command, ...rest] = positionals;
    const awayText = rest.join("").trim();
    switch (command) {
        case "start": {
            const snapshot = loadSnapshot(values, await pricingFor(values));
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
            });
        }
        case "stop":
            if (!values.session)
                throw new Error("缺少 --session");
            return stopKeeper(requireData(values), values.session);
        case "dashboard":
            if (values.provider === "codex")
                return codexDashboard((await pricingFor(values)).table, values.thread);
            return dashboard(requireData(values), values.session);
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
