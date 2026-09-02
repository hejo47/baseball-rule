"""
2026 KBO 공식 야구규칙 PDF -> 조항 단위 JSON

사용법:
    pip install pdftotext  # 아님. poppler-utils 의 pdftotext CLI 사용
    pdftotext -layout 2026_야구규칙.pdf raw.txt
    python build_rules.py raw.txt rules.json
"""

import json
import re
import sys

# ---------------------------------------------------------------- 설정

BODY_START_PAGE = 25    # 1.00 경기의 목적 시작
BODY_END_PAGE = 192     # 용어의 정의 직전
DEF_START_PAGE = 193    # <용어의 정의> 시작
DEF_END_PAGE = 210      # 82. WIND-UP POSITION 끝

CHAPTERS = {
    1: "경기의 목적",
    2: "경기장",
    3: "용구 및 유니폼",
    4: "경기의 준비",
    5: "경기의 진행",
    6: "부적절한 플레이, 금지행동, 비신사적 행위",
    7: "경기의 종료",
    8: "심판원",
    9: "공식 기록원",
}

FOOTER = re.compile(r"^\s*[․·.]\s*\d+\s*[․·.]\s*$")
# 조항 헤더는 '5.09 아웃' 처럼 번호 + 공백 + 짧은 한글 제목으로 끝나는 줄이다.
# '5.09⒟ 참조)' 같은 본문 속 상호참조와 구분하기 위해 공백과 한글 시작을 요구한다.
ARTICLE = re.compile(r"^\s{0,4}(\d{1,2}\.\d{2})\s+([가-힣][^\n]{0,28})\s*$")

# 1단계: ⒜⒝⒞  2단계: ⑴⑵⑶
LEVELS = [
    (re.compile(r"^\s{0,3}([⒜-⒵])\s*(.*)$"), 0x249C),
    (re.compile(r"^\s{0,3}([⑴-⒇])\s*(.*)$"), 0x2473),
]
MAX_CHARS = 2500  # 이보다 긴 조각은 다음 단계로 더 쪼갠다
DEFINITION = re.compile(
    r"^\s{0,6}(\d{1,2})\.\s+([A-Z][A-Za-z'’`\-]*(?:\s+(?:or|[A-Za-z'’`\-]+))*)"
    r"\s*\((.+?)\)\s*$"
)


# ---------------------------------------------------------------- 전처리

def clean_pages(raw: str, start: int, end: int) -> list[str]:
    """쪽 머리말과 쪽번호를 제거한 페이지 목록을 돌려준다."""
    pages = raw.split("\f")[start - 1:end]
    out = []
    for page in pages:
        lines = page.split("\n")
        # 첫 비어있지 않은 줄이 머리말이면 버린다
        for i, line in enumerate(lines):
            if line.strip():
                if re.search(r"\d{1,2}\.\d{2}", line) or "용어의 정의" in line:
                    lines[i] = ""
                break
        lines = [l for l in lines if not FOOTER.match(l)]
        out.append("\n".join(lines))
    return out


def squash(lines: list[str]) -> str:
    """들여쓰기를 정리하고 빈 줄을 압축한다."""
    text = "\n".join(l.rstrip() for l in lines)
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ---------------------------------------------------------------- 파싱

def parse_articles(text: str) -> list[dict]:
    """본문을 조항(N.NN) 단위로 자른다."""
    chunks, current = [], None

    for line in text.split("\n"):
        m = ARTICLE.match(line)
        if m:
            if current:
                chunks.append(current)
            number, title = m.group(1), m.group(2).strip()
            chapter = int(number.split(".")[0])
            current = {
                "id": number,
                "title": title,
                "chapter": f"{chapter}.00 {CHAPTERS.get(chapter, '')}",
                "type": "규칙",
                "lines": [],
            }
            continue
        if current:
            current["lines"].append(line)

    if current:
        chunks.append(current)

    for c in chunks:
        c["text"] = squash(c.pop("lines"))
    return [c for c in chunks if c["text"]]


def split_long(article: dict, level: int = 0) -> list[dict]:
    """긴 조각을 하위 항목 단위로 쪼갠다. 짧거나 더 쪼갤 수 없으면 그대로 둔다.

    본문 속에도 같은 모양의 기호가 나오므로, ⒜ 다음은 ⒝, 그다음은 ⒞ 처럼
    '순서대로 증가하는' 마커만 진짜 분할점으로 인정한다.
    """
    if len(article["text"]) <= MAX_CHARS or level >= len(LEVELS):
        return [article]

    pattern, base = LEVELS[level]
    parts, current, head, expected = [], None, [], 1

    for line in article["text"].split("\n"):
        m = pattern.match(line)
        if m and ord(m.group(1)) - base == expected:
            if current:
                parts.append(current)
            current = {"marker": m.group(1), "lines": [m.group(2)]}
            expected += 1
            continue
        (current["lines"] if current else head).append(line)

    if current:
        parts.append(current)
    if len(parts) < 2:
        return split_long(article, level + 1)

    # 하위 항목 앞의 도입부는 각 조각에 붙여 맥락을 잃지 않게 한다
    intro = squash(head)[:250]
    out = []
    for p in parts:
        body = squash(p["lines"])
        if not body:
            continue
        piece = {
            **{k: v for k, v in article.items() if k != "text"},
            "id": f"{article['id']}{p['marker']}",
            "text": (intro + "\n\n" if intro else "") + p["marker"] + " " + body,
        }
        out.extend(split_long(piece, level + 1))
    return out or [article]


def parse_definitions(text: str) -> list[dict]:
    """용어의 정의를 항목 단위로 자른다."""
    chunks, current = [], None

    for line in text.split("\n"):
        m = DEFINITION.match(line)
        if m:
            if current:
                chunks.append(current)
            num, english, korean = m.group(1), m.group(2).strip(), m.group(3).strip()
            current = {
                "id": f"정의-{num}",
                "title": korean,
                "english": english,
                "chapter": "용어의 정의",
                "type": "정의",
                "lines": [],
            }
            continue
        if current:
            current["lines"].append(line)

    if current:
        chunks.append(current)

    for c in chunks:
        c["text"] = squash(c.pop("lines"))
    return [c for c in chunks if c["text"]]


# ---------------------------------------------------------------- 실행

def main(src: str, dst: str) -> None:
    raw = open(src, encoding="utf-8").read()

    body = "\n".join(clean_pages(raw, BODY_START_PAGE, BODY_END_PAGE))
    defs = "\n".join(clean_pages(raw, DEF_START_PAGE, DEF_END_PAGE))

    articles = []
    for a in parse_articles(body):
        articles.extend(split_long(a))

    rules = articles + parse_definitions(defs)

    for r in rules:
        r["chars"] = len(r["text"])

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)

    articles = [r for r in rules if r["type"] == "규칙"]
    terms = [r for r in rules if r["type"] == "정의"]
    print(f"조항 {len(articles)}개, 정의 {len(terms)}개 -> {dst}")
    print(f"평균 길이 {sum(r['chars'] for r in rules) // len(rules)}자, "
          f"최장 {max(r['chars'] for r in rules)}자")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
