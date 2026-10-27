"""
2026 KBO 리그 규정 PDF -> 조항 단위 JSON

사용법:
    pdftotext -layout 2026_리그규정.pdf raw.txt
    python build_league.py raw.txt league.json

야구규칙(build_rules.py)과 별개 문서다. 야구규칙에는 비디오 판독, 엔트리,
경기일정 같은 운영 규정이 없어서 "규칙집에서 찾지 못했습니다"로 답하던
질문들이 여기에 답을 갖고 있다.

조 번호가 1부터 끝까지 중복 없이 이어지는 문서라, 번호가 순서대로
늘어나는 줄만 조항 시작으로 인정한다. 본문 속 '제28조 참조' 같은
상호참조는 순서를 거스르므로 걸러진다.
"""

import json
import re
import sys

# 쪼갠 조각의 제목에 항목 머리말을 붙이는 규칙은 야구규칙과 같게 쓴다.
from build_rules import TITLE_JOIN, with_item_label

TOC_PAGES = (7, 10)   # 목차 (쪽 번호, 양끝 포함)
BODY_START_PAGE = 13  # 제1장 제1조가 시작하는 쪽 (앞은 표지·목차·변경요약)

# 조 뒤에 붙는 부록들. 목차에 '■ 제목'으로 나온다.
# (고척스카이돔 그라운드룰, ABS 규정, 피치클락 규정, 벌칙내규 등)
# 부록에는 조 번호가 없어서, 잘라주지 않으면 마지막 조항(제78조)이
# 문서 끝까지 통째로 빨아들여 3만 자짜리 덩어리가 된다.
APPENDIX_TOC = re.compile(r"^\s*■\s*(.+?)[\s·․.]*$")

# 쪽번호만 있는 줄. 본문 한가운데 끼어든다.
PAGE_NUMBER = re.compile(r"^\s*\d{1,3}\s*$")

# 장 제목은 '제1장 KBO 정규시즌'처럼 한 줄에 홀로 온다.
# 조 번호가 섞인 줄은 제외한다. '제1장 제6조 준용'(다른 장의 조항을 그대로
# 가져다 쓴다는 뜻)이 장 제목으로 잡히는 바람에 그 줄이 통째로 버려져
# 제61~65조, 제74~75조가 내용 없는 조항이 되어 사라졌었다.
CHAPTER = re.compile(r"^\s{0,20}(제\s?\d{1,2}\s?장\s+(?!.*제\s?\d{1,3}\s?조)[^\n]{1,40}?)\s*$")
ARTICLE = re.compile(r"^\s{0,4}제\s?(\d{1,3})\s?조\s*(.*)$")

# 1단계: '1.' '2.'   2단계: '①' '②'
LEVELS = [
    (re.compile(r"^\s{0,6}(\d{1,2})\.\s*(.*)$"), lambda m: int(m.group(1))),
    (re.compile(r"^\s{0,10}([①-⑳])\s*(.*)$"), lambda m: ord(m.group(1)) - 0x245F),
]
MAX_CHARS = 2500  # 이보다 긴 조각은 다음 단계로 더 쪼갠다


def squash(lines: list[str]) -> str:
    """들여쓰기를 정리하고 빈 줄을 압축한다."""
    text = "\n".join(l.rstrip() for l in lines if not PAGE_NUMBER.match(l))
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def parse_appendix_titles(toc: str) -> list[str]:
    """목차에서 부록 제목을 뽑는다."""
    out = []
    for line in toc.split("\n"):
        m = APPENDIX_TOC.match(line)
        if m and len(m.group(1)) >= 4:
            out.append(re.sub(r"\s+", " ", m.group(1)).strip())
    return out


