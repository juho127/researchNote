#!/usr/bin/env node
/**
 * 엔드투엔드 스모크 테스트 — 실제 서버(로컬 wrangler dev 또는 배포본)에 대해 전체 흐름을 검증한다.
 *
 *   BASE_URL=http://127.0.0.1:8787 ADMIN_TOKEN=rn_... node tests/smoke.mjs
 *
 * 생성물: 카테고리 "smoke-<ts>", 사용자 2명, 프로젝트 1개, 기록/코멘트/할 일. 마지막에 프로젝트를 보관 처리하고
 * 카테고리를 아카이브한다 (완전 삭제는 하지 않음 — 활동 로그 보존).
 */
const BASE = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.error("ADMIN_TOKEN 환경변수가 필요합니다");
  process.exit(2);
}

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name} ${extra}`); }
}

async function api(token, method, path, body, client = "api") {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Client": client },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  return { status: r.status, data, headers: r.headers };
}

let rpcId = 1;
async function mcp(token, method, params) {
  const r = await fetch(BASE + "/mcp", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  if (r.status === 202) return { status: 202 };
  return { status: r.status, data: await r.json() };
}

const ts = Date.now().toString(36);
(async () => {
  // health
  const h = await fetch(BASE + "/health");
  ok("GET /health", h.status === 200);

  // 인증
  const noauth = await fetch(BASE + "/api/me");
  ok("401 without token", noauth.status === 401);
  const bad = await api("rn_invalid", "GET", "/api/me");
  ok("401 invalid token", bad.status === 401);
  const me = await api(ADMIN, "GET", "/api/me");
  ok("GET /api/me (admin)", me.status === 200 && me.data.is_admin === true, JSON.stringify(me.data).slice(0, 200));

  // 카테고리
  const cat = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-${ts}`, description: "스모크 테스트 팀" });
  ok("POST /api/admin/categories", cat.status === 201 && cat.data.id, JSON.stringify(cat.data));
  const catId = cat.data.id;

  // 사용자 2명 (리드 + 멤버), 토큰 발급
  const lead = await api(ADMIN, "POST", "/api/admin/users", { name: `리드${ts}`, categories: [{ category_id: catId, role: "lead" }], issue_token: true });
  ok("POST /api/admin/users (lead + token)", lead.status === 201 && lead.data.token?.startsWith("rn_"), JSON.stringify(lead.data).slice(0, 200));
  const member = await api(ADMIN, "POST", "/api/admin/users", { name: `연구원${ts}`, categories: [catId], issue_token: true });
  ok("POST /api/admin/users (member + token)", member.status === 201 && member.data.token?.startsWith("rn_"));
  const LEAD = lead.data.token, MEM = member.data.token, memId = member.data.user.id, leadId = lead.data.user.id;

  const memMe = await api(MEM, "GET", "/api/me");
  ok("member /api/me sees membership", memMe.status === 200 && memMe.data.memberships.some((m) => m.category_id === catId));
  const memAdmin = await api(MEM, "GET", "/api/admin/overview");
  ok("member forbidden on admin", memAdmin.status === 403);

  // 프로젝트
  const prj = await api(MEM, "POST", "/api/projects", { category_id: catId, title: `스모크 논문 ${ts}`, summary: "테스트 연구 질문", target_venue: "NeurIPS", deadline: "2027-01-31", tags: ["test", "smoke"] }, "web");
  ok("POST /api/projects (member)", prj.status === 201 && prj.data.stages?.length === 6, JSON.stringify(prj.data).slice(0, 300));
  const prjId = prj.data.id;
  ok("project initial stage planning=doing", prj.data.stages?.find((s) => s.stage === "planning")?.status === "doing");

  const other = await api(ADMIN, "POST", "/api/admin/users", { name: `외부인${ts}`, issue_token: true });
  const OUT = other.data.token;
  const outsider = await api(OUT, "GET", `/api/projects/${prjId}`);
  ok("outsider forbidden on project", outsider.status === 403);

  // 기록 (web)
  const e1 = await api(MEM, "POST", `/api/projects/${prjId}/entries`, { title: "첫 실험", content: "## 한 일\n- baseline\n\n## 결과\n| 모델 | acc |\n|---|---|\n| A | 0.91 |", stage: "experiment", date: "2026-09-01" }, "web");
  ok("POST entry (web)", e1.status === 201 && e1.data.source === "web" && e1.data.stage === "experiment", JSON.stringify(e1.data).slice(0, 200));
  const e1Id = e1.data.id;
  const badDate = await api(MEM, "POST", `/api/projects/${prjId}/entries`, { title: "x", content: "y", date: "2026-13-40" });
  ok("entry invalid date rejected", badDate.status === 400);
  const leadEntryOnMemberProject = await api(LEAD, "POST", `/api/projects/${prjId}/entries`, { title: "리드 메모", content: "리드가 남김" });
  ok("lead can write entry on member project", leadEntryOnMemberProject.status === 201);

  // 검토 흐름
  const req = await api(MEM, "POST", `/api/entries/${e1Id}/review`, { status: "requested" });
  ok("member requests review", req.status === 200 && req.data.review_status === "requested");
  const memApprove = await api(MEM, "POST", `/api/entries/${e1Id}/review`, { status: "approved" });
  ok("member cannot approve", memApprove.status === 403);
  const cmt = await api(LEAD, "POST", `/api/entries/${e1Id}/comments`, { content: "baseline 시드 5개로 반복하세요" });
  ok("lead comments", cmt.status === 201);
  const chg = await api(LEAD, "POST", `/api/entries/${e1Id}/review`, { status: "changes_requested", note: "반복 실험 필요" });
  ok("lead requests changes", chg.status === 200 && chg.data.review_status === "changes_requested" && chg.data.comments?.length === 2);
  const appr = await api(LEAD, "POST", `/api/entries/${e1Id}/comments`, { content: "확인", kind: "approve" });
  ok("lead approve via comment", appr.status === 201);
  const e1Full = await api(MEM, "GET", `/api/entries/${e1Id}`);
  ok("entry approved + 3 comments", e1Full.data.review_status === "approved" && e1Full.data.comments.length === 3);

  // 단계 정리 · 한 흐름 진행
  const st = await api(MEM, "PUT", `/api/projects/${prjId}/stages/experiment`, { summary: "## 실험\n- baseline 0.91", set_current: true });
  ok("PUT stage summary + set_current → flow recalculated", st.status === 200 && st.data.stage === "experiment" && st.data.stage_done === 3 && st.data.stages.find((s) => s.stage === "planning").status === "done" && st.data.stages.find((s) => s.stage === "writing").status === "todo");
  const adv = await api(MEM, "POST", `/api/projects/${prjId}/advance`, {});
  ok("advance → writing, stage_done=4", adv.status === 200 && adv.data.stage === "writing" && adv.data.stage_done === 4);
  const back = await api(MEM, "POST", `/api/projects/${prjId}/advance`, { to: "method" });
  ok("advance to earlier stage → method, later stages todo, summaries kept", back.status === 200 && back.data.stage === "method" && back.data.stage_done === 2 && back.data.stages.find((s) => s.stage === "experiment").status === "todo" && back.data.stages.find((s) => s.stage === "experiment").summary.includes("baseline"));
  const summaryOnly = await api(MEM, "PUT", `/api/projects/${prjId}/stages/writing`, { summary: "초고 계획" });
  ok("summary edit on later stage does not move current", summaryOnly.status === 200 && summaryOnly.data.stage === "method");
  const jumpBack = await api(MEM, "POST", `/api/projects/${prjId}/advance`, { to: "experiment" });
  ok("advance to experiment again", jumpBack.data.stage === "experiment" && jumpBack.data.stage_done === 3);
  const advAll = [];
  for (let i = 0; i < 2; i++) advAll.push(await api(MEM, "POST", `/api/projects/${prjId}/advance`, {}));
  ok("advance twice → review (last)", advAll[1].data.stage === "review" && advAll[1].data.status === "active");
  const finish = await api(MEM, "POST", `/api/projects/${prjId}/advance`, {});
  ok("advance on last stage → paper done", finish.status === 200 && finish.data.status === "done" && finish.data.stage_done === 6);
  const again = await api(MEM, "POST", `/api/projects/${prjId}/advance`, {});
  ok("advance on done paper → 400", again.status === 400);
  const reopen = await api(MEM, "POST", `/api/projects/${prjId}/advance`, { to: "experiment" });
  ok("reopen done paper to experiment → active", reopen.status === 200 && reopen.data.status === "active" && reopen.data.stage === "experiment");

  // 할 일
  const t1 = await api(LEAD, "POST", `/api/projects/${prjId}/tasks`, { title: "시드 5개 반복", due: "2026-09-10", assignee_id: memId });
  ok("lead adds task for member", t1.status === 201 && t1.data.assignee_name);
  const t1u = await api(MEM, "PATCH", `/api/tasks/${t1.data.id}`, { status: "done" });
  ok("member completes task", t1u.status === 200 && t1u.data.status === "done" && t1u.data.done_at);

  // 보드 / 피드 / 검색
  const board = await api(LEAD, "GET", `/api/categories/${catId}/board`);
  ok("category board has project in experiment column", board.status === 200 && board.data.columns.find((c) => c.stage === "experiment")?.projects.some((p) => p.id === prjId));
  const feed = await api(MEM, "GET", `/api/feed?category_id=${catId}&limit=10`);
  ok("feed lists activity", feed.status === 200 && feed.data.length >= 5);
  const search = await api(MEM, "GET", `/api/search?q=${encodeURIComponent("baseline")}`);
  ok("search finds entry", search.status === 200 && search.data.entries.some((e) => e.id === e1Id));
  const catDetail = await api(MEM, "GET", `/api/categories/${catId}`);
  ok("category detail members=2", catDetail.status === 200 && catDetail.data.members.length === 2);

  // 보고서
  const rmd = await api(MEM, "GET", `/api/projects/${prjId}/report?format=md`);
  ok("project report md", rmd.status === 200 && typeof rmd.data === "string" && rmd.data.includes("첫 실험") && rmd.data.includes("반복 실험 필요"));
  const rhtml = await api(MEM, "GET", `/api/projects/${prjId}/report`);
  ok("project report html", rhtml.status === 200 && typeof rhtml.data === "string" && rhtml.data.includes("<table>") && rhtml.data.includes("window.print()"));
  const crep = await api(LEAD, "GET", `/api/categories/${catId}/report?format=md&from=2026-09-01`);
  ok("category report md", crep.status === 200 && crep.data.includes("스모크 논문"));
  const xss = await api(MEM, "POST", `/api/projects/${prjId}/entries`, { title: "<script>alert(1)</script>", content: "<img src=x onerror=alert(1)> **bold**" });
  const rx = await api(MEM, "GET", `/api/projects/${prjId}/report`);
  ok("report escapes html", rx.data.includes("&lt;script&gt;") && !rx.data.includes("<img src=x"));

  // MCP
  const init = await mcp(MEM, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  ok("mcp initialize", init.status === 200 && init.data.result?.protocolVersion === "2025-06-18" && init.data.result.instructions?.includes("whoami"), JSON.stringify(init.data).slice(0, 200));
  const notif = await fetch(BASE + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${MEM}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  ok("mcp notification → 202", notif.status === 202);
  const tl = await mcp(MEM, "tools/list", {});
  ok("mcp tools/list ≥ 15 tools", tl.status === 200 && tl.data.result?.tools?.length >= 15);
  const who = await mcp(MEM, "tools/call", { name: "whoami", arguments: {} });
  ok("mcp whoami", who.data.result?.content?.[0]?.text?.includes(prjId));
  const logged = await mcp(MEM, "tools/call", { name: "log_progress", arguments: { project_id: prjId, title: "MCP 기록", content: "## 한 일\n- AI 로 기록", stage: "writing", request_review: true } });
  ok("mcp log_progress", logged.data.result?.structuredContent?.source === "mcp" && logged.data.result.structuredContent.review_status === "requested", JSON.stringify(logged.data).slice(0, 300));
  const gp = await mcp(MEM, "tools/call", { name: "get_project", arguments: { project_id: prjId } });
  ok("mcp get_project mentions MCP 기록", gp.data.result?.content?.[0]?.text?.includes("MCP 기록"));
  const badTool = await mcp(MEM, "tools/call", { name: "nope", arguments: {} });
  ok("mcp unknown tool → error", badTool.data.error?.code === -32602);
  const forb = await mcp(OUT, "tools/call", { name: "get_project", arguments: { project_id: prjId } });
  ok("mcp forbidden → isError", forb.data.result?.isError === true);
  const pr = await mcp(MEM, "prompts/get", { name: "log_today", arguments: { project_id: prjId } });
  ok("mcp prompts/get", pr.data.result?.messages?.[0]?.content?.text?.includes(prjId));
  const rs = await mcp(MEM, "resources/read", { uri: "research-note://guide" });
  ok("mcp resources/read guide", rs.data.result?.contents?.[0]?.text?.includes("연구노트"));
  const unauth = await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  ok("mcp 401 without token", unauth.status === 401 && unauth.headers.get("www-authenticate")?.includes("Bearer"));
  const skill = await fetch(BASE + "/SKILL.md");
  ok("GET /SKILL.md", skill.status === 200 && (await skill.text()).includes("log_progress"));

  // 관리자 개요 / 토큰 회수
  const ov = await api(ADMIN, "GET", "/api/admin/overview");
  ok("admin overview counts", ov.status === 200 && ov.data.counts.entries >= 3 && ov.data.review_queue.length >= 1);
  const toks = await api(ADMIN, "GET", `/api/admin/tokens?user_id=${memId}`);
  ok("admin lists tokens", toks.status === 200 && toks.data.length === 1);
  const rv = await api(ADMIN, "POST", `/api/admin/tokens/${toks.data[0].id}/revoke`);
  ok("admin revokes token", rv.status === 200);
  const afterRevoke = await api(MEM, "GET", "/api/me");
  ok("revoked token → 401", afterRevoke.status === 401);
  const reissue = await api(ADMIN, "POST", "/api/admin/tokens", { user_id: memId, label: "재발급" });
  ok("admin reissues token", reissue.status === 201 && reissue.data.token);
  const dis = await api(ADMIN, "PATCH", `/api/admin/users/${other.data.user.id}`, { disabled: true });
  ok("admin disables user", dis.status === 200 && dis.data.disabled_at);
  const disMe = await api(OUT, "GET", "/api/me");
  ok("disabled user → 401", disMe.status === 401);

  // 리뷰에서 나온 회귀 검사
  const MEM2 = reissue.data.token;
  const approvedEdit = await api(MEM2, "PATCH", `/api/entries/${e1Id}`, { content: "## 결과\n- 수정된 본문" });
  ok("editing approved entry resets review to none", approvedEdit.status === 200 && approvedEdit.data.review_status === "none", JSON.stringify(approvedEdit.data).slice(0, 200));
  const longQ = await api(MEM2, "GET", `/api/search?q=${encodeURIComponent("가나다라마바사아자차카타파하가나다라마바")}`);
  ok("long korean search query → 200", longQ.status === 200, JSON.stringify(longQ.data).slice(0, 120));
  const badCat = await api(ADMIN, "POST", "/api/admin/users", { name: `없는카테고리${ts}`, categories: ["no-such-category"] });
  ok("user create with unknown category → 400", badCat.status === 400, JSON.stringify(badCat.data).slice(0, 120));
  const longTitle = await api(MEM2, "POST", `/api/projects/${prjId}/entries`, { title: "x".repeat(201), content: "y" });
  ok("title over 200 chars → 400", longTitle.status === 400);
  const feb31 = await api(MEM2, "POST", `/api/projects/${prjId}/entries`, { title: "d", content: "y", date: "2026-02-31" });
  ok("2026-02-31 rejected", feb31.status === 400);
  const objTitle = await api(MEM2, "POST", `/api/projects/${prjId}/entries`, { title: { a: 1 }, content: "y" });
  ok("object title → 400", objTitle.status === 400);
  const spoof = await api(MEM2, "POST", `/api/projects/${prjId}/entries`, { title: "spoof", content: "y" }, "mcp");
  ok("REST cannot spoof source=mcp", spoof.status === 201 && spoof.data.source === "api");
  const mcpNotif = await fetch(BASE + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${MEM2}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { name: "log_progress", arguments: { project_id: prjId, title: "notif", content: "x" } } }) });
  ok("mcp id-less tools/call → 202 (not executed)", mcpNotif.status === 202);
  const notifCheck = await api(MEM2, "GET", `/api/projects/${prjId}/entries?limit=50`);
  ok("id-less tools/call created nothing", notifCheck.status === 200 && !notifCheck.data.some((e) => e.title === "notif"));
  const badArgs = await mcp(MEM2, "tools/call", { name: "log_progress", arguments: { project_id: prjId, title: "no content" } });
  ok("mcp missing required arg → isError", badArgs.data.result?.isError === true && badArgs.data.result.content[0].text.includes("content"));
  const badType = await mcp(MEM2, "tools/call", { name: "update_stage", arguments: { project_id: prjId, stage: "experiment", set_current: "true" } });
  ok("mcp wrong arg type → isError", badType.data.result?.isError === true);
  const stageAlias = await api(MEM2, "PUT", `/api/projects/${prjId}/stages/writing`, { status: "doing" });
  ok("status=doing alias moves current stage (compat)", stageAlias.status === 200 && stageAlias.data.stage === "writing");
  await api(MEM2, "POST", `/api/projects/${prjId}/advance`, { to: "experiment" });
  const missingPrompt = await mcp(MEM2, "prompts/get", { name: "weekly_review", arguments: {} });
  ok("prompt missing required arg → -32602", missingPrompt.data.error?.code === -32602);
  const badEnc = await fetch(BASE + "/api/projects/%E0%A4%A", { headers: { Authorization: `Bearer ${MEM2}` } });
  ok("bad percent-encoding → 400", badEnc.status === 400);
  // 탈퇴자 차단
  const rmMem = await api(ADMIN, "DELETE", `/api/admin/users/${memId}/memberships/${catId}`);
  ok("admin removes membership", rmMem.status === 200);
  const exEdit = await api(MEM2, "PATCH", `/api/entries/${e1Id}`, { title: "탈퇴 후 수정" });
  ok("ex-member cannot edit own entry", exEdit.status === 403);
  const exProj = await api(MEM2, "PATCH", `/api/projects/${prjId}`, { title: "탈퇴 후 수정" });
  ok("ex-member cannot edit own project", exProj.status === 403);
  const stillTitle = await api(ADMIN, "GET", `/api/entries/${e1Id}`);
  ok("entry unchanged after ex-member attempt", stillTitle.data.title === "첫 실험");
  await api(ADMIN, "PUT", `/api/admin/users/${memId}/memberships/${catId}`, { role: "member" });

  // 발급 신청 → 승인 → 수령 흐름
  const pubCfg = await fetch(BASE + "/api/public/config").then((r) => r.json());
  ok("public config lists categories", Array.isArray(pubCfg.categories) && typeof pubCfg.signup_enabled === "boolean");
  const reqBody = { name: `신청자${ts}`, email: `applicant-${ts}@example.org`, category_id: catId, note: "석사 1년차" };
  const reqRes = await fetch(BASE + "/api/public/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
  const req1 = await reqRes.json();
  ok("public signup request created", reqRes.status === 201 && req1.claim_code?.startsWith("clm_"), JSON.stringify(req1));
  const dupReq = await fetch(BASE + "/api/public/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(reqBody) });
  ok("duplicate pending email rejected", dupReq.status === 400);
  const st1 = await fetch(BASE + `/api/public/requests/${req1.claim_code}`).then((r) => r.json());
  ok("request status pending", st1.status === "pending" && st1.claimed === false);
  const earlyClaim = await fetch(BASE + `/api/public/requests/${req1.claim_code}/claim`, { method: "POST" });
  ok("claim before approval → 409", earlyClaim.status === 409);
  const badClaim = await fetch(BASE + `/api/public/requests/clm_nope/claim`, { method: "POST" });
  ok("unknown claim code → 404", badClaim.status === 404);
  const pendingList = await api(ADMIN, "GET", "/api/admin/requests?status=pending");
  ok("admin sees pending request (no claim hash)", pendingList.status === 200 && pendingList.data.some((r) => r.id === req1.id) && !pendingList.data.some((r) => r.claim_hash));
  const memList = await api(MEM2, "GET", "/api/admin/requests");
  ok("member cannot list requests", memList.status === 403);
  const approve = await api(ADMIN, "POST", `/api/admin/requests/${req1.id}/approve`, { role: "member" });
  ok("admin approves request → user created", approve.status === 200 && approve.data.user?.id && approve.data.user.memberships?.some((m) => m.category_id === catId), JSON.stringify(approve.data).slice(0, 200));
  const st2 = await fetch(BASE + `/api/public/requests/${req1.claim_code}`).then((r) => r.json());
  ok("request status approved", st2.status === "approved" && st2.claimed === false);
  const claimRes = await fetch(BASE + `/api/public/requests/${req1.claim_code}/claim`, { method: "POST" });
  const claimed = await claimRes.json();
  ok("claim returns token once", claimRes.status === 200 && claimed.token?.startsWith("rn_"), JSON.stringify(claimed).slice(0, 120));
  const claimAgain = await fetch(BASE + `/api/public/requests/${req1.claim_code}/claim`, { method: "POST" });
  ok("second claim → 409", claimAgain.status === 409);
  const newMe = await api(claimed.token, "GET", "/api/me");
  ok("claimed token logs in with membership", newMe.status === 200 && newMe.data.memberships.some((m) => m.category_id === catId));
  const req2Res = await fetch(BASE + "/api/public/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `거절자${ts}`, category_id: catId }) });
  const req2 = await req2Res.json();
  const reject = await api(ADMIN, "POST", `/api/admin/requests/${req2.id}/reject`, { reason: "소속 확인 불가" });
  ok("admin rejects request", reject.status === 200);
  const st3 = await fetch(BASE + `/api/public/requests/${req2.claim_code}`).then((r) => r.json());
  ok("rejected status visible with reason", st3.status === "rejected" && st3.decision_note === "소속 확인 불가");
  const reApprove = await api(ADMIN, "POST", `/api/admin/requests/${req2.id}/approve`, {});
  ok("cannot approve a rejected request", reApprove.status === 400);
  const delPending = await api(ADMIN, "DELETE", `/api/admin/requests/${req2.id}`);
  ok("delete decided request", delPending.status === 200);
  const connect = await fetch(BASE + "/connect");
  const connectText = await connect.text();
  ok("GET /connect agent guide", connect.status === 200 && connectText.includes("/api/public/requests") && connectText.includes("claude mcp add") && connectText.includes(BASE));
  // 팀 로비 · 가입 흐름
  const NEW = claimed.token;
  const openCat = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-open-${ts}`, join_policy: "open" });
  const closedCat = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-closed-${ts}`, join_policy: "closed" });
  ok("categories with join_policy", openCat.data.join_policy === "open" && closedCat.data.join_policy === "closed");
  const lobby = await api(NEW, "GET", "/api/lobby");
  ok("lobby lists teams with my_role", lobby.status === 200 && lobby.data.find((t) => t.id === catId)?.my_role === "member" && lobby.data.find((t) => t.id === openCat.data.id)?.my_role === null);
  const joinOpen = await api(NEW, "POST", `/api/lobby/${openCat.data.id}/join`, {});
  ok("open team → immediate join", joinOpen.status === 200 && joinOpen.data.joined === true);
  const meAfter = await api(NEW, "GET", "/api/me");
  ok("membership visible after join (multi-team)", meAfter.data.memberships.length === 2);
  const joinClosed = await api(NEW, "POST", `/api/lobby/${closedCat.data.id}/join`, {});
  ok("closed team → 403", joinClosed.status === 403);
  const adminLobby = await api(ADMIN, "GET", "/api/lobby");
  const adminView = adminLobby.data.find((t) => t.id === closedCat.data.id);
  ok("admin lobby shows my_role=admin but my_membership=null", adminView?.my_role === "admin" && adminView?.my_membership === null);
  const adminJoin = await api(ADMIN, "POST", `/api/lobby/${closedCat.data.id}/join`, { role: "lead" });
  ok("admin joins closed team as lead", adminJoin.status === 200 && adminJoin.data.joined === true && adminJoin.data.role === "lead");
  const adminLobby2 = await api(ADMIN, "GET", "/api/lobby");
  ok("admin now listed as lead member", adminLobby2.data.find((t) => t.id === closedCat.data.id)?.my_membership === "lead");
  await api(ADMIN, "DELETE", `/api/admin/users/${(await api(ADMIN, "GET", "/api/me")).data.user.id}/memberships/${closedCat.data.id}`);
  // 승인 정책 팀: 외부인(재활성화)로 요청 → 리드 승인
  await api(ADMIN, "PATCH", `/api/admin/users/${other.data.user.id}`, { disabled: false });
  const OUT2 = (await api(ADMIN, "POST", "/api/admin/tokens", { user_id: other.data.user.id, label: "lobby" })).data.token;
  const joinReq = await api(OUT2, "POST", `/api/lobby/${catId}/join`, { message: "같이 연구하고 싶습니다" });
  ok("approval team → pending request", joinReq.status === 200 && joinReq.data.pending === true && joinReq.data.request_id);
  const dupJoin = await api(OUT2, "POST", `/api/lobby/${catId}/join`, {});
  ok("duplicate join request → 400", dupJoin.status === 400);
  const lobby2 = await api(OUT2, "GET", "/api/lobby");
  ok("lobby shows my pending request", lobby2.data.find((t) => t.id === catId)?.my_request_status === "pending");
  const memSees = await api(NEW, "GET", `/api/join-requests?category_id=${catId}`);
  ok("member cannot list team join requests", memSees.status === 403);
  const leadSees = await api(LEAD, "GET", `/api/join-requests?category_id=${catId}`);
  ok("lead lists pending join requests", leadSees.status === 200 && leadSees.data.some((r) => r.id === joinReq.data.request_id));
  const teamDetail = await api(LEAD, "GET", `/api/categories/${catId}`);
  ok("team detail shows join_requests for lead", (teamDetail.data.join_requests || []).some((r) => r.id === joinReq.data.request_id));
  const memApproves = await api(NEW, "POST", `/api/join-requests/${joinReq.data.request_id}/approve`, {});
  ok("member cannot approve join", memApproves.status === 403);
  const leadApproves = await api(LEAD, "POST", `/api/join-requests/${joinReq.data.request_id}/approve`, { note: "환영" });
  ok("lead approves join → membership", leadApproves.status === 200 && leadApproves.data.status === "approved");
  const outMe = await api(OUT2, "GET", "/api/me");
  ok("joined user now member", outMe.data.memberships.some((m) => m.category_id === catId));
  const outProj = await api(OUT2, "GET", `/api/projects/${prjId}`);
  ok("joined user can read team project", outProj.status === 200);
  const leaveBlocked = await api(MEM2, "DELETE", `/api/lobby/${catId}/join`);
  ok("owner with active project cannot leave", leaveBlocked.status === 400);
  const leaveOk = await api(OUT2, "DELETE", `/api/lobby/${catId}/join`);
  ok("member without projects can leave", leaveOk.status === 200 && leaveOk.data.left === true);
  const mcpTeams = await mcp(NEW, "tools/call", { name: "list_teams", arguments: {} });
  ok("mcp list_teams", mcpTeams.data.result?.content?.[0]?.text?.includes(openCat.data.name));
  // 캡스톤 트랙 · 협업자 · 평가자 · 평가
  const capCat = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-capstone-${ts}`, track: "capstone", join_policy: "open" });
  ok("capstone category created", capCat.status === 201 && capCat.data.track === "capstone");
  const badTrack = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-badtrack-${ts}`, track: "nope" });
  ok("unknown track → 400", badTrack.status === 400);
  const evalUser = await api(ADMIN, "POST", "/api/admin/users", { name: `평가자${ts}`, categories: [{ category_id: capCat.data.id, role: "evaluator" }], issue_token: true });
  const evalUser2 = await api(ADMIN, "POST", "/api/admin/users", { name: `평가자B${ts}`, categories: [{ category_id: capCat.data.id, role: "evaluator" }], issue_token: true });
  ok("evaluator users created (multiple)", evalUser.status === 201 && evalUser2.status === 201 && evalUser.data.user.memberships[0].role === "evaluator");
  const EVA = evalUser.data.token, EVB = evalUser2.data.token;
  await api(NEW, "POST", `/api/lobby/${capCat.data.id}/join`, {});
  await api(ADMIN, "PUT", `/api/admin/users/${other.data.user.id}/memberships/${capCat.data.id}`, { role: "member" });
  await api(ADMIN, "PATCH", `/api/admin/users/${other.data.user.id}`, { disabled: false });
  const capPrj = await api(NEW, "POST", "/api/projects", { category_id: capCat.data.id, title: `캡스톤 팀 프로젝트 ${ts}`, summary: "위치기반 서비스" });
  ok("capstone project starts at topic with capstone stages", capPrj.status === 201 && capPrj.data.track === "capstone" && capPrj.data.stage === "topic" && capPrj.data.stages.map((s) => s.stage).join(",") === "topic,market,mvp,feedback,business,final");
  const capId = capPrj.data.id;
  const paperStage = await api(NEW, "POST", `/api/projects/${capId}/entries`, { title: "x", content: "y", stage: "experiment" });
  ok("paper stage rejected on capstone project", paperStage.status === 400);
  const capEntry = await api(NEW, "POST", `/api/projects/${capId}/entries`, { title: "루프 0: 문제 정의", content: "## 한 일\n- 고객 인터뷰 5명", stage: "topic" });
  ok("capstone entry with capstone stage", capEntry.status === 201);
  const evalCreatesProject = await api(EVA, "POST", "/api/projects", { category_id: capCat.data.id, title: "평가자 프로젝트" });
  ok("evaluator cannot create project", evalCreatesProject.status === 403);
  const evalWrites = await api(EVA, "POST", `/api/projects/${capId}/entries`, { title: "x", content: "y" });
  ok("evaluator cannot write entries", evalWrites.status === 403);
  const evalReads = await api(EVA, "GET", `/api/projects/${capId}`);
  ok("evaluator can read project (can_evaluate)", evalReads.status === 200 && evalReads.data.can_evaluate === true && evalReads.data.can_edit === false);
  // 협업자
  const collabBefore = await api(OUT2, "POST", `/api/projects/${capId}/entries`, { title: "before", content: "x" });
  ok("non-collaborator member cannot write", collabBefore.status === 403);
  const setCollab = await api(NEW, "PUT", `/api/projects/${capId}/collaborators`, { user_ids: [other.data.user.id] });
  ok("owner sets collaborators", setCollab.status === 200 && setCollab.data.collaborators.some((c) => c.id === other.data.user.id));
  const collabWrite = await api(OUT2, "POST", `/api/projects/${capId}/entries`, { title: "루프 1: MVP 배포", content: "https://example.com", stage: "mvp" });
  ok("collaborator can write entry", collabWrite.status === 201);
  const collabAdv = await api(OUT2, "POST", `/api/projects/${capId}/advance`, {});
  ok("collaborator can advance stage", collabAdv.status === 200 && collabAdv.data.stage === "market");
  const badCollab = await api(NEW, "PUT", `/api/projects/${capId}/collaborators`, { user_ids: [evalUser.data.user.id] });
  ok("evaluator cannot be collaborator", badCollab.status === 400);
  // 평가
  const evList0 = await api(NEW, "GET", `/api/projects/${capId}/evaluations`);
  ok("evaluations list has capstone rubric", evList0.status === 200 && evList0.data.rubric.some((r) => r.id === "improvement") && evList0.data.evaluations.length === 0);
  const memberEval = await api(OUT2, "POST", `/api/projects/${capId}/evaluations`, { feedback: "x" });
  ok("member cannot evaluate", memberEval.status === 403);
  const ev1 = await api(EVA, "POST", `/api/projects/${capId}/evaluations`, { stage: "market", title: "1차 보고서 평가", scores: { improvement: 20, achievement: 25, records: 15, viability: 10 }, feedback: "## 잘한 점\n- 린 캔버스 명확\n## 개선\n- TAM 근거 부족" });
  ok("evaluator A creates evaluation with total", ev1.status === 201 && ev1.data.total === 70 && ev1.data.max_total === 100, JSON.stringify(ev1.data).slice(0, 200));
  const ev2 = await api(EVB, "POST", `/api/projects/${capId}/evaluations`, { stage: "market", title: "1차 보고서 평가 (B)", scores: { improvement: 24, achievement: 20 }, feedback: "지표 정의 필요", visible: false });
  ok("evaluator B creates draft evaluation", ev2.status === 201 && ev2.data.visible === false && ev2.data.total === 44);
  const badScore = await api(EVA, "POST", `/api/projects/${capId}/evaluations`, { scores: { improvement: 99 } });
  ok("score over max → 400", badScore.status === 400);
  const teamList = await api(NEW, "GET", `/api/projects/${capId}/evaluations`);
  ok("team sees only visible evaluations, avg computed", teamList.data.evaluations.length === 1 && teamList.data.summary.market.avg_total === 70 && teamList.data.evaluations[0].can_respond === true);
  const evaList = await api(EVB, "GET", `/api/projects/${capId}/evaluations`);
  ok("evaluator sees drafts too", evaList.data.evaluations.length === 2);
  const resp = await api(OUT2, "POST", `/api/evaluations/${ev1.data.id}/respond`, { response: "TAM 근거를 통계청 자료로 보강하겠습니다" });
  ok("collaborator responds to evaluation", resp.status === 200 && resp.data.response.includes("통계청") && resp.data.response_by === other.data.user.id);
  const evalResponds = await api(EVA, "POST", `/api/evaluations/${ev1.data.id}/respond`, { response: "x" });
  ok("evaluator cannot respond", evalResponds.status === 403);
  const evbEditsA = await api(EVB, "PATCH", `/api/evaluations/${ev1.data.id}`, { feedback: "hack" });
  ok("evaluator B cannot edit A's evaluation", evbEditsA.status === 403);
  const publish = await api(EVB, "PATCH", `/api/evaluations/${ev2.data.id}`, { visible: true });
  ok("evaluator B publishes draft", publish.status === 200 && publish.data.visible === true);
  const teamList2 = await api(NEW, "GET", `/api/projects/${capId}/evaluations`);
  ok("two evaluators averaged", teamList2.data.evaluations.length === 2 && teamList2.data.summary.market.avg_total === 57);
  const capReport = await api(NEW, "GET", `/api/projects/${capId}/report?format=md`);
  ok("capstone report includes evaluations + response", capReport.status === 200 && capReport.data.includes("평가·피드백") && capReport.data.includes("통계청") && capReport.data.includes("캡스톤 트랙"));
  const mcpEval = await mcp(EVA, "tools/call", { name: "list_evaluations", arguments: { project_id: capId } });
  ok("mcp list_evaluations", mcpEval.data.result?.content?.[0]?.text?.includes("1차 보고서 평가"));
  const mcpAdvCap = await mcp(NEW, "tools/call", { name: "advance_stage", arguments: { project_id: capId, to: "mvp" } });
  ok("mcp advance_stage on capstone", mcpAdvCap.data.result?.structuredContent?.stage === "mvp");
  const mcpBadStage = await mcp(NEW, "tools/call", { name: "log_progress", arguments: { project_id: capId, title: "t", content: "c", stage: "writing" } });
  ok("mcp paper stage on capstone → isError", mcpBadStage.data.result?.isError === true);
  const trackChange = await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { track: "paper" });
  ok("track change blocked when projects exist", trackChange.status === 400);

  // 핀 열람 (공개 카테고리 · 읽기 전용 세션)
  const pubJson = async (method, path, body) => { const r = await fetch(BASE + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
  const pubBefore = await pubJson("GET", "/api/public/teams");
  ok("public teams excludes non-public capstone", pubBefore.status === 200 && !pubBefore.data.some((t) => t.id === capCat.data.id));
  const notPublicPin = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "1234" });
  ok("pin on non-public team → 404", notPublicPin.status === 404);
  const badPinFmt = await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { is_public: true, pin: "12" });
  ok("pin too short → 400", badPinFmt.status === 400);
  const setPub = await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { is_public: true, pin: "cap2026" });
  ok("admin enables public + pin (hash never returned)", setPub.status === 200 && setPub.data.is_public === 1 && setPub.data.pin_set === true && setPub.data.pin_hash === undefined, JSON.stringify(setPub.data).slice(0, 200));
  const catList = await api(ADMIN, "GET", "/api/admin/categories");
  ok("category list never leaks pin_hash", !JSON.stringify(catList.data).includes("pin_hash"));
  const pubAfter = await pubJson("GET", "/api/public/teams");
  ok("public teams lists public capstone", pubAfter.data.some((t) => t.id === capCat.data.id && t.track_label === "캡스톤"));
  const wrongPin = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "nope1" });
  ok("wrong pin → 401 with attempts left", wrongPin.status === 401 && /남은 시도/.test(wrongPin.data.message));
  const okPin = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "cap2026", label: "심사위원" });
  ok("correct pin → viewer token (rnv_) + 24h expiry", okPin.status === 200 && okPin.data.viewer_token?.startsWith("rnv_") && new Date(okPin.data.expires_at) - Date.now() > 23 * 3600e3, JSON.stringify(okPin.data).slice(0, 200));
  const VIEW = okPin.data.viewer_token;
  const vMe = await api(VIEW, "GET", "/api/me");
  ok("viewer /api/me marks viewer mode", vMe.status === 200 && vMe.data.viewer?.category_id === capCat.data.id && vMe.data.is_admin === false && vMe.data.memberships[0]?.role === "viewer" && vMe.data.user.name === "심사위원");
  const vProj = await api(VIEW, "GET", `/api/projects/${capId}`);
  ok("viewer reads public-team project (read-only flags)", vProj.status === 200 && vProj.data.can_edit === false && vProj.data.can_evaluate === false);
  const vOther = await api(VIEW, "GET", `/api/projects/${prjId}`);
  ok("viewer cannot read other team's project", vOther.status === 403);
  const vDetail = await api(VIEW, "GET", `/api/categories/${capCat.data.id}`);
  ok("viewer team detail hides emails, my_role=viewer", vDetail.status === 200 && vDetail.data.my_role === "viewer" && vDetail.data.members.every((m) => !m.email) && !JSON.stringify(vDetail.data.category).includes("pin_hash"));
  const vEvals = await api(VIEW, "GET", `/api/projects/${capId}/evaluations`);
  ok("viewer sees only visible evaluations", vEvals.status === 200 && vEvals.data.evaluations.every((e) => e.visible === true));
  const vLobby = await api(VIEW, "GET", "/api/lobby");
  ok("viewer lobby limited to own team", vLobby.status === 200 && vLobby.data.length === 1 && vLobby.data[0].id === capCat.data.id);
  const vReport = await api(VIEW, "GET", `/api/projects/${capId}/report?format=md`);
  ok("viewer can get report", vReport.status === 200 && vReport.data.includes("캡스톤"));
  const vWrite = await api(VIEW, "POST", `/api/projects/${capId}/entries`, { title: "x", content: "y" });
  ok("viewer POST entry → 403", vWrite.status === 403);
  const vTask = await api(VIEW, "POST", `/api/projects/${capId}/tasks`, { title: "x" });
  ok("viewer POST task → 403", vTask.status === 403);
  const vComment = await api(VIEW, "POST", `/api/entries/${capEntry.data.id}/comments`, { content: "x" });
  ok("viewer POST comment → 403", vComment.status === 403);
  const vJoin = await api(VIEW, "POST", `/api/lobby/${capCat.data.id}/join`, {});
  ok("viewer join → 403", vJoin.status === 403);
  const vAdmin = await api(VIEW, "GET", "/api/admin/overview");
  ok("viewer admin → 403", vAdmin.status === 403);
  const vInit = await mcp(VIEW, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  ok("mcp initialize warns viewer mode", vInit.status === 200 && vInit.data.result?.instructions?.includes("읽기 전용"));
  const vWho = await mcp(VIEW, "tools/call", { name: "whoami", arguments: {} });
  ok("mcp whoami works for viewer", vWho.data.result?.isError !== true && vWho.data.result?.content?.[0]?.text?.includes("열람 모드"));
  const vGet = await mcp(VIEW, "tools/call", { name: "get_project", arguments: { project_id: capId } });
  ok("mcp get_project works for viewer", vGet.data.result?.isError !== true && vGet.data.result?.content?.[0]?.text?.includes("캡스톤 팀 프로젝트"));
  const vLog = await mcp(VIEW, "tools/call", { name: "log_progress", arguments: { project_id: capId, title: "t", content: "c" } });
  ok("mcp log_progress blocked for viewer", vLog.data.result?.isError === true && vLog.data.result.content[0].text.includes("읽기 전용"));
  // 핀 변경 → 기존 세션 무효
  const rePin = await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { pin: "newpin9" });
  ok("admin rotates pin", rePin.status === 200 && rePin.data.pin_set === true);
  const vAfterRotate = await api(VIEW, "GET", "/api/me");
  ok("old viewer token invalid after pin change", vAfterRotate.status === 401);
  const oldPin = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "cap2026" });
  ok("old pin rejected", oldPin.status === 401);
  const okPin2 = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "newpin9" });
  ok("new pin works", okPin2.status === 200 && okPin2.data.viewer_token);
  const revokeAll = await api(ADMIN, "POST", `/api/admin/categories/${capCat.data.id}/viewers/revoke`);
  ok("admin revokes viewer sessions", revokeAll.status === 200 && revokeAll.data.revoked >= 1);
  const vAfterRevoke = await api(okPin2.data.viewer_token, "GET", "/api/me");
  ok("revoked viewer token → 401", vAfterRevoke.status === 401);
  const okPin3 = await pubJson("POST", `/api/public/teams/${capCat.data.id}/pin`, { pin: "newpin9" });
  const unpub = await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { is_public: false });
  ok("admin disables public", unpub.status === 200 && unpub.data.is_public === 0);
  const vAfterUnpub = await api(okPin3.data.viewer_token, "GET", "/api/me");
  ok("viewer token invalid after public off", vAfterUnpub.status === 401);
  const pubGone = await pubJson("GET", "/api/public/teams");
  ok("public teams no longer lists it", !pubGone.data.some((t) => t.id === capCat.data.id));
  // 잠금: 별도 카테고리에서 5회 실패
  const lockCat = await api(ADMIN, "POST", "/api/admin/categories", { name: `smoke-lock-${ts}`, is_public: true, pin: "lock42" });
  ok("category created public with pin", lockCat.status === 201 && lockCat.data.pin_set === true && lockCat.data.is_public === 1);
  let lockStatus = 0;
  for (let i = 0; i < 5; i++) lockStatus = (await pubJson("POST", `/api/public/teams/${lockCat.data.id}/pin`, { pin: "wrong" + i })).status;
  ok("5th wrong pin → 429 lock", lockStatus === 429);
  const lockedRight = await pubJson("POST", `/api/public/teams/${lockCat.data.id}/pin`, { pin: "lock42" });
  ok("correct pin while locked → 429", lockedRight.status === 429);
  await api(ADMIN, "PATCH", `/api/admin/categories/${lockCat.data.id}`, { archived: true });
  await api(ADMIN, "DELETE", `/api/projects/${capId}`);
  await api(ADMIN, "PATCH", `/api/admin/categories/${capCat.data.id}`, { archived: true });
  await api(ADMIN, "PATCH", `/api/admin/users/${evalUser.data.user.id}`, { disabled: true });
  await api(ADMIN, "PATCH", `/api/admin/users/${evalUser2.data.user.id}`, { disabled: true });
  await api(ADMIN, "PATCH", `/api/admin/categories/${openCat.data.id}`, { archived: true });
  await api(ADMIN, "PATCH", `/api/admin/categories/${closedCat.data.id}`, { archived: true });
  await api(ADMIN, "PATCH", `/api/admin/users/${approve.data.user.id}`, { disabled: true });
  await api(ADMIN, "PATCH", `/api/admin/users/${other.data.user.id}`, { disabled: true });

  // 정리
  const arch = await api(ADMIN, "DELETE", `/api/projects/${prjId}`);
  ok("archive project", arch.status === 200);
  const archivedWrite = await api(MEM2, "POST", `/api/projects/${prjId}/entries`, { title: "after archive", content: "x" });
  ok("archived project rejects entries", archivedWrite.status === 403);
  const carch = await api(ADMIN, "PATCH", `/api/admin/categories/${catId}`, { archived: true });
  ok("archive category", carch.status === 200);
  void leadId;

  console.log(results.join("\n"));
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed (${BASE})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(results.join("\n"));
  console.error("\n예외:", e);
  process.exit(1);
});
