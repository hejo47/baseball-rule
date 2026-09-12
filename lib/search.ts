import rules from "@/data/rules.json";
import league from "@/data/league.json";
import synonyms from "@/data/synonyms.json";
import vectorFile from "@/data/vectors.json";
import { embedQuery } from "@/lib/embedding";

export interface RuleEntry {
  id: string;
  title: string;
  chapter: string;
  /** "규칙" | "정의" | "리그규정" */
  type: string;
  /** 어느 문서에서 왔는지. 답변에서 근거 문서를 구분해 보여줄 때 쓴다. */
  source: string;
  text: string;
  chars: number;
  english?: string;
}

export interface SearchResult extends RuleEntry {
  score: number;
}

// 야구규칙과 리그 규정을 한 묶음으로 검색한다.
//
// 두 문서는 다루는 범위가 겹치지 않는다. 야구규칙에는 비디오 판독, 피치클락,
// 엔트리 같은 운영 규정이 아예 없어서 예전에는 "규칙집에서 찾지 못했습니다"로
// 답할 수밖에 없었다.
//
// data/vectors.json이 이 순서대로 만들어져 있다. 순서를 바꾸면
// scripts/build-vectors.mjs도 같이 바꾸고 벡터를 다시 만들어야 한다.
const DOCS = [...rules, ...league] as RuleEntry[];

interface Synonym {
  words: string[];
  expand: string[];
  note?: string;
}

const SYNONYMS = synonyms as Synonym[];

// 제목 쪽이 본문보다 정확한 신호지만, 0.85까지 몰아주면 답이 본문에만 있는
// 질문을 아예 못 찾는다. ("몸에 맞는 공"의 정답 5.06⒞는 제목이 "주루"라
// 질문과 한 글자도 안 겹치고, 본문에만 그 문장이 있다.)
const TITLE_WEIGHT = 0.55;
const TEXT_WEIGHT = 0.45;

// 화면과 채점에 넘길 최대 개수.
//
// 글자 검색만 쓰던 때는 점수가 0인 조항이 알아서 걸러져 보통 30~40개가
// 남았다. 뜻 점수는 아무 조항에나 0보다 큰 값을 주기 때문에 그냥 두면
// 251개가 전부 딸려와 응답이 400KB가 되고 화면에도 "검색된 조항 251개"가
// 뜬다. AI는 어차피 상위 8개만 보고, 사람이 눈으로 훑는 것도 그쯤이다.
export const RESULT_LIMIT = 30;

// 글자 점수와 뜻 점수를 섞는 비율. 반반이 가장 좋았다.
// 뜻만 쓰면 "낫아웃"이 20등까지 밀리고, 글자만 쓰면 "아웃이란 뭐야?"가
// 23등으로 밀린다. 서로 다른 구멍이라 둘을 같이 써야 메워진다.
const EMBEDDING_WEIGHT = 0.5;

// 문서 벡터는 build-vectors.mjs가 길이를 1로 맞춰 저장했다.
// 그래서 코사인 유사도가 그냥 내적이 된다.
const DOC_VECTORS: number[][] = vectorFile.vectors;

// 규칙집만 바꾸고 벡터를 다시 안 만들면 순서가 어긋나 엉뚱한 조항이
// 엉뚱한 점수를 받는다. 조용히 틀리느니 바로 알아차리게 한다.
if (DOC_VECTORS.length !== DOCS.length) {
  throw new Error(
    `data/vectors.json이 ${DOC_VECTORS.length}개인데 data/rules.json은 ${DOCS.length}개입니다. ` +
      `npm run build:vectors를 다시 돌리세요.`,
  );
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

// 한글은 띄어쓰기 기반 토큰화가 어려워 문자 바이그램으로 대체한다.
function bigrams(text: string): string[] {
  const normalized = normalize(text);
  if (normalized.length < 2) return normalized ? [normalized] : [];
  const grams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i++) {
    grams.push(normalized.slice(i, i + 2));
  }
  return grams;
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }
  return tf;
}

interface VectorSpace {
  vectors: Map<string, number>[];
  norms: number[];
  idf: Map<string, number>;
}

// 문서 집합의 텍스트들로부터 TF-IDF 벡터 공간을 만든다.
// 제목/본문을 따로 색인해야 각자의 문서 집합 안에서 흔한 조각(idf)이
// 따로 계산돼, 제목만의 특징적인 글자 조합이 묻히지 않는다.
function buildVectorSpace(texts: string[]): VectorSpace {
  const docTokens = texts.map(bigrams);

  const df = new Map<string, number>();
  docTokens.forEach((tokens) => {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  });

  const N = texts.length;
  const idf = new Map<string, number>();
  df.forEach((count, term) => {
    idf.set(term, Math.log(N / count) + 1);
  });

  const vectors = docTokens.map((tokens) => {
    const tf = termFrequency(tokens);
    const vector = new Map<string, number>();
    tf.forEach((count, term) => {
      vector.set(term, count * (idf.get(term) ?? 0));
    });
    return vector;
  });

  const norms = vectors.map((vector) =>
    Math.sqrt(Array.from(vector.values()).reduce((sum, w) => sum + w * w, 0)),
  );

  return { vectors, norms, idf };
}

