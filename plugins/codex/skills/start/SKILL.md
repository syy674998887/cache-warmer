---
name: start
description: 分析当前 Codex 会话的 prompt cache，或在离开期间自动保温。用法：$cache-warmer:start 只做分析；$cache-warmer:start <离开时长> 开始保温，离开时长如 2h、90m。
---

用户给了离开时长时，先确认你有 sleep 工具；没有就告诉用户当前模型不支持自动保温，不要运行下面的命令，也不要用 shell 的 sleep 或其他方式代替。

运行下面的命令。`<plugin-root>` 是本插件的根目录，也就是这个 SKILL.md 所在目录往上两级；`[离开时长]` 换成用户给的时长，没给就省略；用户给的 `--grace`、`--force`、`--no-awake` 原样加在最后。

```bash
node "<plugin-root>/dist/cli.js" start --provider codex --thread "$CODEX_THREAD_ID" [离开时长]
```

把命令输出原样放进 ```text 代码块展示给用户。不要改动任何数字，也不要补充自己的分析。

输出最后一行是「保温计划：用 sleep 工具睡 N 次，每次 duration_ms=D」时，展示完就开始保温：调用 sleep 工具，duration_ms 设为 D；每次返回后不写任何文字，直接再调用一次，直到返回满 N 次，然后只回复「保温结束。」。保温期间不调用其他工具。某次 sleep 被用户的新消息打断时，立即停止保温，直接处理用户的消息。sleep 提前返回、但用户没有发新消息时，不算打断，继续调用，这一次不计入 N。
