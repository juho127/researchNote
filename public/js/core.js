// 연구노트 프론트 공통 모듈: API 클라이언트 · 상태 · DOM 헬퍼 · 마크다운 · 모달/토스트
const TOKEN_KEY = "rn.token";

export const state = { me: null, token: null };

export function getToken() {
  if (state.token) return state.token;
  try { state.token = localStorage.getItem(TOKEN_KEY) || null; } catch { state.token = null; }
  return state.token;
}
export function setToken(t) {
  state.token = t;
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {}
}
export function logout() {
  const wasViewer = isViewerToken();
  setToken(null);
  state.me = null;
  location.hash = wasViewer ? "#/view" : "#/login";
}
/** 핀 열람 세션 토큰(rnv_)인지 */
export function isViewerToken() { const t = getToken(); return !!t && t.startsWith("rnv_"); }

export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export async function api(method, path, body, opts = {}) {
  const headers = { "X-Client": "web" };
  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (opts.raw) return r;
  const ct = r.headers.get("content-type") || "";
  const data = ct.includes("application/json") ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !opts.noRedirect) {
      const viewer = isViewerToken();
      setToken(null); state.me = null;
      if (viewer) { if (!location.hash.startsWith("#/view")) location.hash = "#/view?expired=1"; }
      else if (location.hash !== "#/login") location.hash = "#/login";
    }
    throw new ApiError(r.status, data?.error || "error", data?.message || (typeof data === "string" ? data.slice(0, 200) : `HTTP ${r.status}`));
  }
  return data;
}
export const get = (p) => api("GET", p);
export const post = (p, b) => api("POST", p, b ?? {});
export const patch = (p, b) => api("PATCH", p, b);
export const put = (p, b) => api("PUT", p, b);
export const del = (p) => api("DELETE", p);

export async function loadMe(opts = {}) {
  state.me = await api("GET", "/api/me", undefined, opts);
  state._stageMap = null;
  return state.me;
}

// ---------- DOM ----------
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** h("div.card.pad", {onclick, ...attrs}, ...children) */
export function h(sel, attrs, ...children) {
  const [tag, ...classes] = sel.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs && typeof attrs === "object" && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") el.innerHTML = v;
      else if (k === "value") { el.value = v; if (tag === "input") el.setAttribute("value", v); }
      else if (k === "class") el.className += (el.className ? " " : "") + v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k in el && typeof v !== "string") el[k] = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  } else if (attrs !== undefined) children.unshift(attrs);
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }
export function frag(...children) { const f = document.createDocumentFragment(); append(f, children); return f; }

