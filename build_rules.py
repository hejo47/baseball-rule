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

TOC_END_PAGE = 24       # 목차 끝 (본문 시작 직전)

FOOTER = re.compile(r"^\s*[․·.]\s*\d+\s*[․·.]\s*$")

# 목차 줄: '9.13      와일드 피치· 패스트볼 ·············· 153'
TOC = re.compile(r"^\s*(\d{1,2}\.\d{2})\s+(.+?)\s*[·․.]{4,}\s*\d+\s*$")

# 본문에서 조항이 시작하는 줄: '9.13 와일드 피치(WILD PITCH 폭투 暴投)...'
# 제목 모양을 추측하지 않는다. 목차에 있는 번호인지로만 판단하고,
# 번호가 목차 순서대로 나오는지까지 확인해 본문 속 상호참조를 걸러낸다.
#
# 예전에는 제목이 '한글로 시작하고 29자 이내'여야 조항으로 인정했다.
# 그 바람에 11개 조항이 통째로 사라졌다. 제목이 길거나(9.13 와일드 피치
# ·패스트볼 42자), 숫자로 시작하거나(9.14 4구, 3.05 1루수 글러브),
# 아예 제목이 없는(1.01~1.06) 조항들이다. 빠진 내용은 앞 조항에 들러붙어
# '폭투' 규정이 '실책'이라는 제목을 달고 검색되고 있었다.
ARTICLE_START = re.compile(r"^\s{0,4}(\d{1,2}\.\d{2})(?:\s+(.*))?$")