def parse_articles(text: str, appendices: list[str]) -> list[dict]:
    """본문을 조항(제N조) 단위로 자른다. 번호가 1씩 늘어나는 줄만 인정한다."""
    chunks, current, chapter, last = [], None, "", 0
    wanted = {re.sub(r"\s+", "", t): t for t in appendices}
    seen = set()

    for line in text.split("\n"):
        # 부록 제목 줄을 만나면 거기서부터 새 조각이다.
        flat = re.sub(r"\s+", "", line)
        if flat in wanted and flat not in seen:
            seen.add(flat)
            title = wanted[flat]
            if current:
                chunks.append(current)
            current = {
                "id": "리그-부록-" + flat,
                "title": title,
                "chapter": "부록",
                "type": "리그규정",
                "source": "KBO 리그 규정",
                "lines": [],
            }
            continue

        c = CHAPTER.match(line)
        if c and not ARTICLE.match(line):
            chapter = re.sub(r"\s+", " ", c.group(1)).strip()
            continue

        m = ARTICLE.match(line)
        if m and int(m.group(1)) == last + 1:
            last += 1
            if current:
                chunks.append(current)
            current = {
                "id": f"리그-제{last}조",
                "title": m.group(2).strip(),
                "chapter": chapter,
                "type": "리그규정",
                "source": "KBO 리그 규정",
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
            "title": with_item_label(article["title"], p["lines"][0]),
            "text": (intro + "\n\n" if intro else "") + p["marker"] + " " + body,
        }
        out.extend(split_long(piece, level + 1))
    return out or [article]


def disambiguate(chunks: list[dict]) -> int:
    """다른 장에 같은 이름으로 있는 조항은 제목에 장 이름을 붙인다. 바꾼 개수를 돌려준다.

    '경기방식'은 정규시즌(제1조), 한국시리즈(제42조), 퓨처스리그(제59조) 등 6개 장에
    따로 있고 내용도 다르다. 제목이 같으면 글자 점수를 똑같이 받아 질문이 어느
    장을 묻는지 가리지 못한다. -> '경기방식 (KBO 한국시리즈)'
    부록은 이름이 겹치지 않아 건드리지 않는다. 여러 번 돌려도 결과가 같다.
    """
    def base(c):
        return c["title"].split(TITLE_JOIN)[0]

    def chapter_name(c):
        return re.sub(r"^제\s?\d+\s?장\s*", "", c["chapter"])

    articles: dict[str, set[str]] = {}
    for c in chunks:
        m = re.match(r"^(리그-제\d+조)", c["id"])
        if m:
            name = re.sub(r" \([^)]*\)$", "", base(c))
            articles.setdefault(name, set()).add(m.group(1))

    changed = 0
    for c in chunks:
        if not c["id"].startswith("리그-제"):
            continue
        name = re.sub(r" \([^)]*\)$", "", base(c))
        if len(articles.get(name, ())) < 2:
            continue
        rest = c["title"][len(base(c)):]
        title = f"{name} ({chapter_name(c)}){rest}"
        if title != c["title"]:
            c["title"] = title
            changed += 1
    return changed


def retitle(chunks: list[dict]) -> int:
    """이미 만든 JSON의 쪼갠 조각에 항목 머리말 제목을 붙인다(build_rules.retitle과 같은 일).

    리그 규정 조각 번호는 '리그-제28조-3', '리그-부록-KBO피치클락규정-1-①'처럼
    '-' 뒤에 단계별 항목 번호가 붙는다. 본문에는 split_long이 '3 비디오 판독 ...'처럼
    항목 번호 + 띄어쓰기로 남겨 두었다.
    """
    changed = 0
    for c in chunks:
        m = re.match(r"^(리그-제\d+조|리그-부록-[^-]+)((?:-[^-]+)+)$", c["id"])
        if not m:
            continue
        title = c["title"].split(TITLE_JOIN)[0]
        lines = c["text"].split("\n")
        at = 0
        for marker in m.group(2).split("-")[1:]:
            for i in range(at, len(lines)):
                hit = re.match(rf"^\s*{re.escape(marker)}\.?\s+(.*)$", lines[i])
                if hit:
                    title = with_item_label(title, hit.group(1))
                    at = i + 1
                    break
        if title != c["title"]:
            c["title"] = title
            changed += 1
    return changed


