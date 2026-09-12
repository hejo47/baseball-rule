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
            "text": (intro + "\n\n" if intro else "") + p["marker"] + " " + body,
        }
        out.extend(split_long(piece, level + 1))
    return out or [article]


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
    main(sys.argv[1], sys.argv[2])
