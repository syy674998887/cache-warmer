const UNIT_MINUTES: Record<string, number> = { d: 1440, h: 60, m: 1 };

/** Added to the declared away time, so returning a little late still finds the cache warm. */
export const DEFAULT_GRACE = "30m";

/** Parses durations such as `2h`, `90m`, `1h30m` or `1d` into whole minutes. */
export function parseDurationMinutes(text: string): number {
  const input = text.trim().toLowerCase();
  const pattern = /(\d+(?:\.\d+)?)\s*([dhm])/g;
  let total = 0;
  let consumed = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index !== consumed) break;
    total += Number(match[1]) * UNIT_MINUTES[match[2]!]!;
    consumed = match.index + match[0].length;
  }
  if (consumed === 0 || consumed !== input.length) {
    throw new Error(`无法解析时长「${text}」，请使用 2h、90m、1h30m 这样的写法`);
  }
  const minutes = Math.round(total);
  if (minutes <= 0) throw new Error(`时长必须大于 0：「${text}」`);
  return minutes;
}

export function formatMinutes(minutes: number): string {
  // Short spans such as the 4m15s refresh interval of a 5-minute TTL keep their seconds.
  if (minutes < 10 && !Number.isInteger(minutes)) {
    const seconds = Math.round(minutes * 60);
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m === 0) return `${s} 秒`;
    return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
  }
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分`;
}
