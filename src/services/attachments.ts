/**
 * 기록(entry) 이미지 첨부 — 이미지 본문은 R2(FILES_R2, 없으면 KV) 에, 메타는 D1 attachments 에 둔다.
 *
 * - 업로드: 기록 작성자 또는 프로젝트 편집 권한자(담당자·협업자·리드·관리자). PNG/JPEG/WebP/GIF/SVG, 파일당 5 MB, 기록당 20장.
 * - 본문 참조: `![설명](/files/<id>)`. 업로드 응답에 바로 붙일 수 있는 마크다운 스니펫을 함께 준다.
 * - 플레이스홀더: 본문에 `![설명](image:<파일명>)` 을 먼저 써 두고 그 파일명으로 업로드하면 서버가 /files/<id> 로 바꿔 준다
 *   (기록을 만든 뒤에야 entry_id 가 생기므로, 새 기록 + 그림을 한 번에 올릴 때 쓴다).
 * - 열람: /files/:id — 같은 카테고리 구성원·평가자·핀 열람 세션(기록 열람 정책과 동일) 또는 서명 URL.
 * - 삭제: 업로더 또는 리드·관리자. 본문의 참조 마크다운도 함께 지운다.
 */
import type { AuthContext, Env } from "../env";
import { categoryRole } from "../lib/auth";
import { getEntry, getProject, isCollaborator, logActivity, touchProject, type EntryRow, type ProjectRow } from "../lib/db";
import { SIGNED_URL_TTL_SEC, fileStore, signFileUrl } from "../lib/files";
import { HttpError, bad, forbidden, notFound, readJson, str } from "../lib/http";
import { newId } from "../lib/id";
import { nowIso } from "../lib/time";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PER_ENTRY = 20;
/** 허용 형식 → 저장 확장자 */
export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };
const EXT_TO_TYPE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

export interface AttachmentRow {
  id: string;
  entry_id: string;
  project_id: string;
  uploader_id: string;
  uploader_name: string;
  filename: string;
  content_type: string;
  size: number;
  caption: string;
  created_at: string;
  /** 본문에서 참조하는 경로 (토큰 또는 서명 URL 로 열람) */
  url: string;
  /** 본문에 붙일 마크다운 */
  markdown: string;
}
type Raw = Omit<AttachmentRow, "url" | "markdown"> & { r2_key: string };

const SELECT = `SELECT a.*, u.name AS uploader_name FROM attachments a JOIN users u ON u.id = a.uploader_id`;

export function fileUrl(id: string): string {
  return `/files/${id}`;
}
export function imageMarkdown(id: string, caption: string): string {
  return `![${(caption || "그림").replace(/[\[\]\n]/g, " ").trim()}](${fileUrl(id)})`;
}
function shape(r: Raw): AttachmentRow {
  const { r2_key, ...rest } = r;
  void r2_key;
  return { ...rest, url: fileUrl(r.id), markdown: imageMarkdown(r.id, r.caption || r.filename.replace(/\.[a-z0-9]+$/i, "")) };
}

async function getRaw(env: Env, id: string): Promise<Raw> {
  const r = await env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(id).first<Raw>();
  if (!r) notFound("첨부 파일을 찾을 수 없습니다");
  return r;
}

/** 첨부 추가 권한: 기록 작성자 또는 프로젝트 편집 권한자 (관리자·리드·담당자·협업자). 평가자·열람자 불가 */
async function canAttach(env: Env, ctx: AuthContext, e: EntryRow, p: ProjectRow): Promise<boolean> {
  if (ctx.viewer) return false;
  const role = categoryRole(ctx, p.category_id);
  if (!role || role === "evaluator") return false;
  if (role === "admin" || role === "lead") return true;
  if (e.author_id === ctx.user.id) return true;
  return p.owner_id === ctx.user.id || (await isCollaborator(env, p.id, ctx.user.id));
}

/** 파일 앞부분으로 실제 형식을 확인한다. 선언된 content_type/확장자와 내용이 다르면 400 */
function detectType(bytes: Uint8Array, declared: string, filename: string): string {
  const b = bytes;
  const ascii = (off: number, len: number) => String.fromCharCode(...b.slice(off, off + len));
  let actual: string | null = null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === "PNG") actual = "image/png";
  else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) actual = "image/jpeg";
  else if (b.length >= 6 && ascii(0, 4) === "GIF8") actual = "image/gif";
  else if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") actual = "image/webp";
  else {
    const head = new TextDecoder().decode(b.slice(0, 2048)).replace(/^﻿/, "").trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) actual = "image/svg+xml";
  }
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const wanted = IMAGE_TYPES[declared] ? declared : EXT_TO_TYPE[ext] ?? "";
  if (!actual) bad(`이미지 파일이 아닙니다 (허용: PNG, JPEG, WebP, GIF, SVG). 받은 형식: ${declared || ext || "알 수 없음"}`);
  if (wanted && wanted !== actual) bad(`파일 내용(${actual})이 선언된 형식(${wanted})과 다릅니다`);
  return actual!;
}