# PDF의 표를 글자로 뽑으면 칸 이름이 엉뚱한 줄에 섞인다. 고척돔 그라운드룰은
# '파울지역', '내야 페어지역'이 ②번 줄 앞에 붙어, 모델이 "천장에 낀 공은 파울"을
# 모든 경우의 규칙으로 읽었다(261027). 내용은 그대로 두고 칸별로 다시 적는다.
# 바꿀 부분: 원문 첫 글자부터 END 표시까지. END는 바꾼 글에도 그대로 남는다.
TABLE_FIXES = {
    "리그-부록-고척스카이돔그라운드룰": {
        "end": "* 내, 외야 페어지역 구분 – 천장 상단 3번째 통로(캣워크) 시작점",
        "text": """구분: 적용 내용

[파울지역]
 ① 천장(스피커 등 포함)에 맞은 경우 → 파울
 ② 천장(스피커 등 포함)에 낀 경우 → 파울
 ③ 홈베이스 위쪽 천장에 낀 경우 → 파울

[내야 페어지역]
 ① 천장(스피커 등 포함)에 맞고 낙하한 볼을 포구 → 아웃
 ② 천장(스피커 등 포함)에 낀 경우 → 볼 데드
 (타자, 주자 → 안전진루권 2개루)
 ③ 천장(스피커 등 포함)에 맞고 낙하한 볼을 포구하지 못했을 경우 → 인플레이

[외야 페어지역]
 타구가 천장 상단 3번째 통로(캣워크) 시작점 이후 외야 페어지역 부터
 천장 또는 시설물(스피커, 홍보물 등)에 맞거나 낀 경우 → 홈런

[기타]
 천장에 맞거나 낀 경우 등 확인이 필요한 판정에 대해서는 횟수와
 상관없이 비디오 판독 신청 가능

 (2018.1.24 규칙위원회)
""",
    },
}


def fix_tables(chunks: list[dict]) -> int:
    """TABLE_FIXES의 표를 칸별로 다시 적는다. 이미 고친 조각은 건너뛴다."""
    changed = 0
    for c in chunks:
        fix = TABLE_FIXES.get(c["id"])
        if not fix or c["text"].startswith(fix["text"]):
            continue
        at = c["text"].find(fix["end"])
        if at < 0:
            raise SystemExit(f"{c['id']}: 표 끝 표시를 못 찾았습니다. PDF가 바뀌었으면 TABLE_FIXES를 고치세요.")
        c["text"] = fix["text"] + c["text"][at:]
        c["chars"] = len(c["text"])
        changed += 1
    return changed


def main(src: str, dst: str) -> None:
    raw = open(src, encoding="utf-8").read()
    pages = raw.split("\f")
    toc = "\n".join(pages[TOC_PAGES[0] - 1:TOC_PAGES[1]])
    body = "\n".join(pages[BODY_START_PAGE - 1:])

    appendices = parse_appendix_titles(toc)
    parsed = parse_articles(body, appendices)

    found_app = {a["title"] for a in parsed if a["chapter"] == "부록"}
    missed_app = [t for t in appendices if t not in found_app]
    if missed_app:
        print(f"경고: 목차에 있는데 본문에서 못 찾은 부록 {len(missed_app)}개")
        for t in missed_app:
            print(f"  {t}")

    # 번호가 중간에 끊기면 조항을 흘린 것이다.
    numbers = [int(re.search(r"제(\d+)조", a["id"]).group(1))
               for a in parsed if a["chapter"] != "부록"]
    gaps = [n for n in range(1, max(numbers) + 1) if n not in numbers]
    if gaps:
        print(f"경고: 못 찾은 조 번호 {gaps}")

    pieces = []
    for a in parsed:
        pieces.extend(split_long(a))
    disambiguate(pieces)
    fix_tables(pieces)

    for p in pieces:
        p["chars"] = len(p["text"])

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(pieces, f, ensure_ascii=False, indent=2)

    n_art = sum(1 for a in parsed if a["chapter"] != "부록")
    print(f"조항 제1조~제{max(numbers)}조 {n_art}개 + 부록 {len(found_app)}개"
          f" -> 조각 {len(pieces)}개 -> {dst}")
    print(f"평균 길이 {sum(p['chars'] for p in pieces) // len(pieces)}자, "
          f"최장 {max(p['chars'] for p in pieces)}자")


if __name__ == "__main__":
    # python build_league.py --retitle data/league.json
    #   PDF 없이 이미 만든 JSON의 쪼갠 조각 제목만 다시 붙인다.
    if sys.argv[1] == "--retitle":
        path = sys.argv[2]
        chunks = json.load(open(path, encoding="utf-8"))
        n = retitle(chunks) + disambiguate(chunks)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False, indent=2)
        print(f"제목을 다시 붙인 조각 {n}개 -> {path}")
    elif sys.argv[1] == "--fix-tables":
        # python build_league.py --fix-tables data/league.json
        #   PDF 없이 이미 만든 JSON의 표만 칸별로 다시 적는다.
        path = sys.argv[2]
        chunks = json.load(open(path, encoding="utf-8"))
        n = fix_tables(chunks)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False, indent=2)
        print(f"표를 다시 적은 조각 {n}개 -> {path}")
    else:
        main(sys.argv[1], sys.argv[2])
