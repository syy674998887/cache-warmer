<div align="center">

# Cache Warmer

**离开期间保住 prompt cache，仅在比冷启动便宜时执行。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · 简体中文

</div>

Cache Warmer 是 Claude Code 和 Codex 的插件。你声明离开多久，它比较续住本会话 prompt cache 所需刷新的花费与冷启动的花费，只在保温更便宜时执行。

```text
Cache Warmer · Claude Opus 5.5（claude-opus-5-5）· TTL 1h · 上下文 150k
最近一次请求 14:08 · cache 15:08 到期（还剩 48 分钟）

每次刷新  0.05× × 150k + 回合开销约 1050 = 8550 token 当量 ≈ $0.03
冷启动    2× × 150k = 30 万 token 当量 ≈ $1.20
持平点    最多刷新 34 次，每 50 分钟一次：从现在起离开与宽限合计 29 小时 20 分以内都划算
```

适用于约 10–20 万 token、离开后还要继续的会话，以及 Codex 会话。20 万 token 以上，Claude Code 的 idle compaction 通常更省。

## 安装

需要 Node.js 22.15 或更新版本（23 要 23.8 以上）。在 macOS 上测试，版本为 Claude Code 2.1.331 和 Codex 0.171.0。

### Claude Code

```text
/plugin marketplace add syy674998887/cache-warmer
/plugin install cache-warmer@cache-warmer
```

安装后新开会话，或 `/exit` 再 `claude --resume`。插件的 monitor 只在会话开始时启动。

### Codex

```text
codex plugin marketplace add syy674998887/cache-warmer
codex plugin add cache-warmer@cache-warmer
```

需要 GPT-6 系列模型，它提供 `sleep` 工具。Codex 启动时会提示审查插件的 Stop hook，选择信任；每次更新后要重新信任。这个 hook 只负责回来时的总结，其余功能不依赖它。

## 用法

| Claude Code | Codex | 作用 |
|---|---|---|
| `/cache-warmer:start` | `$cache-warmer:start` | 显示 cache 到期时间、刷新与冷启动的花费、持平点 |
| `/cache-warmer:start 2h` | `$cache-warmer:start 2h` | 划算时按声明的时长保温 |
| `/cache-warmer:stop` | 任意消息或 Esc | 提前结束 |
| `/cache-warmer:dashboard` | `$cache-warmer:dashboard` | 列出历次保温的花费、结果和累计节省 |

时长写作 `2h`、`90m` 或 `1h30m`。`start <时长>` 的选项：

| 选项 | 作用 |
|---|---|
| `--grace 45m` | 宽限时间，回来晚了仍有 cache。默认 30 分钟。 |
| `--force` | 超过持平点也保温。默认拒绝启动并说明原因。 |
| `--no-awake` | 保温期间不阻止 macOS 空闲休眠。 |

回来后发一条消息即结束保温，并显示一行总结：花费与节省。

## 工作原理

| | Claude Code | Codex |
|---|---|---|
| 刷新 | 插件的 monitor 发一条「暂停并等待」，Claude 回一句，该请求重读 cache | 模型循环调用 `sleep`，每次 25 分钟，醒来的请求重读 cache |
| 时机 | 1h 档在过期前 10 分钟，早于空闲约 54 分钟的 idle compaction；5m 档在过期前 45 秒 | 30 分钟保留时间到期前 5 分钟 |
| 校验 | 每次刷新后核对，cache 读取不足 90% 即停止 | 不逐次校验，未命中的次数记入总结和 dashboard |
| 不产生模型回合的命令 | 不带时长的 `start`、`stop`、`dashboard` | 无 |

价格取自官方价格页的带日期快照（[`src/pricing.json`](src/pricing.json)），每天最多从本仓库更新一次。表中没有的模型按同家族默认倍率估算，输出中会注明。

## 限制

- 电脑休眠时不运行。插件能阻止空闲休眠，不能阻止合盖休眠。
- Claude Code 的 monitor 是实验性功能，只在交互式 CLI 中运行。`/clear` 和 `/resume` 不会重启 monitor：换到别的会话后要保温，先 `/exit` 再 `claude --resume`。进行中的保温在切换会话时结束。
- 开启 `disableAllHooks` 时 monitor 不启动：Claude Code 无法保温，其余命令各多一个模型回合。
- Claude Code 每次刷新会在对话中留下一小段记录。Codex 在保温期间一直显示正在工作。
- Claude Code 中由 hook 回答的命令，输出上方有一行 `UserPromptExpansion operation blocked by hook:`。这是 Claude Code 加的标题，不是错误。
- 节省按 API 价折算。订阅用户省下的是额度和等待时间，不是钱。
- 插件读取客户端 transcript 和 rollout 的内部格式，这些格式可能随版本变化。
- Codex 不保证 cache 的保留时间：睡 25 分钟后醒来，偶尔只命中一部分。

## 隐私

- 只读取 transcript 和 rollout 中的 token 用量、时间戳和记录元数据，不读消息内容，不读凭据文件。
- 所有模型请求由官方客户端发出，插件不调用模型 API。
- 唯一的网络请求是下载本仓库的价格表。
- 保温记录只保存在本机。

## 开发

```text
npm install
npm test          # 编译后运行测试
npm run package   # 把运行时复制进 plugins/*/dist，与 src/ 的改动一起提交
```

本地试用 Claude Code 版：`claude --plugin-dir plugins/claude`。

## 许可证

[MIT](LICENSE)
