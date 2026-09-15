export function nowIso(): string {
  return new Date().toISOString();
}

/** 지정 타임존 기준 오늘 날짜 YYYY-MM-DD */
export function todayIn(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

export function daysAgoDate(days: number, tz: string): string {
  const d = new Date(Date.now() - days * 86400_000);
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** 타임존의 현재 UTC 오프셋 문자열 (예: +09:00). 실패 시 Z */
export function tzOffset(tz: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC", timeZoneName: "longOffset" }).formatToParts(new Date());
    const off = parts.find((p) => p.type === "timeZoneName")?.value || "GMT";
    const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(off);
    if (!m) return "Z";
    const h = String(Math.abs(parseInt(m[1], 10))).padStart(2, "0");
    return `${m[1].startsWith("-") ? "-" : "+"}${h}:${m[2] || "00"}`;
  } catch { return "Z"; }
}

/** 날짜(YYYY-MM-DD)의 그날 자정(23:59:59, tz 기준)을 ISO(UTC) 로 */
export function endOfDayIso(date: string, tz: string | undefined): string {
  const t = new Date(`${date}T23:59:59${tzOffset(tz)}`).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : `${date}T23:59:59.000Z`;
}