// ---------- 포맷 ----------
export function today() {
  const tz = state.me?.app?.tz || "Asia/Seoul";
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const g = (t) => p.find((x) => x.type === t).value;
    return `${g("year")}-${g("month")}-${g("day")}`;
  } catch { return new Date().toISOString().slice(0, 10); }
}
export function daysAgo(n) {
  const d = new Date(Date.now() - n * 864e5);
  return d.toISOString().slice(0, 10);
}
export function fmtDT(iso) {
  if (!iso) return "";
  try { return new Intl.DateTimeFormat("ko-KR", { timeZone: state.me?.app?.tz || "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso)); } catch { return iso; }
}
export function fmtRel(iso) {
  if (!iso) return "기록 없음";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const hh = Math.floor(m / 60);
  if (hh < 24) return `${hh}시간 전`;
  const d = Math.floor(hh / 24);
  if (d < 30) return `${d}일 전`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}개월 전`;
  return `${Math.floor(mo / 12)}년 전`;
}
export function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
}
export function weekday(dateStr) {
  try { return ["일", "월", "화", "수", "목", "금", "토"][new Date(dateStr + "T00:00:00").getDay()] + "요일"; } catch { return ""; }
}
export function initials(name) {
  const s = String(name || "?").trim();
  return /^[A-Za-z]/.test(s) ? s.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() : s.slice(0, 2);
}

export const STATUS_LABEL = { active: "진행 중", paused: "일시 중지", done: "완료", archived: "보관" };
export const STAGE_STATUS_LABEL = { todo: "예정", doing: "진행 중", done: "완료" };
export const REVIEW_LABEL = { none: "", requested: "검토 요청", changes_requested: "수정 요청", approved: "승인" };
export const REVIEW_CLASS = { requested: "bad", changes_requested: "warn", approved: "ok" };
export const ACTION_LABEL = {
  "project.create": "프로젝트 생성", "project.update": "프로젝트 수정", "project.archive": "프로젝트 보관",
  "entry.create": "기록 추가", "entry.update": "기록 수정", "entry.delete": "기록 삭제",
  "stage.update": "단계 정리 갱신", "stage.advance": "단계 진행", "comment.create": "코멘트", "review.request": "검토 요청", "review.approve": "승인", "review.changes": "수정 요청", "review.clear": "검토 취소",
  "task.create": "할 일 추가", "task.update": "할 일 갱신", "task.delete": "할 일 삭제",
  "category.create": "카테고리 생성", "category.update": "카테고리 수정", "user.create": "연구원 등록", "user.update": "연구원 수정",
  "membership.set": "소속 변경", "membership.remove": "소속 해제", "token.issue": "토큰 발급", "token.revoke": "토큰 회수",
  "signup.request": "발급 신청", "signup.approve": "신청 승인", "signup.reject": "신청 거절", "signup.claim": "토큰 수령",
  "team.join": "팀 가입", "team.join_request": "팀 가입 요청", "team.join_approve": "가입 승인", "team.join_reject": "가입 거절", "team.leave": "팀 탈퇴",
  "evaluation.create": "평가 작성", "evaluation.update": "평가 수정", "evaluation.delete": "평가 삭제", "evaluation.respond": "평가 답변",
  "viewer.login": "핀 열람 시작",
};
/** 트랙 정의 {paper:{label,noun,stages[],rubric[]}, capstone:{...}} */
export function tracks() { return state.me?.tracks || {}; }
export function track(id) { return tracks()[id] || tracks().paper || { id: "paper", label: "논문", noun: "논문", stages: state.me?.stages || [], rubric: [] }; }
export const TRACK_LABEL = { paper: "논문", capstone: "캡스톤" };
/** 트랙의 단계 목록 (트랙 생략 시 논문) */
export function stages(trackId) { return track(trackId || "paper").stages || []; }
function allStageMap() {
  if (!state._stageMap) { state._stageMap = {}; for (const t of Object.values(tracks())) for (const s of t.stages) state._stageMap[s.id] = { ...s, track: t.id }; }
  return state._stageMap;
}
export function stageLabel(id) { return allStageMap()[id]?.label || (state.me?.stages || []).find((s) => s.id === id)?.label || id; }
export function stageHint(id) { return allStageMap()[id]?.hint || ""; }
export function stageMilestone(id) { return allStageMap()[id]?.milestone || ""; }
export function stageIndex(id, trackId) { const list = trackId ? stages(trackId) : stages(allStageMap()[id]?.track); return list.findIndex((s) => s.id === id); }
export const ROLE_LABEL = { admin: "관리자", lead: "리드", member: "구성원", evaluator: "평가자", viewer: "열람자" };

export function pill(text, cls = "") { return h("span.pill" + (cls ? "." + cls.split(" ").join(".") : ""), text); }
export function avatar(name, lg = false) { return h("span.avatar" + (lg ? ".lg" : ""), { title: name }, initials(name)); }

// ---------- 마크다운 (서버 렌더러와 동일 규칙) ----------
function inline(s) {
  // 코드 스팬은 먼저 떼어내 강조/링크 치환의 영향을 받지 않게 한다
  const codes = [];
  let t = esc(s).replace(/`([^`]+)`/g, (_m, c) => { codes.push(`<code>${c}</code>`); return ` ${codes.length - 1} `; });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, a, b) => `<a href="${b}" target="_blank" rel="noopener">${a}</a>`);
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  return t.replace(/ (\d+) /g, (_m, i) => codes[Number(i)]);
}
export function md(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0, list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) { close(); const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      close();
      const header = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      i += 2; const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())); i++; }
      out.push("<table><thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>" + rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
      continue;
    }
    const hd = line.match(/^(#{1,6})\s+(.*)$/);
    if (hd) { close(); const lvl = Math.min(6, hd[1].length + 2); out.push(`<h${lvl}>${inline(hd[2])}</h${lvl}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { close(); out.push("<hr>"); i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { close(); const buf = [bq[1]]; i++; while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, "")); out.push(`<blockquote>${buf.map(inline).join("<br>")}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const type = ul ? "ul" : "ol";
      if (list !== type) { close(); out.push(`<${type}>`); list = type; }
      if (ul && ul[1] !== undefined) { const ck = ul[1].toLowerCase() === "x"; out.push(`<li class="task${ck ? " done" : ""}"><input type="checkbox" disabled${ck ? " checked" : ""}> ${inline(ul[2])}</li>`); }
      else out.push(`<li>${inline(ul ? ul[2] : ol[1])}</li>`);
      i++; continue;
    }
    if (!line.trim()) { close(); i++; continue; }
    close();
    const buf = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  close();
  return out.join("\n");
}
export function mdEl(src, cls = "md") { return h("div." + cls, { html: md(src) }); }

// ---------- 토스트 / 모달 ----------
let toastTimer;
export function toast(msg, err = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), err ? 4200 : 2400);
}
export function errToast(e) { toast(e?.message || String(e), true); }

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const bg = h("div.modal-bg");
  const box = h("div.modal" + (wide ? ".wide" : ""));
  const close = () => { bg.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  // Escape 는 가장 위(마지막) 모달만 닫는다 (중첩 확인창에서 상위 모달까지 닫히지 않도록)
  const onKey = (e) => { if (e.key === "Escape") { const all = document.querySelectorAll(".modal-bg"); if (all[all.length - 1] === bg) close(); } };
  document.addEventListener("keydown", onKey);
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) close(); });
  box.append(h("button.x", { type: "button", onclick: close, "aria-label": "닫기" }, "×"));
  if (title) box.append(h("h2", title));
  const bodyEl = h("div.modal-body");
  append(bodyEl, [body]);
  box.append(bodyEl);
  if (actions.length) {
    const row = h("div.actions");
    for (const a of actions) {
      const b = h("button.btn" + (a.cls ? "." + a.cls : ""), { type: "button" }, a.label);
      b.addEventListener("click", async () => {
        if (a.onClick) {
          b.disabled = true;
          try { const r = await a.onClick({ close }); if (r !== false && a.closeAfter !== false) close(); } catch (e) { errToast(e); } finally { b.disabled = false; }
        } else close();
      });
      row.append(b);
    }
    box.append(row);
  }
  bg.append(box);
  document.body.append(bg);
  const first = box.querySelector("input,textarea,select");
  if (first) setTimeout(() => first.focus(), 30);
  return { close, box, body: bodyEl };
}
export function confirmDialog(message, { danger = false, okLabel = "확인" } = {}) {
  return new Promise((resolve) => {
    modal({
      title: "확인",
      body: h("p", message),
      actions: [{ label: "취소", onClick: () => resolve(false) }, { label: okLabel, cls: danger ? "danger" : "primary", onClick: () => resolve(true) }],
      onClose: () => resolve(false),
    });
  });
}