function cosineScores(space: VectorSpace, query: string): number[] {
  const queryTf = termFrequency(bigrams(query));
  const queryVector = new Map<string, number>();
  queryTf.forEach((count, term) => {
    const weight = count * (space.idf.get(term) ?? 0);
    if (weight > 0) queryVector.set(term, weight);
  });
  const queryNorm = Math.sqrt(
    Array.from(queryVector.values()).reduce((sum, w) => sum + w * w, 0),
  );

  if (queryNorm === 0) return space.vectors.map(() => 0);

  return space.vectors.map((vector, i) => {
    const norm = space.norms[i];
    if (norm === 0) return 0;
    let dot = 0;
    queryVector.forEach((qWeight, term) => {
      const dWeight = vector.get(term);
      if (dWeight) dot += qWeight * dWeight;
    });
    return dot / (queryNorm * norm);
  });
}

interface Index {
  titleSpace: VectorSpace;
  englishSpace: VectorSpace;
  textSpace: VectorSpace;
}

let cached: Index | null = null;

// 제목과 영문명을 "아웃 OUT"처럼 한 덩어리로 색인하면, 안 쓰는 쪽이 벡터
// 길이만 늘려 점수를 깎아먹는다. 한글로 "아웃"을 물으면 제목이 "아웃"뿐인
// 조항은 0.86을 받는데 "아웃 OUT"인 정의-54는 0.287까지 떨어졌다.
// 따로 색인해 둘 중 높은 쪽을 쓰면 어느 쪽으로 물어도 손해가 없다.
function getIndex(): Index {
  if (!cached) {
    warnDeadSynonyms();
    cached = {
      titleSpace: buildVectorSpace(DOCS.map((doc) => doc.title)),
      englishSpace: buildVectorSpace(DOCS.map((doc) => doc.english ?? "")),
      textSpace: buildVectorSpace(DOCS.map((doc) => doc.text)),
    };
  }
  return cached;
}

// 규칙집이 거의 쓰지 않는 말만 확장 대상으로 남긴다.
//
// 규칙집에 있는 말까지 바꿔주면 오히려 나빠진다. "주루방해"는 제목
// "업스트럭션·주루방해"에 그대로 있어 원래도 6등이었는데, 흔한 말인
// "방해"(67개 조항)를 섞자 16등으로 밀렸다.
//
// 규칙집에 실제로 쓰이는 말은 3개 조항 이상에서 나오고, 사람들만 쓰는
// 말은 0~2개다. ("태그업"은 규칙집이 "태그 업(tag up)"으로 적어 3개다.)
const RARE_MAX_DOCS = 2;

let wordFrequency: Map<string, number> | null = null;

function isRare(word: string): boolean {
  if (!wordFrequency) {
    const corpus = DOCS.map((doc) => normalize(`${doc.title}${doc.text}`));
    wordFrequency = new Map();
    for (const entry of SYNONYMS) {
      for (const w of entry.words) {
        const key = normalize(w);
        if (wordFrequency.has(key)) continue;
        wordFrequency.set(key, corpus.filter((doc) => doc.includes(key)).length);
      }
    }
  }
  return (wordFrequency.get(normalize(word)) ?? 0) <= RARE_MAX_DOCS;
}

/**
 * 사전 항목이 조용히 꺼지지 않았는지 확인한다.
 *
 * 확장은 '규칙집이 거의 쓰지 않는 말'에만 걸린다. 그래서 문서를 새로 넣으면
 * 그 말이 흔해져 항목이 저절로 멈출 수 있다. 실제로 리그 규정을 넣자
 * "몸에 맞는 공"이 2개 조항에서 나오게 돼 경계선(RARE_MAX_DOCS)에 걸렸다.
 * 하나만 더 늘면 검색이 조용히 나빠지므로 로그로 알린다.
 */
function warnDeadSynonyms(): void {
  for (const entry of SYNONYMS) {
    if (entry.words.some(isRare)) continue;
    console.warn(
      `사전 항목이 동작하지 않습니다: ${entry.words.join(", ")} — ` +
        `규칙집에 너무 흔해져 확장이 걸리지 않습니다. data/synonyms.json을 확인하세요.`,
    );
  }
}

