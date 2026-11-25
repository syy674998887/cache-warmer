# Cache Warmer：Claude Code 单独 skill 版（试验中）

不装插件、只靠两个 skill 给 Claude Code 会话保温。插件版靠后台 monitor 定时叫醒 Claude；skill 版没有后台进程，改成让 Claude 自己设一次性定时任务（CronCreate），每次被叫醒时刷新 cache，并设好下一次。

- `cache-warmer/`：用户手动调用的主 skill。`/cache-warmer` 分析，`/cache-warmer start 2h` 开始保温，`/cache-warmer stop` 停止，`/cache-warmer dashboard` 看记录。调用后会给本会话注册三个 hook（UserPromptSubmit、Stop、SessionEnd）。
- `cache-warmer-beat/`：只给 `--via skill` 这条路用的定时刷新 skill。
- 数据放在 `~/.claude/cache-warmer/`（Windows 是 `%USERPROFILE%\.claude\cache-warmer\`）。

两条路，用 `--via` 切换（默认 hook）：

| | 定时任务的 prompt | 谁跑 `cli.js beat` |
|---|---|---|
| `--via hook` | 一段纯文字（含 `cache-warmer-beat`） | 主 skill 注册的 UserPromptSubmit hook，把结果作为上下文交给 Claude |
| `--via skill` | `/cache-warmer-beat` | beat skill 里的 `!` 命令 |

每次刷新是两次请求（定时消息一次，设好下一个任务后的回复一次），所以比插件版贵，持平点也更低，分析结果里会写出来。

## 测试（Windows PowerShell）

前提：装了 Git Bash（Claude Code 在 Windows 上用它跑 hook 和 `!` 命令），`node` 在 PATH 里。

### 1. 装上

```powershell
git clone -b claude/project-thread-1ehob7 https://github.com/syy674998887/cache-warmer "$env:TEMP\cw-branch"
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force "$env:TEMP\cw-branch\skills\claude\cache-warmer", "$env:TEMP\cw-branch\skills\claude\cache-warmer-beat" "$env:USERPROFILE\.claude\skills\"
```

### 2. hook 这条路（约 5 分钟）

1. 开一个新的 `claude` 会话，先随便发一句话，让会话有一次请求。
2. 输入 `/cache-warmer start 2h --first-in 2m`（`--first-in` 只用于测试：第一次刷新放在 2 分钟后，不用等 50 分钟）。
   - 预期：显示保温信息；Claude 调用 CronCreate，然后只回一行「Cache Warmer：保温中，下次刷新 HH:MM」。
3. 什么都别输入，等 2～3 分钟。
   - 预期：出现一条「暂停并等待（cache-warmer-beat）……」的定时消息；Claude 再调一次 CronCreate，回复的下次刷新时间大约在 50 分钟后。
   - 如果 Claude 回「Cache Warmer：没收到指示，保温中断」：hook 没跑起来。
4. 看 hook 日志（只记事件、时间和 source，不记消息内容）：

   ```powershell
   Get-Content "$env:USERPROFILE\.claude\cache-warmer\hook-events.log"
   ```

   预期有一行 `"kind":"beat"`，记下它的 `"source"` 值。
5. 随便输入一句话。
   - 预期：Claude 先用 CronList / CronDelete 删掉待触发的任务，再正常回答；回合结束后显示「Cache Warmer 保温总结……」。

### 3. skill 这条路

同上，第 2 步改成 `/cache-warmer start 2h --first-in 2m --via skill`。

- 预期：2～3 分钟后出现 `/cache-warmer-beat`，Claude 设好下一次并回一行「保温中」。
- 如果弹出权限确认（Skill 或 Bash），记下提示内容：说明这条路离开时会卡住，需要在设置里加允许规则。
- 如果 Claude 回「Cache Warmer：beat 命令没有执行，保温中断」：`!` 命令没执行。

### 4. 真实离开（可选）

`/cache-warmer start 2h` 后离开一个多小时，电脑不能睡眠。回来输入一句话，看总结，再用 `/cache-warmer dashboard` 看记录。

## 测完清理

1. 在测试会话里输入 `/cache-warmer stop`，它会让 Claude 删掉待触发的定时任务。也可以直接让 Claude「用 CronList 列出定时任务，把 prompt 含 cache-warmer-beat 的都删掉」，再 CronList 确认已经没有。
2. 删掉 skill、数据目录和测试用的克隆：

   ```powershell
   Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
     "$env:USERPROFILE\.claude\skills\cache-warmer", `
     "$env:USERPROFILE\.claude\skills\cache-warmer-beat", `
     "$env:USERPROFILE\.claude\cache-warmer", `
     "$env:TEMP\cw-branch"
   ```

3. 如果之前做过 `cw-fire-test` / `cw-hook-test` 那两个小测试，也一起删掉：

   ```powershell
   Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `
     "$env:USERPROFILE\.claude\skills\cw-fire-test", `
     "$env:USERPROFILE\.claude\skills\cw-hook-test", `
     "$env:USERPROFILE\cw-fire-test.log", `
     "$env:USERPROFILE\cw-hook-test.log"
   ```

## 还没验证的地方

- skill frontmatter 里 hook 命令能不能用 `${CLAUDE_SKILL_DIR}`。hook 命令写了后备路径 `~/.claude/skills/cache-warmer/`，所以 skill 必须装在这里。
- 定时任务触发时 UserPromptSubmit 的 `source` 值。代码按「prompt 含 `cache-warmer-beat` 且 source 不是 user」认定刷新，source 缺省也能用。
- `--via skill` 时，定时触发的 `/cache-warmer-beat` 会不会要求权限确认。
- Agensi 等平台能否接受 `hooks`、`allowed-tools` 这些 Claude Code 专有字段。
