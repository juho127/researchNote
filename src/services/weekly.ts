/**
 * 주차별 보고 현황 — 카테고리의 프로젝트 × 주차 격자.
 * 카테고리에 week_start(1주차 시작일)가 있어야 동작한다. 셀 값: 주간 보고(weekly=1) 건수, 일반 기록 건수.
 */
import type { AuthContext, Env } from "../env";
import { requireCategoryMember } from "../lib/auth";
import { notFound } from "../lib/http";
import { todayIn } from "../lib/time";
import { allWeeks, weekCfgOf, weekOf, type WeekCfg, type WeekInfo } from "../lib/week";

export interface WeekCell {
  n: number;
  weekly: number;
  entries: number;
  entry_id: string | null;
  entry_title: string | null;
  entry_date: string | null;
}
export interface WeeklyProject {
  id: string;
  title: string;
  owner_id: string;
  owner_name: string;
  stage: string;
  status: string;
  created_at: string;
  cells: WeekCell[];
  submitted: number;
  missed: number;
}
export interface WeeklyStatus {
  enabled: boolean;
  cfg: WeekCfg | null;
  today: string;
  current_week: number;
  weeks: (WeekInfo & { past: boolean; current: boolean })[];
  projects: WeeklyProject[];
  current: { n: number; start: string; due: string; submitted: number; total: number; missing: { id: string; title: string }[] } | null;
}

const emptyCell = (n: number): WeekCell => ({ n, weekly: 0, entries: 0, entry_id: null, entry_title: null, entry_date: null });

export async function weeklyStatus(env: Env, ctx: AuthContext, categoryId: string): Promise<WeeklyStatus> {
  requireCategoryMember(ctx, categoryId);
  const cat = await env.DB
    .prepare(`SELECT id, week_start, week_count, week_due_dow FROM categories WHERE id = ? AND archived_at IS NULL`)
    .bind(categoryId)
    .first<{ id: string; week_start: string | null; week_count: number; week_due_dow: number }>();
  if (!cat) notFound("카테고리를 찾을 수 없습니다");
  const cfg = weekCfgOf(cat);
  const today = todayIn(env.APP_TZ);
  if (!cfg) return { enabled: false, cfg: null, today, current_week: 0, weeks: [], projects: [], current: null };

  const cur = weekOf(cfg, today);
  const weeks = allWeeks(cfg).map((w) => ({ ...w, past: w.end < today, current: w.n === cur }));
  const [prs, es] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.title, p.owner_id, u.name AS owner_name, p.stage, p.status, p.created_at
       FROM projects p JOIN users u ON u.id = p.owner_id
       WHERE p.category_id = ? AND p.status IN ('active','paused') ORDER BY p.title`
    ).bind(categoryId),
    env.DB.prepare(
      `SELECT e.id, e.project_id, e.date, e.title, e.weekly FROM entries e JOIN projects p ON p.id = e.project_id
       WHERE p.category_id = ? AND e.date >= ? ORDER BY e.date, e.created_at`
    ).bind(categoryId, cfg.week_start),
  ]);

  const byProject = new Map<string, Map<number, WeekCell>>();
  for (const e of (es.results ?? []) as { id: string; project_id: string; date: string; title: string; weekly: number }[]) {
    const n = weekOf(cfg, e.date);
    if (n < 1 || n > cfg.week_count) continue;
    let m = byProject.get(e.project_id);
    if (!m) byProject.set(e.project_id, (m = new Map()));
    let c = m.get(n);
    if (!c) m.set(n, (c = emptyCell(n)));
    c.entries += 1;
    if (e.weekly) {
      c.weekly += 1;
      c.entry_id = e.id; // 최신 주간 보고를 대표로
      c.entry_title = e.title;
      c.entry_date = e.date;
    }
  }

  const projects: WeeklyProject[] = ((prs.results ?? []) as Omit<WeeklyProject, "cells" | "submitted" | "missed">[]).map((p) => {
    const m = byProject.get(p.id) ?? new Map<number, WeekCell>();
    const cells = weeks.map((w) => m.get(w.n) ?? emptyCell(w.n));
    const createdDate = p.created_at.slice(0, 10);
    const submitted = cells.filter((c) => c.weekly > 0).length;
    // 누락: 지난 주차 중 주간 보고가 없고, 프로젝트 생성 이후인 주차만
    const missed = cells.filter((c, i) => weeks[i].past && c.weekly === 0 && weeks[i].end >= createdDate).length;
    return { ...p, cells, submitted, missed };
  });

  const cw = weeks.find((w) => w.current);
  const current = cw
    ? {
        n: cw.n,
        start: cw.start,
        due: cw.end,
        submitted: projects.filter((p) => p.cells[cw.n - 1].weekly > 0).length,
        total: projects.length,
        missing: projects.filter((p) => p.cells[cw.n - 1].weekly === 0).map((p) => ({ id: p.id, title: p.title })),
      }
    : null;
  return { enabled: true, cfg, today, current_week: cur, weeks, projects, current };
}
