// 공지: 홈 상단 카드 + 팀 페이지 [공지] 탭 + 작성/수정 다이얼로그
import { state, get, post, patch, del, h, mount, pill, avatar, mdEl, fmtDT, fmtRel, input, textarea, select, field, modal, confirmDialog, toast, errToast } from "../core.js";

/** 내가 공지를 올릴 수 있는 대상 목록 [{value, label}] (관리자: 전체 + 모든 소속, 리드: 리드인 팀) */
export function manageableTargets(me, extraCategory) {
  const out = [];
  if (me?.is_admin) out.push({ value: "", label: "전체 공지 (모든 팀)" });
  for (const m of me?.memberships || []) if (me.is_admin || m.role === "lead") out.push({ value: m.category_id, label: m.category_name });
  if (extraCategory && me?.is_admin && !out.some((o) => o.value === extraCategory.id)) out.push({ value: extraCategory.id, label: extraCategory.name });
  return out;
}

/** 공지 한 건 카드. expanded=false 면 제목만 보이고 클릭해서 펼친다 */
export function noticeCard(n, { expanded = false, onChanged } = {}) {
  const body = h("div.notice-body", { hidden: !expanded }, mdEl(n.content || "_(본문 없음)_"));
  const toggle = h("button.notice-toggle", { type: "button", "aria-expanded": String(expanded) }, expanded ? "접기" : "펼치기");
  const card = h("div.card.notice" + (n.pinned ? ".pinned" : "") + (n.archived_at ? ".archived" : ""),
    h("div.row.top", { style: { gap: "10px" } },
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div.row", { style: { gap: "6px", flexWrap: "wrap" } },
          n.pinned ? pill("고정", "gold sm") : null,
          pill(n.category_name || "전체 공지", n.category_name ? "sm" : "navy sm"),
          n.archived_at ? pill("내림", "mute sm") : null,
          h("b.notice-title", { onclick: () => toggle.click(), style: { cursor: "pointer" } }, n.title),
        ),
        h("div.tiny.muted", { style: { marginTop: "3px" } }, h("span.row", { style: { gap: "5px", display: "inline-flex" } }, avatar(n.author_name), n.author_name), ` · ${fmtDT(n.created_at)}`, n.updated_at !== n.created_at ? ` · 수정 ${fmtRel(n.updated_at)}` : ""),
      ),
      h("div.row", { style: { gap: "6px", flex: "none" } },
        n.can_edit && !state.me?.viewer ? h("button.btn.sm", { onclick: () => noticeDialog({ notice: n, onSaved: onChanged }) }, "수정") : null,
        toggle,
      ),
    ),
    body,
  );
  toggle.addEventListener("click", () => { const open = body.hidden; body.hidden = !open; toggle.textContent = open ? "접기" : "펼치기"; toggle.setAttribute("aria-expanded", String(open)); });
  return card;
}

/** 공지 목록 (고정 먼저). 없으면 안내 */
export function noticeList(rows, { expandPinned = true, onChanged, emptyText = "공지가 없습니다" } = {}) {
  if (!rows.length) return h("div.empty", emptyText);
  return h("div.stack", rows.map((n, i) => noticeCard(n, { expanded: expandPinned ? !!n.pinned || (i === 0 && !rows.some((x) => x.pinned)) : false, onChanged })));
}

