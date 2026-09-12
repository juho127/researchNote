# 게시판용 HTML 생성기: 공지 마크다운(.md) → 인라인 스타일 HTML (LMS 에디터 소스 모드에 붙여넣기용)
# 사용: python md2board.py presentation-schedule.md "논문 진행 단계별 발표 안내" "HUFS GBT · 2026년 2학기 대학원수업" > presentation-schedule.html
import html, re, sys, io

NAVY, TEAL, GOLD, RULE = "#1a2b4c", "#0f766e", "#b8860b", "#d6d0c4"
CODE = 'style="background:#eef2f7;padding:1px 5px;border-radius:4px;"'

def inline(s):
    codes = []
    t = html.escape(s, quote=False)
    t = re.sub(r"`([^`]+)`", lambda m: (codes.append(f"<code {CODE}>{m.group(1)}</code>"), f"\x00{len(codes)-1}\x00")[1], t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", rf'<a href="\2" style="color:{TEAL};">\1</a>', t)
    t = re.sub(r"(^|[\s(])(https?://[^\s<)]+)", rf'\1<a href="\2" style="color:{TEAL};">\2</a>', t)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], t)

def convert(md):
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, lst = [], 0, None
    ol_n = 0          # 번호 목록이 들여쓴 하위 목록 때문에 끊겼다가 이어질 때 start 번호 유지
    ol_cont = False
    def close():
        nonlocal lst
        if lst: out.append(f"</{lst}>"); lst = None
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            close(); buf = []; i += 1
            while i < len(lines) and not lines[i].startswith("```"): buf.append(lines[i]); i += 1
            i += 1
            out.append(f'<pre style="background:{NAVY};color:#e8eef7;padding:14px 16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;margin:8px 0 12px;">{html.escape(chr(10).join(buf))}</pre>')
            continue
        if re.match(r"^\s*\|.*\|\s*$", ln) and i + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-{2,}", lines[i + 1]):
            close()
            hdr = [c.strip() for c in ln.strip().strip("|").split("|")]
            i += 2; rows = []
            while i < len(lines) and re.match(r"^\s*\|.*\|\s*$", lines[i]):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")]); i += 1
            th = "".join(f'<th style="text-align:left;padding:8px 10px;border:1px solid {RULE};">{inline(c)}</th>' for c in hdr)
            tb = "".join("<tr>" + "".join(f'<td style="padding:7px 10px;border:1px solid {RULE};background:#fff;vertical-align:top;">{inline(c)}</td>' for c in r) + "</tr>" for r in rows)
            out.append(f'<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 14px;"><thead><tr style="background:{NAVY};color:#fff;">{th}</tr></thead><tbody>{tb}</tbody></table></div>')
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            close(); lvl = len(m.group(1)); txt = inline(m.group(2))
            if lvl <= 2: out.append(f'<h2 style="font-size:19px;color:{NAVY};border-bottom:2px solid {RULE};padding-bottom:6px;margin:28px 0 12px;">{txt}</h2>')
            else: out.append(f'<h3 style="font-size:16px;color:{NAVY};margin:22px 0 8px;padding:10px 14px;background:#fff;border:1px solid {RULE};border-left:5px solid {NAVY};border-radius:6px;">{txt}</h3>')
            i += 1; continue
        m = re.match(r"^>\s?(.*)$", ln)
        if m:
            close(); buf = [m.group(1)]; i += 1
            while i < len(lines) and lines[i].startswith(">"): buf.append(re.sub(r"^>\s?", "", lines[i])); i += 1
            out.append(f'<div style="margin:12px 0;padding:12px 16px;background:#fff7e6;border:1px solid #f0d9a8;border-left:5px solid {GOLD};border-radius:6px;">{"<br>".join(inline(b) for b in buf)}</div>')
            continue
        ul = re.match(r"^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$", ln)
        ol = re.match(r"^(\s*)\d+[.)]\s+(.*)$", ln)
        if ul or ol:
            typ = "ul" if ul else "ol"
            indent = len((ul or ol).group(1))
            if lst != typ:
                cont = bool(lst == "ol" and typ == "ul" and indent)
                close()
                start = ""
                if typ == "ol":
                    start = f' start="{ol_n + 1}"' if ol_cont else ""
                    if not ol_cont: ol_n = 0
                    ol_cont = False
                else:
                    ol_cont = cont
                out.append(f'<{typ}{start} style="padding-left:22px;margin:4px 0 10px;">'); lst = typ
            if typ == "ol": ol_n += 1
            txt = ul.group(3) if ul else ol.group(2)
            if ul and ul.group(2) is not None: txt = ("☑ " if ul.group(2).lower() == "x" else "☐ ") + txt
            out.append(f'<li style="margin:2px 0;{"margin-left:18px;" if indent else ""}">{inline(txt)}</li>')
            i += 1; continue
        if not ln.strip(): close(); i += 1; continue
        close(); ol_cont = False; ol_n = 0; buf = [ln]; i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)", lines[i]): buf.append(lines[i]); i += 1
        out.append(f'<p style="margin:8px 0;">{"<br>".join(inline(b) for b in buf)}</p>')
    close()
    return "\n".join(out)

def page(md, title, eyebrow, sub=""):
    body = convert(md)
    return f'''<!-- {title} (게시판용, 인라인 스타일만 사용. 원본: 같은 이름의 .md, 생성: md2board.py) -->
<div style="max-width:860px;margin:0 auto;padding:28px 24px;background:#faf8f3;color:#1f2937;font-family:Pretendard,'Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif;font-size:15px;line-height:1.7;border:1px solid #e5e0d5;border-radius:12px;">
  <div style="border-left:6px solid {NAVY};padding-left:16px;margin-bottom:20px;">
    <div style="font-size:12px;letter-spacing:.12em;color:{TEAL};font-weight:700;">{html.escape(eyebrow)}</div>
    <h1 style="margin:4px 0 6px;font-size:26px;color:{NAVY};">{html.escape(title)}</h1>
    {f'<div style="color:#4b5563;">{html.escape(sub)}</div>' if sub else ''}
  </div>
{body}
  <div style="margin-top:26px;padding-top:12px;border-top:1px solid {RULE};font-size:12.5px;color:#6b7280;">한국외국어대학교 Global Business &amp; Technology · 연구노트 · <a href="https://research-note.juho-2b6.workers.dev" style="color:{TEAL};">research-note.juho-2b6.workers.dev</a></div>
</div>
'''

if __name__ == "__main__":
    src, title, eyebrow = sys.argv[1], sys.argv[2], sys.argv[3]
    sub = sys.argv[4] if len(sys.argv) > 4 else ""
    sys.stdout.reconfigure(encoding="utf-8")
    print(page(io.open(src, encoding="utf-8").read(), title, eyebrow, sub), end="")
