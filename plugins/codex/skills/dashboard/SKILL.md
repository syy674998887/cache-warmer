---
name: dashboard
description: 查看 Codex 的保温记录：每次保温花了多少、省了多少，以及累计合计。用法：$cache-warmer:dashboard。
---

运行下面的命令。`<plugin-root>` 是本插件的根目录，也就是这个 SKILL.md 所在目录往上两级。

```bash
node "<plugin-root>/dist/cli.js" dashboard --provider codex --thread "$CODEX_THREAD_ID"
```

把命令输出原样放进 ```text 代码块展示给用户。不要改动任何数字，也不要补充自己的分析。
