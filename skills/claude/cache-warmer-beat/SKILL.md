---
name: cache-warmer-beat
description: Cache Warmer 的定时刷新，只由 /cache-warmer start --via skill 设下的定时任务触发。不要自己调用。
---

!`node "${CLAUDE_SKILL_DIR}/../cache-warmer/dist/cli.js" beat --session "${CLAUDE_SESSION_ID}"`

这是 Cache Warmer 的定时刷新：暂停手上的事，只照上面 Cache Warmer 的输出去做（调用 CronCreate 时参数一字不改），然后只按它说的回复一行。
如果上面没有 Cache Warmer 的输出，不要设定时任务，只回复「Cache Warmer：beat 命令没有执行，保温中断」。