/** 작성/수정 다이얼로그. notice 가 있으면 수정 */
export function noticeDialog({ notice, categoryId, categoryName, onSaved } = {}) {
  const me = state.me;
  const targets = manageableTargets(me, categoryId ? { id: categoryId, name: categoryName || categoryId } : null);
  if (!notice && !targets.length) { toast("공지를 올릴 수 있는 팀이 없습니다 (관리자 또는 리드만)", true); return; }
  const target = notice ? null : select(targets, { value: categoryId ?? (targets[0]?.value ?? "") });
  const title = input({ placeholder: "예: 발표 준비 안내 (단계별)", maxlength: 200, value: notice?.title || "" });
  const content = textarea({ rows: 14, placeholder: "마크다운으로 작성합니다.\n\n## 소제목\n- 항목\n- **강조**, `코드`, 표(|), 링크(https://…) 지원", value: notice?.content || "" });
  const pinned = h("input", { type: "checkbox", checked: !!notice?.pinned });
  const preview = h("div.md.notice-preview", { hidden: true });
  const previewBtn = h("button.btn.sm", { type: "button", onclick: () => { preview.hidden = !preview.hidden; if (!preview.hidden) mount(preview, mdEl(content.value || "_(본문 없음)_")); previewBtn.textContent = preview.hidden ? "미리보기" : "편집으로"; content.hidden = !preview.hidden; } }, "미리보기");
  const actions = [{ label: "취소" }];
  if (notice) {
    actions.push({ label: notice.archived_at ? "다시 올리기" : "내리기", cls: "danger", onClick: async () => {
      if (!notice.archived_at && !(await confirmDialog("이 공지를 내릴까요? 목록에서 사라지며 관리자·리드는 [내린 공지 보기]로 되살릴 수 있습니다.", { danger: true, okLabel: "내리기" }))) return false;
      await patch(`/api/notices/${notice.id}`, { archived: !notice.archived_at });
      toast(notice.archived_at ? "공지를 다시 올렸습니다" : "공지를 내렸습니다");
      onSaved?.();
    } });
  }
  actions.push({ label: notice ? "저장" : "게시", cls: "primary", onClick: async () => {
    if (!title.value.trim()) { toast("제목을 입력하세요", true); title.focus(); return false; }
    try {
      if (notice) await patch(`/api/notices/${notice.id}`, { title: title.value.trim(), content: content.value, pinned: pinned.checked });
      else await post("/api/notices", { category_id: target.value || null, title: title.value.trim(), content: content.value, pinned: pinned.checked });
      toast(notice ? "공지를 저장했습니다" : "공지를 올렸습니다");
      onSaved?.();
    } catch (e) { errToast(e); return false; }
  } });
  modal({
    title: notice ? "공지 수정" : "공지 올리기",
    wide: true,
    body: h("div.stack",
      notice ? h("p.small.muted", `대상: ${notice.category_name || "전체 공지"} · 작성 ${fmtDT(notice.created_at)}`) : field("대상", target, "전체 공지는 관리자만, 팀 공지는 관리자 또는 그 팀의 리드가 올릴 수 있습니다."),
      field("제목", title),
      h("div.row.between", h("label.check", pinned, "상단 고정 (팀 페이지 상단 띠 + 목록 맨 위)"), previewBtn),
      field("본문 (마크다운)", h("div", content, preview)),
      h("p.help", "학생의 AI 도구도 list_notices 로 이 공지를 읽습니다. 발표 형식·제출 요령처럼 AI 가 따라야 할 요구사항은 문장으로 분명하게 적어주세요."),
    ),
    actions,
  });
}

/** 홈용: 전체 + 소속 팀 공지 카드 (고정·최신 N건) */
export async function homeNoticeCard(me, { limit = 6 } = {}) {
  let rows = [];
  try { rows = await get(`/api/notices?limit=${limit}`); } catch (e) { return null; }
  const canPost = manageableTargets(me).length > 0 && !me.viewer;
  if (!rows.length && !canPost) return null;
  const wrap = h("div.card.notice-wrap");
  const refresh = async () => { rows = await get(`/api/notices?limit=${limit}`); draw(); };
  const draw = () => mount(wrap,
    h("div.section-h", h("h2", "공지"), h("p.sub", rows.length ? `${rows.length}건` : "새 공지 없음"), h("span.spacer"),
      canPost ? h("button.btn.sm", { onclick: () => noticeDialog({ onSaved: refresh }) }, "+ 공지 올리기") : null),
    noticeList(rows, { onChanged: refresh, emptyText: "아직 공지가 없습니다. [+ 공지 올리기]로 첫 공지를 남기세요." }),
  );
  draw();
  return wrap;
}

/** 팀 페이지 [공지] 탭 본문 */
export async function teamNoticeView(detail, categoryId) {
  const canPost = detail.my_role === "admin" || detail.my_role === "lead";
  let showArchived = false;
  const wrap = h("div");
  const load = async () => {
    const rows = await get(`/api/notices?category_id=${encodeURIComponent(categoryId)}&limit=100${showArchived ? "&archived=1" : ""}`);
    mount(wrap,
      h("div.row.between", { style: { marginBottom: "12px" } },
        h("p.small.muted", { style: { margin: 0 } }, canPost ? "관리자·리드가 올린 안내가 팀원과 팀원의 AI 도구(list_notices)에 보입니다." : "관리자·리드의 안내입니다. AI 도구에게 \"공지 읽어줘\" 라고 하면 같은 내용을 읽습니다."),
        h("div.row", { style: { gap: "8px" } },
          canPost ? h("label.check.small", h("input", { type: "checkbox", checked: showArchived, onchange: (e) => { showArchived = e.target.checked; load(); } }), "내린 공지 보기") : null,
          canPost ? h("button.btn.sm.primary", { onclick: () => noticeDialog({ categoryId, categoryName: detail.category.name, onSaved: load }) }, "+ 공지 올리기") : null,
        ),
      ),
      noticeList(rows, { onChanged: load, emptyText: canPost ? "아직 공지가 없습니다. [+ 공지 올리기]로 발표 준비 안내 같은 것을 남기세요." : "아직 공지가 없습니다." }),
    );
  };
  mount(wrap, h("div.loading", h("span.spinner"), " 불러오는 중…"));
  await load();
  return wrap;
}

/** 팀 페이지 상단 띠: 고정 공지 제목만 (클릭 → 공지 탭) */
export function pinnedStrip(rows, categoryId) {
  const pinned = rows.filter((n) => n.pinned && !n.archived_at);
  if (!pinned.length) return null;
  return h("div.notice-strip", pinned.slice(0, 3).map((n) => h("a", { href: `#/team/${categoryId}?view=notices` }, "📌 ", h("b", n.title), n.category_name ? null : pill("전체", "navy sm"))));
}
