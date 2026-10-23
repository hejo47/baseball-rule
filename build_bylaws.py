"""
2026 KBO 규약 PDF -> 조항 단위 JSON

사용법:
    pip install pymupdf
    python build_bylaws.py 2026_야구규약.pdf bylaws.json

야구규칙(build_rules.py), 리그 규정(build_league.py)과 별개 문서다.
FA 자격, 선수 정원, 최저연봉, 드래프트, 샐러리캡, 외국인선수, 포스팅처럼
선수 신분과 계약에 관한 질문의 답이 여기에 있다.

다른 두 PDF와 달리 poppler의 pdftotext로 뽑으면 한글이 전부 깨진다
('Adobe-Korea1' CMap을 찾지 못한다는 에러). 그래서 PDF를 직접 받아
PyMuPDF로 글자를 뽑는다. 미리 뽑아 둔 글자 파일(.txt, 쪽 사이에 \\f)을 줘도 된다.

규약집 한 권에 문서 17개가 묶여 있다. 문서마다 조항 표기가 달라서
(제1조 [목적] / 제1조 (목적) / 제1조 총재의... / 1. / 1) / 제1장)
문서별로 쪽 범위와 자르는 방식을 DOCUMENTS에 적어 둔다.
쪽 번호는 PDF 뷰어에 보이는 쪽(1부터)이고, 책에 인쇄된 쪽번호와 다르다.
"""

import json
import re
import sys

# (id 앞머리, 문서 이름, 첫 쪽, 끝 쪽, 자르는 방식)
#   article  : 제N조 단위. 번호가 1씩 늘어나는 줄만 인정한다(본문 속 상호참조 거르기).
#   numbered : '1.' 또는 '1)'로 시작하는 문단 단위 (선수계약협정)
#   chapter  : 제N장 단위 (외국인선수 계약서는 장 아래 조가 없다)
#
# 빼는 것: 한·미 선수계약협정의 영문 번역(215~225쪽)과 글자가 없는 그림 쪽
# (외국인선수 계약서 영문 160~180쪽, 부록 양식 253쪽~). 영문은 한국어 본문과
# 내용이 같아서 넣으면 같은 조항이 두 번 걸리기만 한다.
DOCUMENTS = [
    ("정관", "KBO 정관", 14, 26, "article"),
    ("규약", "KBO 규약", 37, 110, "article"),
    ("선수계약서", "야구선수계약서", 113, 130, "article"),
    ("감독계약서", "감독·코치 계약서", 131, 136, "article"),
    ("외국인고용", "외국인선수 고용규정", 139, 143, "article"),
    ("외국인계약서", "외국인선수 계약서", 144, 159, "chapter"),
    ("규칙위원회", "야구규칙위원회 규정", 183, 183, "article"),
    ("상벌위원회", "상벌위원회 규정", 184, 184, "article"),
    ("사용구", "KBO 경기사용구 규정", 185, 188, "article"),
    ("배트", "KBO 배트 공인규정", 189, 193, "article"),
    ("연금KDB", "KBO 선수 연금보험 규정(KDB생명)", 194, 201, "article"),
    ("연금삼성", "KBO 선수 연금보험 규정(삼성생명)", 202, 204, "article"),
    ("한미협정", "한·미 선수계약협정", 207, 214, "numbered"),
    ("한일협정", "한·일 선수계약협정", 226, 230, "numbered"),
    ("한대만협정", "한·대만 선수계약협정", 231, 234, "numbered"),
    ("아마협정", "KBO-대한야구소프트볼협회 협정서", 235, 238, "article"),
    ("국가대표", "국가대표팀 운영규정", 241, 252, "article"),
]

# 쪽번호만 있는 줄. 본문 한가운데 끼어든다.
PAGE_NUMBER = re.compile(r"^\s*\d{1,3}\s*$")

# 장 제목은 '제1장 총 칙'처럼 한 줄에 홀로 온다. 조 번호가 섞인 줄은 제외한다.
CHAPTER = re.compile(r"^\s{0,20}(제\s?(\d{1,2})\s?장\s*(?!.*제\s?\d{1,3}\s?조)\S[^\n]{0,40}?)\s*$")

