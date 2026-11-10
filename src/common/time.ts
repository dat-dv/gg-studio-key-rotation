/** Free-tier RPD của Gemini API reset lúc 00:00 giờ Pacific (America/Los_Angeles). */
export const QUOTA_TZ = 'America/Los_Angeles';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: QUOTA_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function parts(ms: number) {
  const m: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) if (p.type !== 'literal') m[p.type] = Number(p.value);
  return m;
}

/** offset (ms) của timezone tại thời điểm ms: localWallClock - utc */
function offsetAt(ms: number) {
  const p = parts(ms);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Mốc UTC (ms) của 00:00 Pacific ngày chứa `ms`. */
export function quotaDayStart(ms = Date.now()) {
  const p = parts(ms);
  const midnightWall = Date.UTC(p.year, p.month - 1, p.day);
  let guess = midnightWall - offsetAt(ms);
  guess = midnightWall - offsetAt(guess); // chỉnh lại nếu vừa qua DST
  return guess;
}

/** Mốc UTC (ms) của 00:00 Pacific ngày kế tiếp. */
export function quotaDayEnd(ms = Date.now()) {
  return quotaDayStart(quotaDayStart(ms) + 26 * 3600_000);
}