# 1단계: ⒜⒝⒞  2단계: ⑴⑵⑶
# 두 번째 값은 '첫 기호의 바로 앞' 코드다. 그래야 ⒜와 ⑴이 똑같이 1번이 된다.
# 예전에는 ⒜ 쪽만 0x249C(=⒜ 자신)로 적혀 있어서 ⒜가 0번이 됐고,
# 분할이 ⒝부터 시작해 ⒜ 항목이 11개 조항에서 통째로 도입부로 밀려났다.
# ('6.02⒜ 보크'가 '6.02⒝'의 머리말로 250자만 잘려 들어가 있었다.)
LEVELS = [
    (re.compile(r"^\s{0,3}([⒜-⒵])\s*(.*)$"), 0x249B),
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

def parse_toc(text: str) -> dict[str, str]:
    """목차에서 조항 번호와 제목을 뽑는다. 어떤 번호가 조항인지의 정답지다."""
    entries = {}
    for line in text.split("\n"):
        m = TOC.match(line)
        if m:
            entries.setdefault(m.group(1), re.sub(r"\s+", " ", m.group(2)).strip())
    return entries


def _is_title(toc_title: str, rest: str) -> bool:
    """본문 헤더 줄의 뒷부분이 제목인지, 아니면 본문이 바로 시작한 것인지 본다.

    본문 제목은 '와일드 피치(WILD PITCH 폭투 暴投)·패스트볼(PASSED BALL)'처럼
    영문과 한자를 괄호로 달고 있어 목차 제목보다 길다. 괄호를 걷어내면 같아진다.
    1.01~1.06처럼 제목 없이 본문이 바로 오는 조항은 같아지지 않는다.
    """
    if not rest:
        return False
    def bare(t):
        return re.sub(r"[\s()（）]", "", re.sub(r"\([^)]*\)", "", t))
    return bare(toc_title) == bare(rest)


def parse_articles(text: str, toc: dict[str, str]) -> list[dict]:
    """본문을 조항(N.NN) 단위로 자른다.

    어떤 번호가 조항인지는 목차가 정한다. 제목 모양을 추측하지 않으므로
    제목이 길든, 숫자로 시작하든, 아예 없든 상관이 없다.
    본문 속 '5.09⒟ 참조' 같은 상호참조는 목차 순서를 거스르므로 걸러진다.
    """
    position = {number: i for i, number in enumerate(toc)}
    chunks, current, last = [], None, -1

    for line in text.split("\n"):
        m = ARTICLE_START.match(line)
        number = m.group(1) if m else None

        if number in position and position[number] > last:
            last = position[number]
            rest = (m.group(2) or "").strip()
            titled = _is_title(toc[number], rest)
            chapter = int(number.split(".")[0])
            if current:
                chunks.append(current)
            current = {
                "id": number,
                "title": rest if titled else toc[number],
                "chapter": f"{chapter}.00 {CHAPTERS.get(chapter, '')}",
                "type": "규칙",
                "source": "KBO 공식 야구규칙",
                # 제목이 없는 조항은 헤더 줄의 뒷부분이 곧 본문 첫 줄이다.
                "lines": [] if titled else ([rest] if rest else []),
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
            "title": with_item_label(article["title"], p["lines"][0]),
            "text": (intro + "\n\n" if intro else "") + p["marker"] + " " + body,
        }
        out.extend(split_long(piece, level + 1))
    return out or [article]


# 쪼갠 조각의 제목에 붙이는 항목 머리말의 최대 길이. 넘으면 낱말 경계에서 자른다.
LABEL_CHARS = 30
TITLE_JOIN = " · "


def item_label(first_line: str) -> str:
    """하위 항목의 첫 줄을 제목에 붙일 머리말로 줄인다.

    '⒝ 주자 아웃'처럼 짧은 소제목은 그대로, '⑸ 페어 플라이 볼, 파울 플라이 볼이
    정규로 포구된 뒤 ...'처럼 본문이 바로 시작하면 앞부분만 쓴다.
    """
    line = re.sub(r"\s+", " ", first_line).strip()
    if len(line) <= LABEL_CHARS:
        return line
    cut = line[:LABEL_CHARS]
    if " " in cut:
        cut = cut[:cut.rindex(" ")]
    return cut.rstrip(",.·") + "…"


def with_item_label(parent_title: str, first_line: str) -> str:
    """쪼갠 조각의 제목 = 조항 제목 · 자기 항목의 머리말.

    예전에는 쪼갠 조각이 부모 제목을 그대로 물려받아, 5.09에서 나온 조각
    37개가 모두 '아웃'이었다(docs/search.md 한계 2).

    중간 단계의 머리말은 붙이지 않는다. 부모 제목에 붙어 있던 머리말은 떼고 조항
    제목만 쓴다. '5.09⒝⑸'를 '아웃 · 주자 아웃 · 페어 플라이...'로 이어 붙였더니
    6.02⒜(보크) 아래 조각 13개가 모두 제목에 '보크'를 갖게 돼, '보크가 뭐야?'의
    정답(정의-3)이 1등 -> 14등으로 밀렸다. 형제 조각끼리 같은 말을 나눠 쓰면 원래
    문제가 다시 생긴다.
    """
    base = parent_title.split(TITLE_JOIN)[0]
    label = item_label(first_line)
    return f"{base}{TITLE_JOIN}{label}" if label else base


def retitle(chunks: list[dict]) -> int:
    """이미 만든 JSON의 쪼갠 조각에 항목 머리말 제목을 붙인다. 바꾼 개수를 돌려준다.

    PDF 원문 없이 data/rules.json만 있을 때 쓴다. 조각 본문에 각 단계의 항목
    줄('⒝ 주자 아웃', '⑸ 페어 ...')이 남아 있어서, split_long이 붙였을 것과 같은
    제목을 다시 만들 수 있다. 여러 번 돌려도 결과가 같다.
    """
    changed = 0
    for c in chunks:
        m = re.match(r"^(\d{1,2}\.\d{2})(.+)$", c["id"])
        if not m:
            continue
        title = c["title"].split(TITLE_JOIN)[0]
        lines = c["text"].split("\n")
        at = 0
        for marker in m.group(2):
            for i in range(at, len(lines)):
                hit = re.match(rf"^\s*{re.escape(marker)}\s*(.*)$", lines[i])
                if hit:
                    title = with_item_label(title, hit.group(1))
                    at = i + 1
                    break
        if title != c["title"]:
            c["title"] = title
            changed += 1
    return changed


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
                "source": "KBO 공식 야구규칙",
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

    toc = parse_toc("\n".join(raw.split("\f")[:TOC_END_PAGE]))
    body = "\n".join(clean_pages(raw, BODY_START_PAGE, BODY_END_PAGE))
    defs = "\n".join(clean_pages(raw, DEF_START_PAGE, DEF_END_PAGE))

    parsed = parse_articles(body, toc)

    # 목차에 있는 조항을 하나라도 놓치면 알아차릴 수 있게 확인한다.
    # 예전 파서는 11개를 조용히 흘렸고, 그 내용이 앞 조항에 들러붙어
    # 엉뚱한 제목을 달고 검색됐다.
    missed = [n for n in toc if n not in {a["id"] for a in parsed}]
    if missed:
        print(f"경고: 목차에 있는데 본문에서 못 찾은 조항 {len(missed)}개")
        for n in missed:
            print(f"  {n} {toc[n]}")

    articles = []
    for a in parsed:
        articles.extend(split_long(a))

    rules = articles + parse_definitions(defs)

    for r in rules:
        r["chars"] = len(r["text"])

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(rules, f, ensure_ascii=False, indent=2)

    articles = [r for r in rules if r["type"] == "규칙"]
    terms = [r for r in rules if r["type"] == "정의"]
    print(f"목차 {len(toc)}개 중 {len(parsed)}개 확인 -> 조각 {len(articles)}개")
    print(f"조항 {len(articles)}개, 정의 {len(terms)}개 -> {dst}")
    print(f"평균 길이 {sum(r['chars'] for r in rules) // len(rules)}자, "
          f"최장 {max(r['chars'] for r in rules)}자")


if __name__ == "__main__":
    # python build_rules.py --retitle data/rules.json
    #   PDF 없이 이미 만든 JSON의 쪼갠 조각 제목만 다시 붙인다.
    if sys.argv[1] == "--retitle":
        path = sys.argv[2]
        chunks = json.load(open(path, encoding="utf-8"))
        n = retitle(chunks)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False, indent=2)
        print(f"제목을 다시 붙인 조각 {n}개 -> {path}")
    else:
        main(sys.argv[1], sys.argv[2])