function safeFilename(v: unknown, ext: string): string {
  let name = str(v, 200).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^\.+/, "").trim();
  if (!name) name = `image.${ext}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${ext}`;
  return name;
}

/** `![..](image:<파일명>)` 플레이스홀더를 실제 경로로 바꾼다 */
export function replacePlaceholder(content: string, filename: string, url: string): { content: string; replaced: boolean } {
  const esc = filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = filename.replace(/\.[a-z0-9]+$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\]\\(\\s*(?:image|attach|img):(?:${esc}|${base})\\s*\\)`, "g");
  let replaced = false;
  const out = content.replace(re, () => { replaced = true; return `](${url})`; });
  return { content: out, replaced };
}

export interface UploadInput {
  filename?: unknown;
  content_type?: unknown;
  bytes: ArrayBuffer;
  caption?: unknown;
  /** 기본 true: 본문의 image:<파일명> 플레이스홀더를 /files/<id> 로 치환 */
  replace_placeholder?: boolean;
}

export interface UploadResult extends AttachmentRow {
  /** 본문의 플레이스홀더가 치환되었는지 */
  placeholder_replaced: boolean;
}

export async function upload(env: Env, ctx: AuthContext, entryId: string, input: UploadInput): Promise<UploadResult> {
  const e = await getEntry(env, entryId);
  const p = await getProject(env, e.project_id);
  if (!(await canAttach(env, ctx, e, p))) forbidden("첨부는 기록 작성자·프로젝트 담당자·협업자·리드·관리자만 올릴 수 있습니다");
  if (p.status === "archived") forbidden("보관된 프로젝트의 기록에는 첨부할 수 없습니다");
  const size = input.bytes.byteLength;
  if (size <= 0) bad("빈 파일입니다");
  if (size > MAX_IMAGE_BYTES) throw new HttpError(413, `이미지가 너무 큽니다 (${(size / 1024 / 1024).toFixed(1)} MB, 최대 ${MAX_IMAGE_BYTES / 1024 / 1024} MB). 해상도를 줄이거나 PNG→WebP/JPEG 로 바꿔 올리세요`, "too_large");
  const cnt = await env.DB.prepare(`SELECT COUNT(*) AS n FROM attachments WHERE entry_id = ?`).bind(entryId).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= MAX_PER_ENTRY) bad(`기록당 이미지는 최대 ${MAX_PER_ENTRY}장입니다`);
  const declared = str(input.content_type, 100).toLowerCase().split(";")[0].trim();
  const bytes = new Uint8Array(input.bytes);
  const type = detectType(bytes, declared, str(input.filename, 200));
  const ext = IMAGE_TYPES[type];
  const filename = safeFilename(input.filename, ext);
  const caption = str(input.caption, 300);
  const id = newId("att");
  const at = nowIso();
  const key = `att/${p.id}/${e.id}/${id}.${ext}`;
  await fileStore(env).put(key, input.bytes, type, { entry_id: e.id, project_id: p.id, filename, uploader: ctx.user.id });
  await env.DB
    .prepare(`INSERT INTO attachments (id, entry_id, project_id, uploader_id, filename, content_type, size, r2_key, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, e.id, p.id, ctx.user.id, filename, type, size, key, caption, at)
    .run();
  let placeholder_replaced = false;
  if (input.replace_placeholder !== false) {
    const r = replacePlaceholder(e.content, filename, fileUrl(id));
    if (r.replaced) {
      await env.DB.prepare(`UPDATE entries SET content = ?, updated_at = ? WHERE id = ?`).bind(r.content, at, e.id).run();
      placeholder_replaced = true;
    }
  }
  await touchProject(env, p.id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: p.id, action: "attachment.create", target_id: id, summary: `${e.title}: ${filename} (${Math.round(size / 1024)} KB)`, source: ctx.source });
  return { ...shape(await getRaw(env, id)), placeholder_replaced };
}

