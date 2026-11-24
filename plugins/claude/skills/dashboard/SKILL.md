---
name: dashboard
description: 查看保温记录：每次保温花了多少、省了多少，以及累计合计。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" dashboard --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}"`

把上面 Cache Warmer 的输出原样放进 ```text 代码块展示给用户。不要改动任何数字，也不要补充自己的分析。