// 사람들이 쓰는 말과 규칙집의 말이 다르면 글자가 겹치지 않아 아예 못 찾는다.
// ("낫아웃", "몸에 맞는 공"은 규칙집에 한 번도 나오지 않는다.)
// 질문에 그런 말이 있으면 규칙집 표현을 더한 질문을 하나 더 만든다.
function expandQuery(query: string): string | null {
  const normalized = normalize(query);
  const added = SYNONYMS.filter((entry) =>
    entry.words.some(
      (word) => isRare(word) && normalized.includes(normalize(word)),
    ),
  ).flatMap((entry) => entry.expand);

  return added.length === 0 ? null : `${query} ${added.join(" ")}`;
}

// 제목 유사도와 본문 유사도를 따로 계산해 제목 쪽에 더 큰 가중치로 합친다.
// 제목 점수는 한글 제목과 영문명 중 높은 쪽을 쓴다.
function lexicalScores(query: string): number[] {
  const { titleSpace, englishSpace, textSpace } = getIndex();
  const titleScores = cosineScores(titleSpace, query);
  const englishScores = cosineScores(englishSpace, query);
  const textScores = cosineScores(textSpace, query);
  return DOCS.map(
    (_, i) =>
      Math.max(titleScores[i], englishScores[i]) * TITLE_WEIGHT +
      textScores[i] * TEXT_WEIGHT,
  );
}

/** 글자가 얼마나 겹치는지로만 매긴 점수. 사전 확장까지 마친 결과다. */
function lexicalWithSynonyms(query: string): number[] {
  const scores = lexicalScores(query);

  // 확장한 질문은 따로 채점해 더 높은 쪽을 쓴다. 원래 질문 뒤에 붙이면
  // 확장어(흔한 말이 섞이기 쉽다)가 원래 질문의 비중을 깎아, 이미 잘 찾던
  // 질문까지 밀려났다. ("주루방해" 6등 -> 16등)
  const expanded = expandQuery(query);
  if (expanded) {
    const expandedScores = lexicalScores(expanded);
    for (let i = 0; i < scores.length; i++) {
      scores[i] = Math.max(scores[i], expandedScores[i]);
    }
  }
  return scores;
}

/** 질문 벡터와 각 조각 벡터의 코사인 유사도. 벡터가 이미 길이 1이라 내적이다. */
function semanticScores(queryVector: number[]): number[] {
  const norm = Math.sqrt(queryVector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return DOC_VECTORS.map(() => 0);
  const unit = queryVector.map((v) => v / norm);

  return DOC_VECTORS.map((docVector) => {
    let dot = 0;
    for (let i = 0; i < unit.length; i++) dot += unit[i] * docVector[i];
    return dot;
  });
}

// 두 점수는 눈금이 다르다. 글자 점수는 0.05~0.87, 뜻 점수는 0.07~0.58로
// 나온다. 그냥 더하면 글자 쪽이 일방적으로 이기므로 각자 그 질문에서의
// 최댓값으로 나눠 0~1로 맞춘 뒤 섞는다.
function normalized(scores: number[]): number[] {
  const max = Math.max(...scores);
  return max > 0 ? scores.map((s) => s / max) : scores;
}

function rank(scores: number[], topK?: number): SearchResult[] {
  const sorted = DOCS.map((entry, i) => ({ entry, score: scores[i] }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return (topK === undefined ? sorted : sorted.slice(0, topK)).map(
    ({ entry, score }) => ({ ...entry, score }),
  );
}

/**
 * 글자 검색만으로 순위를 매긴다. 외부 호출이 없어 즉시 끝난다.
 * 뜻 검색을 쓸 수 없을 때(키 없음, API 실패) 이걸로 답한다.
 */
export function searchByLetters(query: string, topK?: number): SearchResult[] {
  return rank(lexicalWithSynonyms(query), topK);
}

/**
 * 글자와 뜻을 같이 보고 순위를 매긴다.
 *
 * 질문을 벡터로 바꾸느라 API를 한 번 타므로 300ms 안팎이 더 걸린다.
 * 실패하면 글자 검색 결과를 그대로 돌려준다. 느려지거나 덜 정확해질 뿐
 * 검색이 죽지는 않는다.
 *
 * topK를 생략하면 점수가 0보다 큰 조항을 전부 반환한다.
 */
export async function search(
  query: string,
  topK?: number,
): Promise<SearchResult[]> {
  const letters = lexicalWithSynonyms(query);

  const queryVector = await embedQuery(query);
  if (!queryVector) return rank(letters, topK);

  const meaning = normalized(semanticScores(queryVector));
  const byLetters = normalized(letters);
  const blended = byLetters.map(
    (s, i) => s * (1 - EMBEDDING_WEIGHT) + meaning[i] * EMBEDDING_WEIGHT,
  );

  return rank(blended, topK);
}
