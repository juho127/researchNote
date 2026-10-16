/**
 * 파일 저장소 어댑터 + 서명 URL.
 *
 * - 저장소: R2 바인딩(FILES_R2) 이 있으면 R2, 없으면 KV(FILES). 보고서 제출(PDF)과 기록 이미지 첨부가 함께 쓴다.
 * - 서명 URL: `<img src>` 처럼 Authorization 헤더를 실을 수 없는 자리(HTML 보고서 등)를 위해
 *   `/files/<id>?exp=<unix초>&sig=<hmac>` 형태의 기한부 URL 을 만든다. 키는 FILES_SIGN_KEY 시크릿이 있으면 그것,
 *   없으면 app_settings 테이블에 첫 사용 시 자동 생성해 둔다 (배포 설정 없이 동작).
 */
import type { Env } from "../env";
import { randomString } from "./id";
import { nowIso } from "./time";

export interface StoredFile {
  body: ReadableStream;
  contentType?: string;
}

export interface FileStore {
  kind: "r2" | "kv";
  put(key: string, data: ArrayBuffer, contentType: string, meta: Record<string, string>): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

export function storeKind(env: Env): "r2" | "kv" | "none" {
  return env.FILES_R2 ? "r2" : env.FILES ? "kv" : "none";
}

export function fileStore(env: Env): FileStore {
  if (env.FILES_R2) {
    const r2 = env.FILES_R2;
    return {
      kind: "r2",
      put: async (key, data, contentType, meta) => { await r2.put(key, data, { httpMetadata: { contentType }, customMetadata: meta }); },
      get: async (key) => { const o = await r2.get(key); return o ? { body: o.body, contentType: o.httpMetadata?.contentType } : null; },
      delete: async (key) => { await r2.delete(key); },
    };
  }
  if (env.FILES) {
    const kv = env.FILES;
    return {
      kind: "kv",
      put: async (key, data, contentType, meta) => { await kv.put(key, data, { metadata: { ...meta, content_type: contentType } }); },
      get: async (key) => { const s = await kv.get(key, "stream"); return s ? { body: s } : null; },
      delete: async (key) => { await kv.delete(key); },
    };
  }
  throw new Error("파일 저장소 바인딩(FILES_R2 또는 FILES)이 없습니다. wrangler.jsonc 의 r2_buckets 를 확인하세요");
}

// ---------- 서명 URL ----------

let signKeyCache: string | null = null;

async function signingKey(env: Env): Promise<string> {
  if (env.FILES_SIGN_KEY) return env.FILES_SIGN_KEY;
  if (signKeyCache) return signKeyCache;
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'files_sign_key'`).first<{ value: string }>();
  if (row?.value) return (signKeyCache = row.value);
  await env.DB.prepare(`INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ('files_sign_key', ?, ?)`).bind(randomString(48), nowIso()).run();
  // 동시 생성 경합 시 먼저 들어간 값을 읽는다
  const again = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'files_sign_key'`).first<{ value: string }>();
  if (!again?.value) throw new Error("서명 키를 만들 수 없습니다");
  return (signKeyCache = again.value);
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].slice(0, 20).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 기본 7일. 보고서 HTML 을 저장해 두고 나중에 봐도 그림이 보이도록 넉넉히 둔다 */
export const SIGNED_URL_TTL_SEC = 7 * 24 * 3600;

export async function signFileUrl(env: Env, id: string, ttlSec = SIGNED_URL_TTL_SEC): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(await signingKey(env), `${id}.${exp}`);
  return `/files/${id}?exp=${exp}&sig=${sig}`;
}

export async function verifyFileSig(env: Env, id: string, exp: string | null, sig: string | null): Promise<boolean> {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{40}$/.test(sig)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const expect = await hmacHex(await signingKey(env), `${id}.${exp}`);
  if (expect.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/** 텍스트들에 등장하는 /files/<id> 참조를 모두 서명 URL 로 바꾸는 치환 함수를 만든다 (보고서 HTML 용) */
export async function fileUrlSigner(env: Env, texts: (string | null | undefined)[]): Promise<(src: string) => string> {
  const ids = new Set<string>();
  for (const t of texts) for (const m of (t ?? "").matchAll(/\/files\/(att_[a-z0-9]+)/g)) ids.add(m[1]);
  const map = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => map.set(id, await signFileUrl(env, id))));
  return (src: string) => {
    const m = /^\/files\/(att_[a-z0-9]+)/.exec(src);
    return m && map.has(m[1]) ? map.get(m[1])! : src;
  };
}