/** base64 (data: 접두 허용) → ArrayBuffer */
export function decodeBase64(v: unknown): ArrayBuffer {
  if (typeof v !== "string" || !v.trim()) bad("content_base64 가 필요합니다");
  let s = v.trim();
  const m = /^data:[^;,]+;base64,/i.exec(s);
  if (m) s = s.slice(m[0].length);
  s = s.replace(/\s+/g, "");
  if (s.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) throw new HttpError(413, `이미지가 너무 큽니다 (최대 ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`, "too_large");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) bad("content_base64 가 올바른 base64 가 아닙니다");
  let bin: string;
  try { bin = atob(s.replace(/-/g, "+").replace(/_/g, "/")); } catch { bad("content_base64 디코딩 실패"); }
  const out = new Uint8Array(bin!.length);
  for (let i = 0; i < bin!.length; i++) out[i] = bin!.charCodeAt(i);
  return out.buffer;
}

/** HTTP 업로드: multipart/form-data (file, caption, replace_placeholder) 또는 JSON {filename, content_base64, content_type, caption, replace_placeholder} */
export async function uploadFromRequest(env: Env, ctx: AuthContext, entryId: string, request: Request): Promise<UploadResult> {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    const len = Number(request.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES + 64 * 1024) throw new HttpError(413, `이미지가 너무 큽니다 (최대 ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`, "too_large");
    let form: FormData;
    try { form = await request.formData(); } catch { bad("multipart/form-data 파싱 실패 (file 필드가 필요합니다)"); }
    const file = form!.get("file");
    if (!(file instanceof File)) bad("file 필드(이미지 파일)가 필요합니다");
    const rp = form!.get("replace_placeholder");
    return upload(env, ctx, entryId, { filename: str(form!.get("filename"), 200) || file.name, content_type: file.type, bytes: await file.arrayBuffer(), caption: form!.get("caption"), replace_placeholder: !(rp === "false" || rp === "0") });
  }
  const b = await readJson<{ filename?: unknown; content_base64?: unknown; content_type?: unknown; caption?: unknown; replace_placeholder?: unknown }>(request, 8 * 1024 * 1024);
  return upload(env, ctx, entryId, { filename: b.filename, content_type: b.content_type, bytes: decodeBase64(b.content_base64), caption: b.caption, replace_placeholder: b.replace_placeholder !== false });
}

export interface ImageInput { filename?: unknown; content_base64?: unknown; content_type?: unknown; caption?: unknown }

/**
 * 여러 장을 한 번에 (MCP log_progress.images). 본문에 플레이스홀더가 없는 그림은 끝에 `## 그림` 절로 덧붙인다.
 * 한 장이 실패하면 거기서 멈추고 오류를 던진다 (앞서 올라간 그림은 유지).
 */
export async function attachMany(env: Env, ctx: AuthContext, entryId: string, images: unknown): Promise<{ attachments: UploadResult[]; appended: number }> {
  if (!Array.isArray(images)) bad("images 는 배열이어야 합니다");
  if (images.length > MAX_PER_ENTRY) bad(`images 는 최대 ${MAX_PER_ENTRY}장`);
  const out: UploadResult[] = [];
  for (const [i, img] of (images as ImageInput[]).entries()) {
    if (!img || typeof img !== "object") bad(`images[${i}] 는 {filename, content_base64, caption?} 객체여야 합니다`);
    try {
      out.push(await upload(env, ctx, entryId, { filename: img.filename, content_type: img.content_type, bytes: decodeBase64(img.content_base64), caption: img.caption }));
    } catch (err) {
      if (err instanceof HttpError) throw new HttpError(err.status, `images[${i}] (${str(img.filename, 80) || "이름 없음"}): ${err.message}`, err.code);
      throw err;
    }
  }
  const loose = out.filter((a) => !a.placeholder_replaced);
  if (loose.length) {
    const e = await getEntry(env, entryId);
    const unreferenced = loose.filter((a) => !e.content.includes(fileUrl(a.id)));
    if (unreferenced.length) {
      const block = unreferenced.map((a) => a.markdown).join("\n\n");
      const content = `${e.content.replace(/\s+$/, "")}${e.content.trim() ? "\n\n" : ""}${/^##\s*그림\s*$/m.test(e.content) ? block : `## 그림\n\n${block}`}`;
      await env.DB.prepare(`UPDATE entries SET content = ?, updated_at = ? WHERE id = ?`).bind(content, nowIso(), entryId).run();
      return { attachments: out, appended: unreferenced.length };
    }
  }
  return { attachments: out, appended: 0 };
}

/** 기록의 첨부 목록 (기록 열람 권한과 동일: 같은 카테고리 구성원·평가자·핀 열람자) */
export async function list(env: Env, ctx: AuthContext, entryId: string): Promise<AttachmentRow[]> {
  const e = await getEntry(env, entryId);
  const p = await getProject(env, e.project_id);
  if (!categoryRole(ctx, p.category_id)) forbidden("이 기록이 속한 카테고리의 구성원이 아닙니다");
  const rs = await env.DB.prepare(`${SELECT} WHERE a.entry_id = ? ORDER BY a.created_at`).bind(entryId).all<Raw>();
  return (rs.results ?? []).map(shape);
}

