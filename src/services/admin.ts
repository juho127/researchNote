import type { AuthContext, Env, User } from "../env";
import { TRACKS, isTrack, DEFAULT_TRACK } from "../env";
import { bad, oneOf, str, bool, clampInt, isDateStr } from "../lib/http";
import { newId, newToken, tokenHint, sha256Hex, slugify } from "../lib/id";
import { nowIso, daysAgoIso, daysAgoDate } from "../lib/time";
import { logActivity } from "../lib/db";
import { normPin, pinHash, revokeViewerSessions } from "./publicview";

// ---------- 카테고리 ----------

export interface CategoryRow {
  id: string;
  name: string;
  description: string;
  color: string;
  join_policy: string;
  track: string;
  /** 공개 열람 허용 (핀이 설정되어야 실제로 열람 가능) */
  is_public: number;
  /** 핀 설정 여부 (핀 자체·해시는 절대 내려보내지 않음) */
  pin_set: boolean;
  pin_updated_at: string | null;
  /** 주차 설정: 1주차 시작일(없으면 주차 기능 꺼짐) · 총 주차 · 마감 요일(0=일…6=토) */
  week_start: string | null;
  week_count: number;
  week_due_dow: number;
  /** 보고서 마감 덮어쓰기 JSON {마일스톤id: 'YYYY-MM-DD'} (없으면 주차 기본값) */
  milestone_due: string | null;
  created_at: string;
  archived_at: string | null;
  member_count?: number;
  project_count?: number;
  lead_names?: string;
  active_viewers?: number;
}

/** DB 행 → API 행: pin_hash 제거, pin_set 추가 */
export function shapeCategory<T extends { pin_hash?: string | null; is_public?: number }>(row: T): Omit<T, "pin_hash"> & { pin_set: boolean; is_public: number } {
  const { pin_hash, ...rest } = row;
  return { ...rest, is_public: row.is_public ? 1 : 0, pin_set: !!pin_hash };
}

export async function listCategories(env: Env, includeArchived = false): Promise<CategoryRow[]> {
  const rs = await env.DB
    .prepare(
      `SELECT c.*,
         (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND u.disabled_at IS NULL) AS member_count,
         (SELECT COUNT(*) FROM projects p WHERE p.category_id = c.id AND p.status IN ('active','paused')) AS project_count,
         (SELECT GROUP_CONCAT(u.name, ', ') FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.category_id = c.id AND m.role = 'lead') AS lead_names,
         (SELECT COUNT(*) FROM viewer_sessions v WHERE v.category_id = c.id AND v.expires_at > ?) AS active_viewers
       FROM categories c ${includeArchived ? "" : "WHERE c.archived_at IS NULL"} ORDER BY c.archived_at IS NOT NULL, c.name`
    )
    .bind(nowIso())
    .all<CategoryRow & { pin_hash: string | null }>();
  return (rs.results ?? []).map((r) => shapeCategory(r) as CategoryRow);
}

async function loadCategory(env: Env, id: string): Promise<CategoryRow> {
  const r = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(id).first<CategoryRow & { pin_hash: string | null }>();
  return shapeCategory(r!) as CategoryRow;
}

const JOIN_POLICIES = ["open", "approval", "closed"] as const;

type WeekInput = { week_start?: unknown; week_count?: unknown; week_due_dow?: unknown; milestone_due?: unknown };