// ---------- 폼 헬퍼 ----------
export function field(label, input, help) {
  return h("label.field", h("span", label), input, help ? h("span.help", help) : null);
}
export function input(attrs = {}) { return h("input.input", { type: "text", ...attrs }); }
export function textarea(attrs = {}) { return h("textarea.input", attrs); }
export function select(options, attrs = {}) {
  const s = h("select.input", attrs);
  for (const o of options) s.append(h("option", { value: o.value, selected: o.value === attrs.value ? true : undefined, disabled: o.disabled }, o.label));
  return s;
}
export function stageSelect(value, extra = [], trackId) {
  return select([...extra, ...stages(trackId).map((s) => ({ value: s.id, label: `${s.label} · ${s.hint}` }))], { value });
}

// ---------- 보고서 열기/다운로드 ----------
export async function openReport(path) {
  const w = window.open("", "_blank");
  try {
    const r = await api("GET", path, undefined, { raw: true });
    if (!r.ok) throw new Error(`보고서 생성 실패 (${r.status})`);
    const html = await r.text();
    if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    else { const url = URL.createObjectURL(new Blob([html], { type: "text/html" })); window.open(url, "_blank"); }
  } catch (e) { w?.close(); errToast(e); }
}
export async function downloadFile(path, filename) {
  try {
    const r = await api("GET", path, undefined, { raw: true });
    if (!r.ok) throw new Error(`다운로드 실패 (${r.status})`);
    const blob = await r.blob();
    const a = h("a", { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { errToast(e); }
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("복사했습니다"); } catch { toast("복사 실패 — 직접 선택해 복사하세요", true); }
}

export function navigate(hash) { location.hash = hash; }
export function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  // 한글 팀 ID 등이 %-인코딩된 채 들어와도 내부 비교(active 메뉴 등)가 맞도록 디코딩
  const parts = pathPart.split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = Object.fromEntries(new URLSearchParams(queryPart || ""));
  return { parts, query, path: pathPart };
}
export function projectProgress(p) {
  const list = stages(p.track);
  const total = list.length || 6;
  const bar = h("div.progress");
  for (let i = 0; i < total; i++) {
    const id = list[i]?.id;
    const cls = i < p.stage_done ? "done" : id === p.stage ? "doing" : "";
    bar.append(h("i" + (cls ? "." + cls : ""), { title: stageLabel(id) }));
  }
  return bar;
}
