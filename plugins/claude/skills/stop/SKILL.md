---
name: stop
description: 停止本会话正在进行的 prompt cache 保温，并给出这次保温的总结。
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" stop --session "${CLAUDE_SESSION_ID}" --data "${CLAUDE_PLUGIN_DATA}"`

把上面 Cache Warmer 的输出原样告诉用户。
