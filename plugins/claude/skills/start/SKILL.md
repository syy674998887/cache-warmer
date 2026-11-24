---
name: start
description: 不带参数时分析本会话的 prompt cache：还剩多久、保温与冷启动各花多少、持平点。带离开时长（如 2h、90m）时为本会话自动保温，只在比冷启动便宜时启动；可加 --grace 45m、--force、--no-awake。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" start --provider claude --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}" $ARGUMENTS`

把上面 Cache Warmer 的输出原样放进 ```text 代码块展示给用户，不要改动任何数字。
