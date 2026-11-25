---
name: cache-warmer
description: 分析或保温本会话的 prompt cache。/cache-warmer 只分析；/cache-warmer start 2h 离开期间自动保温（只在比冷启动便宜时启动），可加 --grace 45m、--force、--no-awake、--via skill；/cache-warmer stop 提前停止；/cache-warmer dashboard 看历史。只由用户手动调用。
disable-model-invocation: true
argument-hint: "[start <离开时长> | stop | dashboard]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/dist/cli.js" *)
hooks:
  UserPromptSubmit:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/skill-hook-main.js" || node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/cache-warmer/dist/skill-hook-main.js"'
          timeout: 10
  Stop:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/skill-hook-main.js" || node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/cache-warmer/dist/skill-hook-main.js"'
          timeout: 10
  SessionEnd:
    - hooks:
        - type: command
          command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/skill-hook-main.js" || node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/cache-warmer/dist/skill-hook-main.js"'
          timeout: 10
---

!`node "${CLAUDE_SKILL_DIR}/dist/cli.js" $ARGUMENTS --provider claude --session "${CLAUDE_SESSION_ID}" --driver cron`

把上面 Cache Warmer 的输出放进 ```text 代码块展示给用户，不要改动任何数字，但不要展示以「下一步」开头的行。
如果输出里有「下一步」，照它做：用 CronList、CronDelete、CronCreate 这几个工具，参数一字不改，做完只按它说的回复一行。
