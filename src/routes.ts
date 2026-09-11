import type { AuthContext, Env } from "./env";
import { authenticate, requireAdmin, requireWriter } from "./lib/auth";
import { HttpError, json, text, html, readJson, notFound } from "./lib/http";
import * as P from "./services/projects";
import * as E from "./services/entries";
import * as T from "./services/tasks";
import * as A from "./services/admin";
import * as F from "./services/feed";
import * as R from "./services/report";
import * as S from "./services/signup";
import * as TM from "./services/teams";
import * as EV from "./services/evaluations";
import * as PV from "./services/publicview";

type Handler = (req: Request, env: Env, ctx: AuthContext, params: Record<string, string>, url: URL) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];
type PublicHandler = (req: Request, env: Env, params: Record<string, string>, url: URL) => Promise<Response>;
const publicRoutes: { method: string; pattern: RegExp; keys: string[]; handler: PublicHandler }[] = [];

function add(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/\//g, "\\/").replace(/:(\w+)/g, (_m, k) => {
        keys.push(k);
        return "([^\\/]+)";
      }) +
      "$"
  );
  routes.push({ method, pattern, keys, handler });
}

function addPublic(method: string, path: string, handler: PublicHandler) {
  const keys: string[] = [];
  const pattern = new RegExp("^" + path.replace(/\//g, "\\/").replace(/:(\w+)/g, (_m, k) => { keys.push(k); return "([^\\/]+)"; }) + "$");
  publicRoutes.push({ method, pattern, keys, handler });
}

const q = (url: URL, k: string) => url.searchParams.get(k) ?? undefined;

// ---------- 공개 (인증 불필요): 발급 신청 ----------
addPublic("GET", "/api/public/config", async (_r, env) => json(await S.publicConfig(env)));
addPublic("POST", "/api/public/requests", async (req, env) => json(await S.createRequest(env, await readJson(req, 16 * 1024)), 201));
addPublic("GET", "/api/public/requests/:claim", async (_r, env, p) => json(await S.requestStatus(env, p.claim)));
addPublic("POST", "/api/public/requests/:claim/claim", async (_r, env, p) => json(await S.claimToken(env, p.claim)));
// 공개 카테고리 핀 열람: 팀 목록 → 핀 입력 → 열람 토큰(rnv_, 24시간, 읽기 전용)
addPublic("GET", "/api/public/teams", async (_r, env) => json(await PV.listPublicTeams(env)));
addPublic("POST", "/api/public/teams/:id/pin", async (req, env, p) => json(await PV.pinLogin(env, req, p.id, await readJson(req, 4 * 1024))));

type ReportResult = { type: "json"; data: unknown } | { type: "md"; text: string; title?: string } | { type: "html"; html: string; title?: string };

function reportResponse(r: ReportResult, download: boolean) {
  const safe = (r as { title?: string }).title?.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "report";
  if (r.type === "json") return json(r.data);
  if (r.type === "md")
    return text(r.text, 200, "text/markdown; charset=utf-8", download ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.md` } : {});
  return html(r.html, 200, download ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.html` } : {});
}

// ---------- me / 카테고리 ----------
add("GET", "/api/me", async (_r, env, ctx) => json(await F.me(env, ctx)));
add("GET", "/api/categories", async (_r, env, ctx) => {
  const all = await A.listCategories(env, false);
  return json(ctx.isAdmin ? all : all.filter((c) => ctx.memberships.some((m) => m.category_id === c.id)));
});
add("GET", "/api/categories/:id", async (_r, env, ctx, p) => json(await F.categoryDetail(env, ctx, p.id)));
add("GET", "/api/categories/:id/board", async (_r, env, ctx, p) => json(await P.categoryBoard(env, ctx, p.id)));
add("GET", "/api/categories/:id/report", async (_r, env, ctx, p, url) =>
  reportResponse(await R.categoryReport(env, ctx, p.id, q(url, "format") || "html", { from: q(url, "from"), to: q(url, "to") }), q(url, "download") === "1")
);

// ---------- 프로젝트 ----------
add("GET", "/api/projects", async (_r, env, ctx, _p, url) =>
  json(await P.listProjects(env, ctx, { category_id: q(url, "category_id"), owner_id: q(url, "mine") === "1" ? ctx.user.id : q(url, "owner_id"), status: q(url, "status"), q: q(url, "q"), limit: Number(q(url, "limit")) || undefined }))
);
add("POST", "/api/projects", async (req, env, ctx) => json(await P.createProject(env, ctx, await readJson(req)), 201));
add("GET", "/api/projects/:id", async (_r, env, ctx, p) => json(await P.getProjectDetail(env, ctx, p.id)));
add("PATCH", "/api/projects/:id", async (req, env, ctx, p) => json(await P.updateProject(env, ctx, p.id, await readJson(req))));
add("DELETE", "/api/projects/:id", async (_r, env, ctx, p) => {
  await P.archiveProject(env, ctx, p.id);
  return json({ ok: true });
});
add("PUT", "/api/projects/:id/stages/:stage", async (req, env, ctx, p) => json(await P.updateStage(env, ctx, p.id, p.stage, await readJson(req))));
add("PUT", "/api/projects/:id/collaborators", async (req, env, ctx, p) => {
  const b = await readJson<{ user_ids?: unknown }>(req);
  return json(await P.setCollaborators(env, ctx, p.id, b.user_ids));
});
add("POST", "/api/projects/:id/advance", async (req, env, ctx, p) => {
  const b = await readJson<{ to?: unknown }>(req);
  return json(await P.advanceStage(env, ctx, p.id, b.to));
});
add("GET", "/api/projects/:id/report", async (_r, env, ctx, p, url) =>
  reportResponse(await R.projectReport(env, ctx, p.id, q(url, "format") || "html", { from: q(url, "from"), to: q(url, "to"), include_comments: q(url, "comments") !== "0" }), q(url, "download") === "1")
);

// ---------- 기록 ----------
add("GET", "/api/entries", async (_r, env, ctx, _p, url) =>
  json(
    await E.listEntries(env, ctx, {
      project_id: q(url, "project_id"), category_id: q(url, "category_id"), author_id: q(url, "mine") === "1" ? ctx.user.id : q(url, "author_id"),
      stage: q(url, "stage"), since: q(url, "since"), until: q(url, "until"), review_status: q(url, "review_status"), q: q(url, "q"),
      limit: Number(q(url, "limit")) || undefined, offset: Number(q(url, "offset")) || undefined, with_content: q(url, "brief") !== "1",
    })
  )
);
add("GET", "/api/projects/:id/entries", async (_r, env, ctx, p, url) =>
  json(await E.listEntries(env, ctx, { project_id: p.id, stage: q(url, "stage"), since: q(url, "since"), until: q(url, "until"), review_status: q(url, "review_status"), limit: Number(q(url, "limit")) || undefined, offset: Number(q(url, "offset")) || undefined }))
);
add("POST", "/api/projects/:id/entries", async (req, env, ctx, p) => json(await E.createEntry(env, ctx, p.id, await readJson(req)), 201));
add("GET", "/api/entries/:id", async (_r, env, ctx, p) => json(await E.getEntryFull(env, ctx, p.id)));
add("PATCH", "/api/entries/:id", async (req, env, ctx, p) => json(await E.updateEntry(env, ctx, p.id, await readJson(req))));
add("DELETE", "/api/entries/:id", async (_r, env, ctx, p) => {
  await E.deleteEntry(env, ctx, p.id);
  return json({ ok: true });
});
add("POST", "/api/entries/:id/review", async (req, env, ctx, p) => {
  const b = await readJson<{ status?: unknown; note?: unknown }>(req);
  return json(await E.setReviewStatus(env, ctx, p.id, b.status, b.note));
});
add("GET", "/api/entries/:id/comments", async (_r, env, ctx, p) => json((await E.getEntryFull(env, ctx, p.id)).comments ?? []));
add("POST", "/api/entries/:id/comments", async (req, env, ctx, p) => {
  const b = await readJson<{ content?: unknown; kind?: unknown }>(req);
  return json(await E.addComment(env, ctx, p.id, b.content, b.kind ?? "comment"), 201);
});
add("DELETE", "/api/comments/:id", async (_r, env, ctx, p) => {
  await E.deleteComment(env, ctx, p.id);
  return json({ ok: true });
});

// ---------- 평가 (마일스톤별 평가자 채점·피드백 + 팀 답변) ----------
add("GET", "/api/projects/:id/evaluations", async (_r, env, ctx, p) => json(await EV.listEvaluations(env, ctx, p.id)));
add("POST", "/api/projects/:id/evaluations", async (req, env, ctx, p) => json(await EV.createEvaluation(env, ctx, p.id, await readJson(req)), 201));
add("GET", "/api/evaluations/:id", async (_r, env, ctx, p) => json(await EV.getEvaluation(env, ctx, p.id)));
add("PATCH", "/api/evaluations/:id", async (req, env, ctx, p) => json(await EV.updateEvaluation(env, ctx, p.id, await readJson(req))));
add("DELETE", "/api/evaluations/:id", async (_r, env, ctx, p) => {
  await EV.deleteEvaluation(env, ctx, p.id);
  return json({ ok: true });
});
add("POST", "/api/evaluations/:id/respond", async (req, env, ctx, p) => {
  const b = await readJson<{ response?: unknown }>(req);
  return json(await EV.respondEvaluation(env, ctx, p.id, b.response));
});

// ---------- 할 일 ----------
add("GET", "/api/projects/:id/tasks", async (_r, env, ctx, p, url) => json(await T.listTasks(env, ctx, p.id, q(url, "status"))));
add("POST", "/api/projects/:id/tasks", async (req, env, ctx, p) => json(await T.createTask(env, ctx, p.id, await readJson(req)), 201));
add("PATCH", "/api/tasks/:id", async (req, env, ctx, p) => json(await T.updateTask(env, ctx, p.id, await readJson(req))));
add("DELETE", "/api/tasks/:id", async (_r, env, ctx, p) => {
  await T.deleteTask(env, ctx, p.id);
  return json({ ok: true });
});

// ---------- 팀 로비 / 가입 ----------
add("GET", "/api/lobby", async (_r, env, ctx) => json(await TM.lobby(env, ctx)));
add("POST", "/api/lobby/:id/join", async (req, env, ctx, p) => {
  const b = await readJson<{ message?: unknown; role?: unknown }>(req);
  return json(await TM.joinTeam(env, ctx, p.id, b.message, b.role));
});
add("DELETE", "/api/lobby/:id/join", async (_r, env, ctx, p) => json(await TM.leaveTeam(env, ctx, p.id)));
add("GET", "/api/join-requests", async (_r, env, ctx, _p, url) => json(await TM.listJoinRequests(env, ctx, { category_id: q(url, "category_id"), status: q(url, "status") })));
add("POST", "/api/join-requests/:id/approve", async (req, env, ctx, p) => {
  const b = await readJson<{ note?: unknown; role?: unknown }>(req);
  return json(await TM.decideJoinRequest(env, ctx, p.id, true, b.note, b.role ?? "member"));
});
add("POST", "/api/join-requests/:id/reject", async (req, env, ctx, p) => {
  const b = await readJson<{ note?: unknown }>(req);
  return json(await TM.decideJoinRequest(env, ctx, p.id, false, b.note));
});

// ---------- 피드 / 검색 ----------
add("GET", "/api/feed", async (_r, env, ctx, _p, url) => json(await F.feed(env, ctx, { category_id: q(url, "category_id"), project_id: q(url, "project_id"), limit: q(url, "limit"), before: q(url, "before") })));
add("GET", "/api/search", async (_r, env, ctx, _p, url) => json(await F.search(env, ctx, q(url, "q"), q(url, "category_id"), q(url, "limit"))));

// ---------- 관리자 ----------
const admin = (h: Handler): Handler => async (req, env, ctx, p, url) => {
  requireAdmin(ctx);
  return h(req, env, ctx, p, url);
};
add("GET", "/api/admin/overview", admin(async (_r, env) => json(await A.overview(env))));
add("GET", "/api/admin/activity", admin(async (_r, env, _c, _p, url) => json(await A.listActivity(env, { category_id: q(url, "category_id"), actor_id: q(url, "actor_id"), limit: q(url, "limit"), before: q(url, "before") }))));
add("GET", "/api/admin/categories", admin(async (_r, env, _c, _p, url) => json(await A.listCategories(env, q(url, "all") === "1"))));
add("POST", "/api/admin/categories", admin(async (req, env, ctx) => json(await A.createCategory(env, ctx, await readJson(req)), 201)));
add("PATCH", "/api/admin/categories/:id", admin(async (req, env, ctx, p) => json(await A.updateCategory(env, ctx, p.id, await readJson(req)))));
add("GET", "/api/admin/users", admin(async (_r, env) => json(await A.listUsers(env))));
add("POST", "/api/admin/users", admin(async (req, env, ctx) => json(await A.createUser(env, ctx, await readJson(req)), 201)));
add("PATCH", "/api/admin/users/:id", admin(async (req, env, ctx, p) => json(await A.updateUser(env, ctx, p.id, await readJson(req)))));
add("PUT", "/api/admin/users/:id/memberships/:cat", admin(async (req, env, ctx, p) => {
  const b = await readJson<{ role?: unknown }>(req);
  await A.setMembership(env, ctx, p.id, p.cat, b.role ?? "member");
  return json({ ok: true });
}));
add("DELETE", "/api/admin/users/:id/memberships/:cat", admin(async (_r, env, ctx, p) => {
  await A.removeMembership(env, ctx, p.id, p.cat);
  return json({ ok: true });
}));
add("GET", "/api/admin/tokens", admin(async (_r, env, _c, _p, url) => json(await A.listTokens(env, q(url, "user_id")))));
add("POST", "/api/admin/tokens", admin(async (req, env, ctx) => json(await A.issueToken(env, ctx, await readJson(req)), 201)));
add("POST", "/api/admin/tokens/:id/revoke", admin(async (_r, env, ctx, p) => {
  await A.revokeToken(env, ctx, p.id);
  return json({ ok: true });
}));
// 카테고리의 핀 열람 세션 전부 만료 (핀은 유지)
add("POST", "/api/admin/categories/:id/viewers/revoke", admin(async (_r, env, ctx, p) => {
  const n = await PV.revokeViewerSessions(env, p.id);
  await A.updateCategoryNote(env, ctx, p.id, `열람 세션 ${n}건 강제 만료`);
  return json({ ok: true, revoked: n });
}));

add("GET", "/api/admin/requests", admin(async (_r, env, _c, _p, url) => json(await S.listRequests(env, q(url, "status") || "pending"))));
add("POST", "/api/admin/requests/:id/approve", admin(async (req, env, ctx, p) => json(await S.approveRequest(env, ctx, p.id, await readJson(req)))));
add("POST", "/api/admin/requests/:id/reject", admin(async (req, env, ctx, p) => {
  const b = await readJson<{ reason?: unknown }>(req);
  return json(await S.rejectRequest(env, ctx, p.id, b.reason));
}));
add("DELETE", "/api/admin/requests/:id", admin(async (_r, env, _c, p) => json(await S.deleteRequest(env, p.id))));

// ---------- 디스패치 ----------
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();
  let matchedPath = false;
  for (const r of publicRoutes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    matchedPath = true;
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    try {
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    } catch {
      return json({ error: "bad_request", message: "경로 인코딩이 올바르지 않습니다" }, 400);
    }
    try {
      return await r.handler(request, env, params, url);
    } catch (err) {
      return errorResponse(err);
    }
  }
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    matchedPath = true;
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    try {
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    } catch {
      return json({ error: "bad_request", message: "경로 인코딩이 올바르지 않습니다" }, 400);
    }
    try {
      // source: 'mcp' 는 /mcp 엔드포인트에서만 부여 (REST 는 web | api)
      const ctx = await authenticate(request, env, request.headers.get("x-client") === "web" ? "web" : "api");
      // 핀 열람 세션은 읽기 전용: GET 이외의 모든 요청을 서버에서 거부한다 (버튼 숨김에 의존하지 않음)
      if (ctx.viewer && method !== "GET") requireWriter(ctx);
      return await r.handler(request, env, ctx, params, url);
    } catch (err) {
      return errorResponse(err);
    }
  }
  if (matchedPath) return json({ error: "method_not_allowed", message: `${method} ${path} 는 지원하지 않습니다` }, 405);
  return notFoundResponse(path);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.code, message: err.message }, err.status);
  const msg = err instanceof Error ? err.message : String(err);
  console.error("unhandled", msg, err instanceof Error ? err.stack : "");
  // 내부 오류 원문(D1 메시지·스택)은 로그에만 남기고 응답은 요약만
  const hint = /D1_ERROR|SQLITE/.test(msg) ? "데이터베이스 오류 (스키마 마이그레이션이 적용됐는지 확인하세요)" : "서버 내부 오류";
  return json({ error: "internal", message: hint }, 500);
}

function notFoundResponse(path: string): Response {
  try {
    notFound(`${path} 경로가 없습니다`);
  } catch (e) {
    return errorResponse(e);
  }
  return json({ error: "not_found" }, 404);
}

