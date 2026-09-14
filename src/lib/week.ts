/**
 * 주차 계산 — 카테고리의 1주차 시작일·마감 요일로 날짜를 N주차로 환산한다.
 *
 * 규칙: 1주차 = [week_start, week_start 이후(당일 포함) 첫 마감 요일], 이후 주차는 7일 단위로 마감 요일에 끝난다.
 * 예) week_start=2026-09-02(수), due_dow=6(토) → 1주차 09-02~09-05, 2주차 09-06~09-12, 3주차 09-13~09-19 …
 * 날짜는 모두 YYYY-MM-DD 문자열(타임존 무관)로 다룬다.
 */
export interface WeekCfg {
  week_start: string;
  week_count: number;
  week_due_dow: number; // 0=일 … 6=토
}

export interface WeekInfo {
  n: number;
  start: string; // YYYY-MM-DD
  end: string;   // YYYY-MM-DD (= 마감일, 그날 자정까지)
}

const DAY = 86400_000;
const DOW_LABEL = ["일", "월", "화", "수", "목", "금", "토"];

function dayNum(d: string): number {
  return Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY);
}
function dateStr(n: number): string {
  return new Date(n * DAY).toISOString().slice(0, 10);
}
function dow(d: string): number {
  return new Date(d + "T00:00:00Z").getUTCDay();
}

/** 카테고리 행 → WeekCfg (week_start 가 없으면 null = 주차 기능 꺼짐) */
export function weekCfgOf(row: { week_start?: string | null; week_count?: number | null; week_due_dow?: number | null } | null | undefined): WeekCfg | null {
  if (!row || !row.week_start || !/^\d{4}-\d{2}-\d{2}$/.test(row.week_start)) return null;
  return { week_start: row.week_start, week_count: Math.max(1, Number(row.week_count) || 15), week_due_dow: Math.min(6, Math.max(0, Number(row.week_due_dow) || 0)) };
}

/** 1주차 마감일 (week_start 이후 첫 마감 요일, 당일 포함) */
export function firstDue(cfg: WeekCfg): string {
  const s = dayNum(cfg.week_start);
  const diff = (cfg.week_due_dow - dow(cfg.week_start) + 7) % 7;
  return dateStr(s + diff);
}

/** 날짜의 주차. 시작일 이전은 0. 총 주차를 넘어도 계산값 그대로 반환 */
export function weekOf(cfg: WeekCfg, date: string): number {
  const d = dayNum(date);
  const s = dayNum(cfg.week_start);
  if (d < s) return 0;
  const f = dayNum(firstDue(cfg));
  if (d <= f) return 1;
  return 1 + Math.ceil((d - f) / 7);
}

export function weekRange(cfg: WeekCfg, n: number): WeekInfo {
  const f = dayNum(firstDue(cfg));
  if (n <= 1) return { n: 1, start: cfg.week_start, end: dateStr(f) };
  return { n, start: dateStr(f + 7 * (n - 2) + 1), end: dateStr(f + 7 * (n - 1)) };
}

export function allWeeks(cfg: WeekCfg): WeekInfo[] {
  return Array.from({ length: cfg.week_count }, (_, i) => weekRange(cfg, i + 1));
}

export function dowLabel(d: number): string {
  return DOW_LABEL[((d % 7) + 7) % 7];
}

/** "9/19(토)" 형태 */
export function shortDate(d: string): string {
  return `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${dowLabel(dow(d))})`;
}