/**
 * 파일 응답. ctx 가 있으면 기록 열람 정책(같은 카테고리 구성원·평가자·핀 열람자)으로, ctx 가 null 이면 서명 URL 검증을 통과한 요청.
 * 첨부 내용은 바뀌지 않으므로 하루 캐시(private).
 */
export async function fileResponse(env: Env, ctx: AuthContext | null, id: string, download = false): Promise<Response> {
  const a = await getRaw(env, id);
  if (ctx) {
    const p = await getProject(env, a.project_id);
    if (!categoryRole(ctx, p.category_id)) forbidden("이 첨부가 속한 카테고리의 구성원이 아닙니다");
  }
  const f = await fileStore(env).get(a.r2_key);
  if (!f) notFound("파일이 저장소에 없습니다");
  const headers: Record<string, string> = {
    "Content-Type": a.content_type,
    "Content-Length": String(a.size),
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": "*",
  };
  // SVG 는 직접 열면 스크립트가 실행될 수 있으므로 모두 막는다 (<img> 안에서는 원래 실행되지 않음)
  if (a.content_type === "image/svg+xml") headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
  return new Response(f.body, { headers });
}

/** 열람 권한 확인 후 서명 URL 발급 (기본 7일) */
export async function signedUrl(env: Env, ctx: AuthContext, id: string): Promise<{ id: string; url: string; expires_in: number; filename: string; content_type: string }> {
  const a = await getRaw(env, id);
  const p = await getProject(env, a.project_id);
  if (!categoryRole(ctx, p.category_id)) forbidden("이 첨부가 속한 카테고리의 구성원이 아닙니다");
  return { id, url: await signFileUrl(env, id), expires_in: SIGNED_URL_TTL_SEC, filename: a.filename, content_type: a.content_type };
}

/** 본문에서 `![..](/files/<id>...)` 참조를 지운다 (figure 한 줄이면 줄 전체) */
export function stripReference(content: string, id: string): string {
  const re = new RegExp(`!\\[[^\\]]*\\]\\(${fileUrl(id).replace(/[/]/g, "\\/")}[^)]*\\)`, "g");
  return content.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

/** 삭제: 업로더 또는 리드·관리자. 본문의 참조도 지운다 */
export async function remove(env: Env, ctx: AuthContext, id: string): Promise<{ id: string; entry_id: string }> {
  const a = await getRaw(env, id);
  const p = await getProject(env, a.project_id);
  const role = categoryRole(ctx, p.category_id);
  const isLead = role === "admin" || role === "lead";
  if (ctx.viewer || !role || !(isLead || a.uploader_id === ctx.user.id)) forbidden("첨부는 올린 사람·리드·관리자만 삭제할 수 있습니다");
  await fileStore(env).delete(a.r2_key).catch(() => {});
  await env.DB.prepare(`DELETE FROM attachments WHERE id = ?`).bind(id).run();
  const e = await env.DB.prepare(`SELECT id, content FROM entries WHERE id = ?`).bind(a.entry_id).first<{ id: string; content: string }>();
  if (e && e.content.includes(fileUrl(id))) {
    await env.DB.prepare(`UPDATE entries SET content = ?, updated_at = ? WHERE id = ?`).bind(stripReference(e.content, id), nowIso(), e.id).run();
  }
  await touchProject(env, p.id);
  await logActivity(env, { actor_id: ctx.user.id, category_id: p.category_id, project_id: p.id, action: "attachment.delete", target_id: id, summary: a.filename, source: ctx.source });
  return { id, entry_id: a.entry_id };
}

/** 기록 삭제 시 저장소 객체까지 정리 (D1 행은 ON DELETE CASCADE 로도 지워지지만 명시적으로 지운다) */
export async function removeAllForEntry(env: Env, entryId: string): Promise<number> {
  const rs = await env.DB.prepare(`SELECT id, r2_key FROM attachments WHERE entry_id = ?`).bind(entryId).all<{ id: string; r2_key: string }>();
  const rows = rs.results ?? [];
  if (!rows.length) return 0;
  const store = fileStore(env);
  await Promise.all(rows.map((r) => store.delete(r.r2_key).catch(() => {})));
  await env.DB.prepare(`DELETE FROM attachments WHERE entry_id = ?`).bind(entryId).run();
  return rows.length;
}