# '제88조의 2 [이면 양수도계약의 금지]'처럼 가지 번호가 붙는 조가 있다.
# 제목은 [ ] 또는 ( ) 안에 온다. 감독·코치 계약서의 '제1조 (갑)은'처럼
# 한 글자짜리 괄호는 제목이 아니다.
ARTICLE = re.compile(
    r"^\s{0,4}제\s?(\d{1,3})\s?조(?:\s?의\s?(\d))?\s*"
    r"(?:[\[(]([^\])]{2,30})[\])])?\s*(.*)$"
)

# 선수계약협정의 문단 번호. 한·미는 '1.', 한·일과 한·대만은 '1)'.
NUMBERED = re.compile(r"^\s{1,6}(\d{1,2})[.)]\s+(.*)$")

# 부칙 뒤에서는 조 번호가 1부터 다시 시작한다. 부칙은 통째로 한 조각이다.
ADDENDUM = re.compile(r"^\s*(?:-\s*)?부\s*칙\b")

# 한·일, 한·대만 협정은 같은 쪽 안에서 한국어 본문 바로 뒤에 영문 번역이
# 'JAPAN-KOREA PLAYER CONTRACT AGREEMENT' 같은 제목으로 이어진다. 거기서 멈춘다.
ENGLISH_TITLE = re.compile(r"^\s*[A-Z][A-Z\s\-]+AGREEMENT\s*$")

# 긴 조각을 쪼갤 때 쓰는 하위 항목. 1단계 '①'  2단계 '1.'  3단계 '가.'
LEVELS = [
    (re.compile(r"^\s{0,10}([①-⑳])\s*(.*)$"), lambda m: ord(m.group(1)) - 0x245F),
    (re.compile(r"^\s{0,6}(\d{1,2})\.\s*(.*)$"), lambda m: int(m.group(1))),
    (re.compile(r"^\s{0,6}([가-하])\.\s*(.*)$"), lambda m: "가나다라마바사아자차카타파하".index(m.group(1)) + 1),
]
MAX_CHARS = 2500  # 이보다 긴 조각은 다음 단계로 더 쪼갠다


def read_pages(src: str) -> list[str]:
    if src.lower().endswith(".pdf"):
        import pymupdf
        return [p.get_text("text", sort=True) for p in pymupdf.open(src)]
    return open(src, encoding="utf-8").read().split("\f")


def squash(lines: list[str]) -> str:
    """들여쓰기를 정리하고 빈 줄을 압축한다."""
    text = "\n".join(l.rstrip() for l in lines if not PAGE_NUMBER.match(l))
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def tidy_chapter(raw: str) -> str:
    """'제1장 총 칙' -> '제1장 총칙'. 글자 사이를 띄워 쓴 장 제목을 붙인다."""
    head, _, rest = re.sub(r"\s+", " ", raw).strip().partition("장")
    words = rest.split()
    if words and all(len(w) == 1 for w in words):
        rest = "".join(words)
    else:
        rest = " ".join(words)
    return f"{head.replace(' ', '')}장 {rest}".strip()