/** 주차 설정 입력 파싱: week_start(YYYY-MM-DD, 빈 문자열 = 해제), week_count(1~30), week_due_dow(0~6) */
function parseWeekInput(input: WeekInput): { week_start?: string | null; week_count?: number; week_due_dow?: number; milestone_due?: string | null } {
  const out: { week_start?: string | null; week_count?: number; week_due_dow?: number; milestone_due?: string | null } = {};
  if (input.week_start !== undefined && input.week_start !== null) {
    const v = str(input.week_start, 10);
    if (v && !isDateStr(v)) bad("week_start 는 YYYY-MM-DD 형식");
    out.week_start = v || null;
  }
  if (input.week_count !== undefined && input.week_count !== null && input.week_count !== "") out.week_count = clampInt(input.week_count, 15, 1, 30);
  if (input.week_due_dow !== undefined && input.week_due_dow !== null && input.week_due_dow !== "") out.week_due_dow = clampInt(input.week_due_dow, 6, 0, 6);
  if (input.milestone_due !== undefined) {
    if (input.milestone_due === null || input.milestone_due === "") out.milestone_due = null;
    else {
      let o: unknown = input.milestone_due;
      if (typeof o === "string") { try { o = JSON.parse(o); } catch { bad("milestone_due 는 {마일스톤id: 'YYYY-MM-DD'} 객체여야 합니다"); } }
      if (!o || typeof o !== "object" || Array.isArray(o)) bad("milestone_due 는 {마일스톤id: 'YYYY-MM-DD'} 객체여야 합니다");
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (v === null || v === undefined || v === "") continue;
        const d = str(v, 10);
        if (!isDateStr(d)) bad(`${k} 마감은 YYYY-MM-DD 형식이어야 합니다`);
        m[k] = d;
      }
      out.milestone_due = Object.keys(m).length ? JSON.stringify(m) : null;
    }
  }
  return out;
}

