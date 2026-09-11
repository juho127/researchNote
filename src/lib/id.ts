const ALPHA = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function randomString(len: number, alphabet = ALPHA): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 짧고 URL-safe 한 ID (접두어 + 12자) */
export function newId(prefix: string): string {
  return `${prefix}_${randomString(12, "abcdefghijklmnopqrstuvwxyz0123456789")}`;
}

/** 손으로 옮겨 적어도 헷갈리지 않도록 0/O, 1/l/I 를 뺀 알파벳 (토큰·수령 코드용) */
const UNAMBIGUOUS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 개인 접근 토큰 생성: rn_ + 40자 (혼동 문자 제외) */
export function newToken(): string {
  return "rn_" + randomString(40, UNAMBIGUOUS);
}

/** 수령 코드: clm_ + 24자 (혼동 문자 제외) */
export function newClaimCode(): string {
  return "clm_" + randomString(24, UNAMBIGUOUS);
}

/**
 * 사용자가 붙여넣은 토큰 정규화: 앞뒤 공백·따옴표, "Bearer " 접두, 내부 공백/줄바꿈 제거.
 * (안내문이나 curl 명령에서 복사할 때 섞여 들어오는 것들)
 */
export function normalizeToken(raw: string): string {
  let t = String(raw ?? "").trim();
  // "Bearer" 접두와 따옴표가 겹쳐 있을 수 있으므로 안정될 때까지 벗긴다 (예: Bearer "Bearer rn_…")
  for (let i = 0; i < 3; i++) {
    t = t.replace(/^(authorization\s*:\s*)?bearer\s+/i, "").trim();
    t = t.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  }
  return t.replace(/\s+/g, "");
}

export function tokenHint(token: string): string {
  if (token.length < 12) return token.slice(0, 3) + "…";
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** slug: 한글·영문·숫자 유지, 나머지 - */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || randomString(6).toLowerCase();
}