def parse_document(prefix: str, name: str, lines: list[str], mode: str) -> list[dict]:
    chunks, current, chapter = [], None, ""
    last, last_sub = 0, 0  # 마지막으로 인정한 조 번호, 가지 번호
    last_chapter = 0
    in_addendum = 0

    def start(id_: str, title: str) -> dict:
        nonlocal current
        if current:
            chunks.append(current)
        current = {
            "id": id_,
            "title": title,
            "chapter": chapter,
            "type": "규약",
            "source": name,
            "lines": [],
        }
        return current

    for line in lines:
        if ENGLISH_TITLE.match(line):
            break
        if re.sub(r"\s+", "", line) == re.sub(r"\s+", "", name):
            continue  # 쪽 맨 위의 문서 제목

        if ADDENDUM.match(line):
            in_addendum += 1
            chapter = "부칙"
            suffix = "" if in_addendum == 1 else f"-{in_addendum}"
            start(f"{prefix}-부칙{suffix}", "부칙")
            current["lines"].append(line.strip().lstrip("-").strip())
            continue

        if in_addendum:
            current["lines"].append(line)
            continue

        # 본문 줄이 마침 '제4장의 선수 연봉은'으로 시작하는 경우가 있어
        # 장 번호도 순서대로 늘어날 때만 인정한다.
        c = CHAPTER.match(line)
        if c and not ARTICLE.match(line) and int(c.group(2)) == last_chapter + 1:
            last_chapter += 1
            chapter = tidy_chapter(c.group(1))
            if mode == "chapter":
                start(f"{prefix}-제{c.group(2)}장", chapter.partition(" ")[2] or chapter)
            continue

        if mode == "article":
            m = ARTICLE.match(line)
            if m:
                # 가지 번호는 '의1' 없이 '의2'부터 시작한다.
                n, sub = int(m.group(1)), m.group(2)
                ok = (sub is None and n == last + 1) or \
                     (sub is not None and n == last and int(sub) > last_sub)
                if ok:
                    last, last_sub = n, (int(sub) if sub else 0)
                    id_ = f"{prefix}-제{n}조" + (f"의{sub}" if sub else "")
                    start(id_, (m.group(3) or name).strip())
                    if m.group(4).strip():
                        current["lines"].append(m.group(4))
                    continue

        if mode == "numbered":
            m = NUMBERED.match(line)
            if m and int(m.group(1)) == last + 1:
                last += 1
                start(f"{prefix}-{last}", name)
                current["lines"].append(m.group(2))
                continue

        if current:
            current["lines"].append(line)

    if current:
        chunks.append(current)

    for c in chunks:
        c["text"] = squash(c.pop("lines"))
    return [c for c in chunks if c["text"]]


def split_long(article: dict, level: int = 0) -> list[dict]:
    """긴 조각을 하위 항목 단위로 쪼갠다.

    본문 속에도 같은 모양의 기호가 나오므로 '1. 다음 2. 그다음 3.'처럼
    순서대로 증가하는 마커만 진짜 분할점으로 인정한다.
    """
    if len(article["text"]) <= MAX_CHARS or level >= len(LEVELS):
        return [article]

    pattern, number_of = LEVELS[level]
    parts, current, head, expected = [], None, [], 1

    for line in article["text"].split("\n"):
        m = pattern.match(line)
        if m and number_of(m) == expected:
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
            "id": f"{article['id']}-{p['marker']}",
            "text": (intro + "\n\n" if intro else "") + p["marker"] + " " + body,
        }
        out.extend(split_long(piece, level + 1))
    return out or [article]


def main(src: str, dst: str) -> None:
    pages = read_pages(src)
    pieces = []

    for prefix, name, first, last, mode in DOCUMENTS:
        lines = "\n".join(pages[first - 1:last]).split("\n")
        parsed = parse_document(prefix, name, lines, mode)

        if mode == "article":
            # 번호가 중간에 끊기면 조항을 흘린 것이다.
            numbers = [int(re.search(r"-제(\d+)조", a["id"]).group(1))
                       for a in parsed if "-제" in a["id"] and "의" not in a["id"]]
            gaps = [n for n in range(1, max(numbers, default=0) + 1) if n not in numbers]
            if gaps:
                print(f"경고: {name}에서 못 찾은 조 번호 {gaps}")

        before = len(pieces)
        for a in parsed:
            pieces.extend(split_long(a))
        print(f"{name:<32} {first:>3}~{last:<3}쪽  조항 {len(parsed):>3}개 -> 조각 {len(pieces) - before}개")

    ids = [p["id"] for p in pieces]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        print(f"경고: 겹치는 id {dupes}")

    for p in pieces:
        p["chars"] = len(p["text"])

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(pieces, f, ensure_ascii=False, indent=2)

    print(f"문서 {len(DOCUMENTS)}개 -> 조각 {len(pieces)}개 -> {dst}")
    print(f"평균 길이 {sum(p['chars'] for p in pieces) // len(pieces)}자, "
          f"최장 {max(p['chars'] for p in pieces)}자")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