export async function createCategory(env: Env, ctx: AuthContext, input: { name?: unknown; description?: unknown; color?: unknown; id?: unknown; join_policy?: unknown; track?: unknown; is_public?: unknown; pin?: unknown } & WeekInput): Promise<CategoryRow> {
  const name = str(input.name, 100);
  if (!name) bad("name 이 필요합니다");
  const dup = await env.DB.prepare(`SELECT id FROM categories WHERE name = ?`).bind(name).first();
  if (dup) bad("같은 이름의 카테고리가 이미 있습니다");
  let id = input.id ? slugify(str(input.id, 60)) : slugify(name);
  const clash = await env.DB.prepare(`SELECT id FROM categories WHERE id = ?`).bind(id).first();
  if (clash) id = `${id}-${newId("c").slice(2, 6)}`;
  const at = nowIso();
  const policy = input.join_policy === undefined || input.join_policy === null ? "approval" : oneOf(input.join_policy, JOIN_POLICIES, "join_policy");
  let track = DEFAULT_TRACK;
  if (input.track !== undefined && input.track !== null && input.track !== "") {
    if (!isTrack(input.track)) bad(`track 값은 ${Object.keys(TRACKS).join(" | ")} 중 하나여야 합니다`);
    track = input.track;
  }
  const isPublic = bool(input.is_public) ? 1 : 0;
  const pin = normPin(input.pin);
  const wk = parseWeekInput(input);
  await env.DB
    .prepare(`INSERT INTO categories (id, name, description, color, join_policy, track, is_public, pin_hash, pin_updated_at, week_start, week_count, week_due_dow, milestone_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, name, str(input.description, 1000), str(input.color, 20), policy, track, isPublic, pin ? await pinHash(id, pin) : null, pin ? at : null, wk.week_start ?? null, wk.week_count ?? 15, wk.week_due_dow ?? 6, wk.milestone_due ?? null, at)
    .run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: id, action: "category.create", target_id: id, summary: name, source: ctx.source });
  return loadCategory(env, id);
}

export async function updateCategory(env: Env, ctx: AuthContext, id: string, input: { name?: unknown; description?: unknown; color?: unknown; archived?: unknown; join_policy?: unknown; track?: unknown; is_public?: unknown; pin?: unknown } & WeekInput): Promise<CategoryRow> {
  const c = await env.DB.prepare(`SELECT * FROM categories WHERE id = ?`).bind(id).first<CategoryRow & { pin_hash: string | null }>();
  if (!c) bad("카테고리를 찾을 수 없습니다");
  const sets: string[] = [];
  const params: unknown[] = [];
  const notes: string[] = [];
  let revokeViewers = false;
  // 공개 열람 · 핀
  if (input.is_public !== undefined && input.is_public !== null) {
    const pub = bool(input.is_public) ? 1 : 0;
    if (pub !== (c.is_public ? 1 : 0)) {
      sets.push("is_public = ?");
      params.push(pub);
      notes.push(pub ? "공개 열람 켬" : "공개 열람 끔");
      if (!pub) revokeViewers = true;
    }
  }
  if (input.pin !== undefined && input.pin !== null) {
    const pin = normPin(input.pin);
    const newHash = pin ? await pinHash(id, pin) : null;
    if (newHash !== c.pin_hash) {
      sets.push("pin_hash = ?", "pin_updated_at = ?");
      params.push(newHash, pin ? nowIso() : null);
      notes.push(pin ? "핀 변경" : "핀 해제");
      revokeViewers = true;
    }
  }
  // 주차 설정
  const wk = parseWeekInput(input);
  if (wk.week_start !== undefined && wk.week_start !== (c.week_start ?? null)) {
    sets.push("week_start = ?");
    params.push(wk.week_start);
    notes.push(wk.week_start ? `1주차 ${wk.week_start}` : "주차 해제");
  }
  if (wk.week_count !== undefined && wk.week_count !== c.week_count) {
    sets.push("week_count = ?");
    params.push(wk.week_count);
  }
  if (wk.week_due_dow !== undefined && wk.week_due_dow !== c.week_due_dow) {
    sets.push("week_due_dow = ?");
    params.push(wk.week_due_dow);
  }
  if (wk.milestone_due !== undefined && wk.milestone_due !== (c.milestone_due ?? null)) {
    sets.push("milestone_due = ?");
    params.push(wk.milestone_due);
    notes.push(wk.milestone_due ? "보고서 마감 변경" : "보고서 마감 기본값");
  }
  if (input.name !== undefined) {
    const n = str(input.name, 100);
    if (!n) bad("name 은 비울 수 없습니다");
    const dup = await env.DB.prepare(`SELECT id FROM categories WHERE name = ? AND id != ?`).bind(n, id).first();
    if (dup) bad("같은 이름의 카테고리가 이미 있습니다");
    sets.push("name = ?");
    params.push(n);
  }
  if (input.description !== undefined) {
    sets.push("description = ?");
    params.push(str(input.description, 1000));
  }
  if (input.color !== undefined) {
    sets.push("color = ?");
    params.push(str(input.color, 20));
  }
  if (input.join_policy !== undefined && input.join_policy !== null) {
    sets.push("join_policy = ?");
    params.push(oneOf(input.join_policy, JOIN_POLICIES, "join_policy"));
  }
  if (input.track !== undefined && input.track !== null && input.track !== "" && input.track !== c.track) {
    if (!isTrack(input.track)) bad(`track 값은 ${Object.keys(TRACKS).join(" | ")} 중 하나여야 합니다`);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM projects WHERE category_id = ?`).bind(id).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) bad("프로젝트가 있는 카테고리의 트랙은 바꿀 수 없습니다 (새 카테고리를 만드세요)");
    sets.push("track = ?");
    params.push(input.track);
  }
  if (input.archived !== undefined && input.archived !== null) {
    sets.push("archived_at = ?");
    params.push(bool(input.archived) ? nowIso() : null);
    if (bool(input.archived)) revokeViewers = true;
  }
  if (!sets.length) bad("변경할 필드가 없습니다");
  params.push(id);
  await env.DB.prepare(`UPDATE categories SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  if (revokeViewers) {
    const n = await revokeViewerSessions(env, id);
    if (n) notes.push(`열람 세션 ${n}건 만료`);
  }
  await logActivity(env, { actor_id: ctx.user.id, category_id: id, action: "category.update", target_id: id, summary: `${str(input.name, 100) || c.name}${notes.length ? ` (${notes.join(", ")})` : ""}`, source: ctx.source });
  return loadCategory(env, id);
}

/** 카테고리 관련 관리자 조치를 활동 로그에만 남긴다 */
export async function updateCategoryNote(env: Env, ctx: AuthContext, id: string, note: string): Promise<void> {
  const c = await env.DB.prepare(`SELECT name FROM categories WHERE id = ?`).bind(id).first<{ name: string }>();
  if (!c) bad("카테고리를 찾을 수 없습니다");
  await logActivity(env, { actor_id: ctx.user.id, category_id: id, action: "category.update", target_id: id, summary: `${c.name} (${note})`, source: ctx.source });
}

// ---------- 사용자 ----------

export interface UserRow extends User {
  memberships?: { category_id: string; category_name: string; role: string }[];
  token_count?: number;
  active_tokens?: number;
  project_count?: number;
  entry_count?: number;
  last_entry_at?: string | null;
}

export async function listUsers(env: Env, includeDisabled = true): Promise<UserRow[]> {
  const rs = await env.DB
    .prepare(
      `SELECT u.*,
         (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id) AS token_count,
         (SELECT COUNT(*) FROM tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS active_tokens,
         (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status IN ('active','paused')) AS project_count,
         (SELECT COUNT(*) FROM entries e WHERE e.author_id = u.id) AS entry_count,
         (SELECT MAX(e.created_at) FROM entries e WHERE e.author_id = u.id) AS last_entry_at
       FROM users u ${includeDisabled ? "" : "WHERE u.disabled_at IS NULL"} ORDER BY u.disabled_at IS NOT NULL, u.role = 'admin' DESC, u.name`
    )
    .all<UserRow>();
  const users = rs.results ?? [];
  const ms = await env.DB
    .prepare(`SELECT m.user_id, m.category_id, c.name AS category_name, m.role FROM memberships m JOIN categories c ON c.id = m.category_id ORDER BY c.name`)
    .all<{ user_id: string; category_id: string; category_name: string; role: string }>();
  const byUser = new Map<string, UserRow["memberships"]>();
  for (const m of ms.results ?? []) {
    if (!byUser.has(m.user_id)) byUser.set(m.user_id, []);
    byUser.get(m.user_id)!.push({ category_id: m.category_id, category_name: m.category_name, role: m.role });
  }
  for (const u of users) u.memberships = byUser.get(u.id) ?? [];
  return users;
}

export interface UserInput {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  note?: unknown;
  disabled?: unknown;
  id?: unknown;
  categories?: unknown; // [{category_id, role}] 또는 ["cat_id", ...]
  issue_token?: unknown; // true 면 생성과 동시에 토큰 발급
}

function normMemberships(v: unknown): { category_id: string; role: "lead" | "member" | "evaluator" }[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === "string") return { category_id: x, role: "member" as const };
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        return { category_id: str(o.category_id, 100), role: (o.role === "lead" ? "lead" : o.role === "evaluator" ? "evaluator" : "member") as "lead" | "member" | "evaluator" };
      }
      return null;
    })
    .filter((x): x is { category_id: string; role: "lead" | "member" | "evaluator" } => !!x && !!x.category_id);
}

/** 소속 목록의 category_id 가 모두 존재하는지 확인 (없으면 400) */
async function assertCategoriesExist(env: Env, mems: { category_id: string }[]): Promise<void> {
  const ids = [...new Set(mems.map((m) => m.category_id))];
  if (!ids.length) return;
  const rs = await env.DB.prepare(`SELECT id FROM categories WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string }>();
  const found = new Set((rs.results ?? []).map((r) => r.id));
  const missing = ids.filter((i) => !found.has(i));
  if (missing.length) bad(`존재하지 않는 카테고리: ${missing.join(", ")}`);
}

