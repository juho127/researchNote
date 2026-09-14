// 주차 계산 — 서버 src/lib/week.ts 와 같은 규칙.
// 1주차 = [week_start, 그 이후 첫 마감 요일], 이후 7일 단위로 마감 요일에 끝난다. 날짜는 YYYY-MM-DD 문자열.
const DAY = 86400000;
export const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const dayNum = (d) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY);
const dateStr = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const dow = (d) => new Date(d + "T00:00:00Z").getUTCDay();

export function weekCfgOf(row) {
  if (!row || !row.week_start) return null;
  return { week_start: row.week_start, week_count: Math.max(1, Number(row.week_count) || 15), week_due_dow: Math.min(6, Math.max(0, Number(row.week_due_dow) || 0)) };
}
export function firstDue(cfg) {
  const s = dayNum(cfg.week_start);
  return dateStr(s + ((cfg.week_due_dow - dow(cfg.week_start) + 7) % 7));
}
export function weekOf(cfg, date) {
  const d = dayNum(date), s = dayNum(cfg.week_start);
  if (d < s) return 0;
  const f = dayNum(firstDue(cfg));
  return d <= f ? 1 : 1 + Math.ceil((d - f) / 7);
}
export function weekRange(cfg, n) {
  const f = dayNum(firstDue(cfg));
  if (n <= 1) return { n: 1, start: cfg.week_start, end: dateStr(f) };
  return { n, start: dateStr(f + 7 * (n - 2) + 1), end: dateStr(f + 7 * (n - 1)) };
}
/** "9/19(토)" */
export function shortDate(d) { return `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${DOW[dow(d)]})`; }
