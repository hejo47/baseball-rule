/**
 * 글자 점수(BM25)에 쓰는 형태소 분석.
 *
 * 처음에는 글자를 두 개씩 겹쳐 잘랐다("인필드플라이" -> 인필/필드/드플/...).
 * 한국어 검색 실무는 형태소 분석 + BM25를 쓰고, 그쪽이 정확도가 크게 높다고
 * 알려져 있다. 우리 데이터에서도 시험 밖 질문 12개의 평균 순위가 7.2등 -> 4.7등으로
 * 올랐다(261007, docs/search.md 5절).
 *
 * 분석기는 oktjs(Open Korean Text의 자바스크립트 판)를 쓴다. Kiwi도 재봤는데
 * 성능은 비슷하고 모델이 105MB, 메모리가 1GB 가까이 들어 배포 부담이 컸다.
 * 분석기를 바꿀 때는 이 파일만 고치고 npm run build:tokens를 다시 돌리면 된다.
 *
 * scripts/build-tokens.mjs도 이 파일을 그대로 불러 쓴다(Node가 TypeScript를
 * 직접 읽는다). 앱과 스크립트가 같은 규칙으로 잘라야 검색이 맞으므로, 여기에는
 * 타입만 지우면 돌아가는 문법만 쓰고 "@/" 경로도 쓰지 않는다.
 */
import { createHash } from "node:crypto";
import { normalize, tokenize as oktTokenize } from "oktjs";

/** 분석기 이름. data/tokens.json에 같이 적어, 바꾸면 다시 만들게 한다. */
export const TOKENIZER = "oktjs@0.1.3";

// 뜻이 있는 형태소만 남긴다. 조사, 어미, 기호, 띄어쓰기는 뺀다.
const KEEP = new Set([
  "Noun",
  "Verb",
  "Adjective",
  "Adverb",
  "Alpha",
  "Number",
  "Foreign",
  "Unknown",
  "Korean",
]);

/** 글을 형태소로 자른다. 동사·형용사는 원형("맞는" -> "맞다")으로 바꾼다. */
export function tokenize(text: string): string[] {
  return (
    oktTokenize(normalize(text))
      .filter((token) => KEEP.has(token.pos))
      .map((token) => (token.stem ?? token.text).toLowerCase().trim())
      // 규칙집 원문의 줄바꿈이 낱말처럼 섞여 나온다.
      .filter((word) => word !== "")
  );
}

interface LexicalSource {
  id: string;
  title: string;
  english?: string;
  text: string;
}

/**
 * 조항 하나에서 글자 점수로 색인할 글. 제목 칸과 본문 칸을 따로 둔다.
 * 사람이 확인한 사람 말 설명(data/plain.json)은 본문 뒤에 붙인다.
 */
export function lexicalFields(doc: LexicalSource, plain?: string) {
  return {
    title: `${doc.title} ${doc.english ?? ""}`,
    body: plain ? `${doc.text}\n${plain}` : doc.text,
  };
}

/**
 * 색인할 글 전체의 지문. 조항이나 사람 말 설명이 바뀌었는데 data/tokens.json을
 * 다시 안 만들었으면 지문이 달라져 lib/search.ts가 알려준다.
 */
export function fieldsFingerprint(fields: { title: string; body: string }[]) {
  return createHash("sha1")
    .update(TOKENIZER)
    .update(JSON.stringify(fields))
    .digest("hex")
    .slice(0, 16);
}