export async function createUser(env: Env, ctx: AuthContext, input: UserInput): Promise<{ user: UserRow; token?: string; token_hint?: string }> {
  const name = str(input.name, 100);
  if (!name) bad("name 이 필요합니다");
  const role = input.role === undefined ? "member" : oneOf(input.role, ["admin", "member"] as const, "role");
  let id = input.id ? slugify(str(input.id, 60)) : slugify(name);
  const clash = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
  if (clash) id = `${id}-${newId("u").slice(2, 6)}`;
  const mems = normMemberships(input.categories);
  await assertCategoriesExist(env, mems);
  const at = nowIso();
  // 사용자 + 소속을 한 배치로 (부분 생성 방지)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, name, email, role, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(id, name, str(input.email, 200), role, str(input.note, 500), at),
    ...mems.map((m) => env.DB.prepare(`INSERT OR REPLACE INTO memberships (user_id, category_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(id, m.category_id, m.role, at)),
  ]);
  await logActivity(env, { actor_id: ctx.user.id, action: "user.create", target_id: id, summary: name, source: ctx.source });
  let token: string | undefined;
  let token_hint: string | undefined;
  if (bool(input.issue_token)) {
    const t = await issueToken(env, ctx, { user_id: id, label: "초기 발급" });
    token = t.token;
    token_hint = t.hint;
  }
  const user = (await listUsers(env)).find((u) => u.id === id)!;
  return { user, token, token_hint };
}

export async function updateUser(env: Env, ctx: AuthContext, id: string, input: UserInput): Promise<UserRow> {
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<User>();
  if (!u) bad("사용자를 찾을 수 없습니다");
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    const n = str(input.name, 100);
    if (!n) bad("name 은 비울 수 없습니다");
    sets.push("name = ?");
    params.push(n);
  }
  if (input.email !== undefined) {
    sets.push("email = ?");
    params.push(str(input.email, 200));
  }
  if (input.role !== undefined) {
    const r = oneOf(input.role, ["admin", "member"] as const, "role");
    if (id === ctx.user.id && r !== "admin") bad("자기 자신의 관리자 권한은 해제할 수 없습니다");
    sets.push("role = ?");
    params.push(r);
  }
  if (input.note !== undefined) {
    sets.push("note = ?");
    params.push(str(input.note, 500));
  }
  if (input.disabled !== undefined && input.disabled !== null) {
    const off = bool(input.disabled);
    if (id === ctx.user.id && off) bad("자기 자신을 비활성화할 수 없습니다");
    sets.push("disabled_at = ?");
    params.push(off ? nowIso() : null);
  }
  if (sets.length) {
    params.push(id);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  }
  if (input.categories !== undefined) {
    const mems = normMemberships(input.categories);
    await assertCategoriesExist(env, mems);
    const at = nowIso();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM memberships WHERE user_id = ?`).bind(id),
      ...mems.map((m) => env.DB.prepare(`INSERT OR REPLACE INTO memberships (user_id, category_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(id, m.category_id, m.role, at)),
    ]);
  }
  if (!sets.length && input.categories === undefined) bad("변경할 필드가 없습니다");
  await logActivity(env, { actor_id: ctx.user.id, action: "user.update", target_id: id, summary: str(input.name, 100) || u.name, source: ctx.source });
  return (await listUsers(env)).find((x) => x.id === id)!;
}

export async function setMembership(env: Env, ctx: AuthContext, userId: string, categoryId: string, role: unknown): Promise<void> {
  const u = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(userId).first();
  if (!u) bad("사용자를 찾을 수 없습니다");
  const c = await env.DB.prepare(`SELECT id, name FROM categories WHERE id = ?`).bind(categoryId).first<{ id: string; name: string }>();
  if (!c) bad("카테고리를 찾을 수 없습니다");
  const r = oneOf(role ?? "member", ["lead", "member", "evaluator"] as const, "role");
  await env.DB.prepare(`INSERT OR REPLACE INTO memberships (user_id, category_id, role, created_at) VALUES (?, ?, ?, ?)`).bind(userId, categoryId, r, nowIso()).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "membership.set", target_id: userId, summary: `${c.name}: ${r}`, source: ctx.source });
}

export async function removeMembership(env: Env, ctx: AuthContext, userId: string, categoryId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM memberships WHERE user_id = ? AND category_id = ?`).bind(userId, categoryId).run();
  await logActivity(env, { actor_id: ctx.user.id, category_id: categoryId, action: "membership.remove", target_id: userId, source: ctx.source });
}

// ---------- 토큰 ----------

export interface TokenRow {
  id: string;
  user_id: string;
  user_name?: string;
  hint: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listTokens(env: Env, userId?: string): Promise<TokenRow[]> {
  const rs = await env.DB
    .prepare(
      `SELECT t.id, t.user_id, u.name AS user_name, t.hint, t.label, t.created_at, t.last_used_at, t.revoked_at
       FROM tokens t JOIN users u ON u.id = t.user_id ${userId ? "WHERE t.user_id = ?" : ""}
       ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`
    )
    .bind(...(userId ? [userId] : []))
    .all<TokenRow>();
  return rs.results ?? [];
}

export async function issueToken(env: Env, ctx: AuthContext, input: { user_id?: unknown; label?: unknown }): Promise<{ id: string; token: string; hint: string; user_id: string }> {
  const userId = str(input.user_id, 100);
  if (!userId) bad("user_id 가 필요합니다");
  const u = await env.DB.prepare(`SELECT id, name FROM users WHERE id = ?`).bind(userId).first<{ id: string; name: string }>();
  if (!u) bad("사용자를 찾을 수 없습니다");
  const token = newToken();
  const id = newId("tok");
  const hint = tokenHint(token);
  await env.DB
    .prepare(`INSERT INTO tokens (id, user_id, token_hash, hint, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, userId, await sha256Hex(token), hint, str(input.label, 100), nowIso())
    .run();
  await logActivity(env, { actor_id: ctx.user.id, action: "token.issue", target_id: userId, summary: `${u.name} ${hint}`, source: ctx.source });
  return { id, token, hint, user_id: userId };
}

export async function revokeToken(env: Env, ctx: AuthContext, id: string): Promise<void> {
  const t = await env.DB.prepare(`SELECT * FROM tokens WHERE id = ?`).bind(id).first<TokenRow>();
  if (!t) bad("토큰을 찾을 수 없습니다");
  await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowIso(), id).run();
  await logActivity(env, { actor_id: ctx.user.id, action: "token.revoke", target_id: t.user_id, summary: t.hint, source: ctx.source });
}

// ---------- 개요 / 활동 ----------

/** SQLite date() 수정자: 타임존의 현재 UTC 오프셋 (예: '+540 minutes') */
function tzModifier(tz: string): string {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const local = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
    const offsetMin = Math.round((local - now.getTime()) / 60000);
    return `${offsetMin >= 0 ? "+" : "-"}${Math.abs(offsetMin)} minutes`;
  } catch {
    return "+0 minutes";
  }
}

export async function overview(env: Env) {
  const tz = env.APP_TZ || "Asia/Seoul";
  const d7 = daysAgoIso(7);
  const d30 = daysAgoIso(30);
  const [counts, byStage, byCategory, perUser, recent, reviewQueue, deadlines] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE disabled_at IS NULL) AS users,
        (SELECT COUNT(*) FROM categories WHERE archived_at IS NULL) AS categories,
        (SELECT COUNT(*) FROM projects WHERE status = 'active') AS active_projects,
        (SELECT COUNT(*) FROM projects WHERE status = 'done') AS done_projects,
        (SELECT COUNT(*) FROM entries) AS entries,
        (SELECT COUNT(*) FROM entries WHERE created_at >= ?) AS entries_7d,
        (SELECT COUNT(*) FROM entries WHERE created_at >= ?) AS entries_30d,
        (SELECT COUNT(*) FROM entries WHERE source = 'mcp') AS entries_mcp,
        (SELECT COUNT(*) FROM entries WHERE review_status = 'requested') AS review_requested,
        (SELECT COUNT(*) FROM tokens WHERE revoked_at IS NULL) AS active_tokens,
        (SELECT COUNT(*) FROM signup_requests WHERE status = 'pending') AS pending_requests,
        (SELECT COUNT(*) FROM join_requests WHERE status = 'pending') AS pending_joins`).bind(d7, d30),
    env.DB.prepare(`SELECT track, stage, COUNT(*) AS n FROM projects WHERE status = 'active' GROUP BY track, stage`),
    env.DB.prepare(`
      SELECT c.id, c.name,
        (SELECT COUNT(*) FROM memberships m WHERE m.category_id = c.id) AS members,
        (SELECT COUNT(*) FROM projects p WHERE p.category_id = c.id AND p.status = 'active') AS active_projects,
        (SELECT COUNT(*) FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.category_id = c.id AND e.created_at >= ?) AS entries_7d,
        (SELECT COUNT(*) FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.category_id = c.id AND e.created_at >= ?) AS entries_30d,
        (SELECT MAX(e.created_at) FROM entries e JOIN projects p ON p.id = e.project_id WHERE p.category_id = c.id) AS last_entry_at
      FROM categories c WHERE c.archived_at IS NULL ORDER BY c.name`).bind(d7, d30),
    env.DB.prepare(`
      SELECT u.id, u.name, u.role, u.last_seen_at,
        (SELECT COUNT(*) FROM projects p WHERE p.owner_id = u.id AND p.status = 'active') AS active_projects,
        (SELECT COUNT(*) FROM entries e WHERE e.author_id = u.id AND e.created_at >= ?) AS entries_7d,
        (SELECT COUNT(*) FROM entries e WHERE e.author_id = u.id AND e.created_at >= ?) AS entries_30d,
        (SELECT MAX(e.created_at) FROM entries e WHERE e.author_id = u.id) AS last_entry_at,
        (SELECT GROUP_CONCAT(c.name, ', ') FROM memberships m JOIN categories c ON c.id = m.category_id WHERE m.user_id = u.id) AS category_names
      FROM users u WHERE u.disabled_at IS NULL ORDER BY last_entry_at DESC`).bind(d7, d30),
    env.DB.prepare(`
      SELECT date(a.at, ?) AS day, COUNT(*) AS n FROM activity a WHERE a.at >= ? AND a.action IN ('entry.create','comment.create','stage.update','project.create')
      GROUP BY day ORDER BY day`).bind(tzModifier(tz), daysAgoIso(42)),
    env.DB.prepare(`
      SELECT e.id, e.title, e.date, e.updated_at, e.stage, p.id AS project_id, p.title AS project_title, c.name AS category_name, u.name AS author_name
      FROM entries e JOIN projects p ON p.id = e.project_id JOIN categories c ON c.id = p.category_id JOIN users u ON u.id = e.author_id
      WHERE e.review_status = 'requested' ORDER BY e.updated_at ASC LIMIT 50`),
    env.DB.prepare(`
      SELECT p.id, p.title, p.deadline, p.stage, p.target_venue, u.name AS owner_name, c.name AS category_name
      FROM projects p JOIN users u ON u.id = p.owner_id JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.deadline IS NOT NULL AND p.deadline >= ? ORDER BY p.deadline LIMIT 20`).bind(daysAgoDate(0, tz)),
  ]);
  const stageCounts: Record<string, number> = {};
  const byTrack: Record<string, { label: string; stages: { id: string; label: string; n: number }[] }> = {};
  for (const t of Object.values(TRACKS)) byTrack[t.id] = { label: t.label, stages: t.stages.map((s) => ({ id: s.id, label: s.label, n: 0 })) };
  for (const r of byStage.results as { track: string; stage: string; n: number }[]) {
    stageCounts[r.stage] = (stageCounts[r.stage] ?? 0) + r.n;
    const t = byTrack[r.track] ?? byTrack[DEFAULT_TRACK];
    const st = t.stages.find((x) => x.id === r.stage);
    if (st) st.n += r.n;
  }
  return {
    counts: counts.results[0],
    by_stage: stageCounts,
    by_track: byTrack,
    by_category: byCategory.results,
    per_user: perUser.results,
    daily_activity: recent.results,
    review_queue: reviewQueue.results,
    deadlines: deadlines.results,
    generated_at: nowIso(),
  };
}

export interface ActivityRow {
  id: number;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  category_id: string | null;
  category_name: string | null;
  project_id: string | null;
  project_title: string | null;
  action: string;
  target_id: string | null;
  summary: string;
  source: string;
}

export async function listActivity(env: Env, opts: { category_id?: string; project_id?: string; actor_id?: string; limit?: unknown; before?: unknown; category_ids?: string[] }): Promise<ActivityRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.category_id) {
    where.push("a.category_id = ?");
    params.push(opts.category_id);
  } else if (opts.category_ids) {
    if (!opts.category_ids.length) return [];
    where.push(`a.category_id IN (${opts.category_ids.map(() => "?").join(",")})`);
    params.push(...opts.category_ids);
  }
  if (opts.project_id) {
    where.push("a.project_id = ?");
    params.push(opts.project_id);
  }
  if (opts.actor_id) {
    where.push("a.actor_id = ?");
    params.push(opts.actor_id);
  }
  const before = clampInt(opts.before, 0, 0, Number.MAX_SAFE_INTEGER);
  if (before > 0) {
    where.push("a.id < ?");
    params.push(before);
  }
  params.push(clampInt(opts.limit, 50, 1, 300));
  const rs = await env.DB
    .prepare(
      `SELECT a.*, u.name AS actor_name, c.name AS category_name, p.title AS project_title
       FROM activity a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN categories c ON c.id = a.category_id LEFT JOIN projects p ON p.id = a.project_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY a.id DESC LIMIT ?`
    )
    .bind(...params)
    .all<ActivityRow>();
  return rs.results ?? [];
}
