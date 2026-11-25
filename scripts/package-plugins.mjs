// Copies the compiled runtime into each plugin, which must be self-contained when installed from the marketplace,
// and into the standalone Claude Code skill, which is copied into ~/.claude/skills as is.
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

// The entry points only the other packages run.
const LEFT_OUT = {
  "plugins/claude": ["codex-hook-main.js", "skill-hook-main.js"],
  "plugins/codex": ["expansion-main.js", "hook-main.js", "monitor-main.js", "skill-hook-main.js"],
  "skills/claude/cache-warmer": ["codex-hook-main.js", "expansion-main.js", "hook-main.js", "monitor-main.js"],
};

for (const [plugin, leftOut] of Object.entries(LEFT_OUT)) {
  const target = `${plugin}/dist`;
  rmSync(target, { recursive: true, force: true });
  cpSync("dist/src", target, { recursive: true, filter: (path) => !leftOut.includes(basename(path)) });
  writeFileSync(`${target}/package.json`, `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
}
