import rules from "@/data/rules.json";
import league from "@/data/league.json";
import bylaws from "@/data/bylaws.json";
import synonyms from "@/data/synonyms.json";
import vectorFile from "@/data/vectors.json";
import plain from "@/data/plain.json";
import plainVectorFile from "@/data/plain-vectors.json";
import tokenFile from "@/data/tokens.json";
import { fieldsFingerprint, lexicalFields, tokenize } from "@/lib/tokenizer";
import { embedQuery } from "@/lib/embedding";
import type { PreviousTurn } from "@/lib/conversation";

export interface RuleEntry {
  id: string;
  title: string;
  chapter: string;
  /** "규칙" | "정의" | "리그규정" | "규약" */
  type: string;
  /** 어느 문서에서 왔는지. 답변에서 근거 문서를 구분해 보여줄 때 쓴다. */
  source: string;
  text: string;
  chars: number;
  english?: string;
}

export interface SearchResult extends RuleEntry {
  score: number;
  /** data/plain.json에 적어둔 사람 말 설명. 있는 조항만 붙는다. */
  plain?: string;
}

// 야구규칙, 리그 규정, 규약을 한 묶음으로 검색한다.
//
// 세 문서는 다루는 범위가 거의 겹치지 않는다. 야구규칙에는 비디오 판독, 피치클락,
// 엔트리 같은 운영 규정이 아예 없어서 예전에는 "규칙집에서 찾지 못했습니다"로
// 답할 수밖에 없었다. FA 자격, 선수 정원, 외국인선수 같은 선수 신분과 계약은
// 규약에만 있다.
//
// data/vectors.json이 이 순서대로 만들어져 있다. 순서를 바꾸면
// scripts/build-vectors.mjs도 같이 바꾸고 벡터를 다시 만들어야 한다.
const DOCS = [...rules, ...league, ...bylaws] as RuleEntry[];

// 분야. 경기(야구규칙 + 리그 규정)와 규약을 따로 색인하고, 질문이 어느 쪽에
// 가까운지에 따라 가중치를 준다(domainWeights).
//
// 규약을 한 색인에 그냥 섞었을 때(261023) 조각이 457개에서 911개로 늘며 BM25의
// 희귀도·평균 길이가 바뀌어, 규약과 상관없는 경기 질문 3개가 같은 경기 조각끼리
// 순서가 섞여 밀렸다. 분야마다 따로 색인하면 경기 쪽 순위는 규약을 넣기 전과 같다.
//
// 야구규칙과 리그 규정은 한 분야로 둔다. 서로 엮인 곳이 많고("몸에 맞는 공"이
// 리그 규정의 비디오 판독 대상 목록에도 있다) 지금까지 한 색인에서 문제가 없었다.
const DOMAINS = [
  { name: "경기", start: 0, end: rules.length + league.length },
  { name: "규약", start: rules.length + league.length, end: DOCS.length },
];
const DOMAIN_OF = DOCS.map((_, i) =>
  DOMAINS.findIndex((d) => i >= d.start && i < d.end),
);

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

// 조항마다 붙여둔 사람 말 설명. 검색에만 쓰고 화면과 AI에는 원문만 나간다.
//
// 사전(synonyms.json)은 질문의 '드문 단어' 하나를 규칙집 말로 바꿔줄 뿐이라,
// 상황을 풀어 쓴 질문은 못 잡는다. "라인드라이브로 잡혔는데 1루 베이스를 밟고
// 있지 않은 주자는 태그 안 해도 돼?"의 정답 5.09⒝⑸는 규칙집이 "베이스에 다시
// 닿기 전에"라고만 적어 16등이었다. 사전을 보강해도 14등이었고, 조항 쪽에
// 사람 말 설명을 붙이자 4등이 됐다. (docs/search.md 5절)
const PLAIN = new Map(
  (plain as { id: string; plain: string }[]).map((p) => [p.id, p.plain]),
);
const PLAIN_VECTORS = new Map(
  (plainVectorFile.items as { id: string; plain: string; vector: number[] }[]).map(
    (p) => [p.id, p],
  ),
);

// 없는 조항 번호에 설명을 달거나, 설명만 고치고 벡터를 다시 안 만들면
// 검색이 조용히 틀린다. 바로 알아차리게 한다.
for (const [id, text] of PLAIN) {
  if (!DOCS.some((doc) => doc.id === id)) {
    throw new Error(`data/plain.json의 ${id}는 규칙집에 없는 조항 번호입니다.`);
  }
  if (PLAIN_VECTORS.get(id)?.plain !== text) {
    throw new Error(
      `data/plain.json의 ${id} 설명이 벡터와 다릅니다. npm run build:plain을 다시 돌리세요.`,
    );
  }
}

function normalize(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

// 글자 점수: 조항과 질문을 형태소로 잘라 BM25로 매긴다.
//
// 처음에는 글자를 두 개씩 겹쳐 잘라 TF-IDF 코사인으로 매겼다("인필드플라이" ->
// 인필/필드/드플/...). 뜻 없이 글자만 겹쳐서, 질문에 "라인드라이브"가 있으면
// 라인 드라이브의 '정의' 조항을, "몸에 맞는 공"이 있으면 그 말이 든 비디오 판독
// 목록을 끌어올려 정답을 밀어냈다. 한국어 검색 실무는 형태소 분석 + BM25를 쓴다.
// 바꾸자 시험 밖 질문 12개의 평균 순위가 7.2등 -> 4.7등이 됐다(261007).
//
// 조항 쪽 형태소는 scripts/build-tokens.mjs가 미리 잘라 data/tokens.json에 둔다
// (oktjs로 457개를 자르는 데 15초쯤 걸린다). 질문만 그때그때 자른다.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface Bm25Field {
  counts: Map<string, number>[];
  lengths: number[];
  averageLength: number;
  idf: Map<string, number>;
}

function buildBm25(docsTokens: string[][]): Bm25Field {
  const counts = docsTokens.map((tokens) => {
    const count = new Map<string, number>();
    for (const token of tokens) count.set(token, (count.get(token) ?? 0) + 1);
    return count;
  });
  const df = new Map<string, number>();
  for (const count of counts) {
    for (const token of count.keys()) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const N = docsTokens.length;
  const idf = new Map<string, number>();
  df.forEach((n, token) => idf.set(token, Math.log(1 + (N - n + 0.5) / (n + 0.5))));
  const lengths = docsTokens.map((tokens) => tokens.length);
  const averageLength = lengths.reduce((sum, n) => sum + n, 0) / N;
  return { counts, lengths, averageLength, idf };
}

function bm25Scores(field: Bm25Field, queryTokens: string[]): number[] {
  return field.counts.map((count, i) => {
    let score = 0;
    for (const token of queryTokens) {
      const f = count.get(token);
      if (!f) continue;
      const lengthNorm =
        1 - BM25_B + (BM25_B * field.lengths[i]) / field.averageLength;
      score +=
        (field.idf.get(token) ?? 0) * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * lengthNorm));
    }
    return score;
  });
}

// 규칙집이나 사람 말 설명만 고치고 data/tokens.json을 다시 안 만들면 조항과
// 형태소가 어긋나 검색이 조용히 틀린다. 바로 알아차리게 한다.
if (
  tokenFile.ids.length !== DOCS.length ||
  tokenFile.fingerprint !==
    fieldsFingerprint(DOCS.map((doc) => lexicalFields(doc, PLAIN.get(doc.id))))
) {
  throw new Error(
    "data/tokens.json이 지금 규칙집·사람 말 설명과 맞지 않습니다. npm run build:tokens를 다시 돌리세요.",
  );
}

interface Index {
  title: Bm25Field;
  english: Bm25Field;
  body: Bm25Field;
}

interface Indexes {
  /** 분야마다 따로 만든 색인. 순위는 이걸로 매긴다. */
  byDomain: Index[];
  /**
   * 분야를 가리지 않은 색인. 분야 판별의 글자 증거와, 질문 벡터가 없을 때 쓴다.
   * 분야별 색인의 점수끼리는 비교할 수 없다. 규약에는 "주자" 같은 경기 말이 드물어
   * 희귀도가 부풀려지기 때문이다.
   */
  all: Index;
}

let cached: Indexes | null = null;

// 제목, 영문명, 본문(본문 + 사람 말 설명)을 따로 색인한다.
// 각자의 문서 집합 안에서 흔한 말(idf)이 따로 계산돼, 제목만의 특징이 묻히지 않는다.
function getIndex(): Indexes {
  if (!cached) {
    warnDeadSynonyms();
    const build = (start: number, end: number): Index => ({
      title: buildBm25(tokenFile.title.slice(start, end)),
      english: buildBm25(tokenFile.english.slice(start, end)),
      body: buildBm25(tokenFile.body.slice(start, end)),
    });
    cached = {
      byDomain: DOMAINS.map(({ start, end }) => build(start, end)),
      all: build(0, DOCS.length),
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

// 칸마다 그 질문의 최고점으로 나눈다. 제목 점수는 한글 제목과 영문명 중 높은 쪽을
// 쓰고, 본문보다 큰 가중치로 합친다.
// 규칙집은 공이 몸에 부딪히는 걸 "맞다"와 "닿다" 둘 다로 쓴다("새에게 맞았을 경우",
// "페어 볼에 닿았을 경우"). 사람은 거의 "맞다"로만 묻는다. 질문에 "맞다"가 있으면
// "닿다"도 같이 찾는다. 조항 쪽은 건드리지 않는다("규정에 맞게"처럼 다른 뜻도 있다).
const SAME_MEANING: Record<string, string[]> = { 맞다: ["닿다"] };

// 묻는 말투에서만 나오는 형태소는 질문 쪽에서 버린다. 조항에는 거의 안 나와서
// BM25가 드문 말로 보고 큰 점수를 주는데, 무엇을 묻는지와 상관이 없다.
// "몇"은 조항 1개, "돼"를 잘못 자른 "돼다"는 4개에만 있어, "승부조작하면 어떻게
// 돼?"에서 '돼다'가 든 규칙 조항이 '승부조작'이 든 규약 조항보다 높았다(261023).
//
// "하다", "되다", "있다", "수"는 반대로 거의 모든 조항에 있어 BM25 점수는 작지만,
// 제목 칸은 그 질문의 최고점으로 나누기 때문에 다른 말이 제목에 안 걸리면 제목에
// "하다"가 든 조항이 제목 칸 1.0을 받는다. "승부조작하면"이 승부조작 + 하다로 잘려
// 제목에 '하다'가 든 경기 조항들이 본문에 '승부조작'이 든 규약 조항을 이겼다.
const QUESTION_WORDS = new Set([
  "돼다", "어떻다", "몇", "얼마", "언제", "뭐",
  "하다", "되다", "있다", "수",
]);

// byDomain: 분야별 색인으로 매기고 분야마다 최고점으로 나눈다.
//           false면 분야를 가리지 않은 색인으로 매기고 전체 최고점으로 나눈다.
function lexicalScores(query: string, byDomain: boolean): number[] {
  const index = getIndex();
  const words = [
    ...new Set(
      tokenize(query)
        .filter((w) => !QUESTION_WORDS.has(w))
        .flatMap((w) => [w, ...(SAME_MEANING[w] ?? [])]),
    ),
  ];
  const field = (pick: (i: Index) => Bm25Field) =>
    byDomain
      ? normalizedByDomain(index.byDomain.flatMap((i) => bm25Scores(pick(i), words)))
      : normalized(bm25Scores(pick(index.all), words));
  const titleScores = field((i) => i.title);
  const englishScores = field((i) => i.english);
  const bodyScores = field((i) => i.body);
  return DOCS.map(
    (_, i) =>
      Math.max(titleScores[i], englishScores[i]) * TITLE_WEIGHT +
      bodyScores[i] * TEXT_WEIGHT,
  );
}

/** 글자가 얼마나 겹치는지로만 매긴 점수. 사전 확장까지 마친 결과다. */
function lexicalWithSynonyms(query: string, byDomain: boolean): number[] {
  const scores = lexicalScores(query, byDomain);

  // 확장한 질문은 따로 채점해 더 높은 쪽을 쓴다. 원래 질문 뒤에 붙이면
  // 확장어(흔한 말이 섞이기 쉽다)가 원래 질문의 비중을 깎아, 이미 잘 찾던
  // 질문까지 밀려났다. ("주루방해" 6등 -> 16등)
  const expanded = expandQuery(query);
  if (expanded) {
    const expandedScores = lexicalScores(expanded, byDomain);
    for (let i = 0; i < scores.length; i++) {
      scores[i] = Math.max(scores[i], expandedScores[i]);
    }
  }
  return scores;
}

/**
 * 질문 벡터와 각 조각 벡터의 코사인 유사도. 벡터가 이미 길이 1이라 내적이다.
 * 사람 말 설명이 있는 조항은 원문과 설명 중 질문에 더 가까운 쪽을 쓴다.
 */
function toUnit(vector: number[]): number[] | null {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? null : vector.map((v) => v / norm);
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function semanticScores(unit: number[]): number[] {
  return DOC_VECTORS.map((docVector, i) => {
    const plainVector = PLAIN_VECTORS.get(DOCS[i].id)?.vector;
    return plainVector
      ? Math.max(dot(unit, docVector), dot(unit, plainVector))
      : dot(unit, docVector);
  });
}

// 질문이 어느 분야에 가까운지는 뜻과 글자 두 증거를 반반 섞어 정한다.
// 둘 다 이미 계산한 것을 다시 쓰므로 API를 더 타지 않는다.
//
// 분야 하나만 검색하지 않고 둘 다 검색한 뒤 먼 쪽 점수를 깎는다. 판별이 틀렸을 때
// 정답이 아예 사라지면 안 된다. 경계에 걸친 질문("외국인 선수도 비디오 판독 신청할
// 수 있어?", "부상자 명단에 올리면 며칠 뒤에 돌아와?")은 실제로 판별이 갈린다.
//
// 뜻: 질문 벡터를 분야별 평균 벡터(중심)와 비교한다. (규약 중심과의 유사도 - 경기
// 중심과의 유사도)는 시험 46문항에서 경기 질문이 -0.32~-0.004, 규약 질문이
// +0.02~+0.08로 갈렸다(261023). 그 사이에 걸치는 질문은 둘 다 거의 그대로 두고,
// 멀어질수록 먼 쪽을 깎는다.
//
// 글자: 분야를 가리지 않은 글자 검색 상위 5개 중 규약 조각의 비율. 뜻만 보면
// "승부조작하면 어떻게 돼?"가 경기 쪽(-0.07)으로 판별돼, 규약 제148조(부정행위)에
// 글자 그대로 있는 말인데도 반칙 조항만 나왔다. 그 분야에만 있는 말이 질문에 있으면
// 글자 쪽이 잡는다.
const DOMAIN_MIDPOINT = 0.005;
const DOMAIN_SPREAD = 0.015;
const LEXICAL_VOTES = 5;
// 확실할 때 먼 쪽 분야에 남기는 가중치. 0이면 그 분야를 아예 버린다.
const OTHER_DOMAIN_FLOOR = 0.3;

let centroids: number[][] | null = null;

function domainWeights(unit: number[], lettersAll: number[]): number[] {
  if (!centroids) {
    centroids = DOMAINS.map(({ start, end }) => {
      const vectors = DOC_VECTORS.slice(start, end);
      const sum = vectors[0].map((_, j) => vectors.reduce((s, v) => s + v[j], 0));
      return toUnit(sum) ?? sum;
    });
  }
  const [game, bylaw] = centroids.map((c) => dot(unit, c));
  const byMeaning = 1 / (1 + Math.exp(-(bylaw - game - DOMAIN_MIDPOINT) / DOMAIN_SPREAD));

  const top = lettersAll
    .map((score, i) => ({ score, i }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LEXICAL_VOTES);
  const byLetters = top.length
    ? top.filter((s) => DOMAIN_OF[s.i] === 1).length / top.length
    : byMeaning;

  const pBylaw = (byMeaning + byLetters) / 2;
  const likelihood = [1 - pBylaw, pBylaw];
  const best = Math.max(...likelihood);
  return likelihood.map(
    (p) => OTHER_DOMAIN_FLOOR + (1 - OTHER_DOMAIN_FLOOR) * (p / best),
  );
}

// 두 점수는 눈금이 다르다. 글자 점수는 0.05~0.87, 뜻 점수는 0.07~0.58로
// 나온다. 그냥 더하면 글자 쪽이 일방적으로 이기므로 각자 그 질문에서의
// 최댓값으로 나눠 0~1로 맞춘 뒤 섞는다.
function normalized(scores: number[]): number[] {
  const max = Math.max(...scores);
  return max > 0 ? scores.map((s) => s / max) : scores;
}

// 분야마다 따로 최댓값으로 나눈다. 분야 사이의 비중은 domainWeights가 정한다.
function normalizedByDomain(scores: number[]): number[] {
  return DOMAINS.flatMap(({ start, end }) => normalized(scores.slice(start, end)));
}

function rank(scores: number[], topK?: number): SearchResult[] {
  const sorted = DOCS.map((entry, i) => ({ entry, score: scores[i] }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return (topK === undefined ? sorted : sorted.slice(0, topK)).map(
    ({ entry, score }) => {
      const note = PLAIN.get(entry.id);
      return note ? { ...entry, score, plain: note } : { ...entry, score };
    },
  );
}

/**
 * 글자 검색만으로 순위를 매긴다. 외부 호출이 없어 즉시 끝난다.
 * 뜻 검색을 쓸 수 없을 때(키 없음, API 실패) 이걸로 답한다.
 *
 * 질문 벡터가 없어 분야를 판별할 수 없으므로 분야를 가리지 않고 전체에서
 * 최댓값을 찾아 나눈다.
 */
export function searchByLetters(query: string, topK?: number): SearchResult[] {
  return rank(lexicalWithSynonyms(query, false), topK);
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
/**
 * 앞 대화에 이어지는 질문까지 생각해 검색한다.
 *
 * "그럼 2아웃이면?"은 혼자서는 무엇을 묻는지 모른다. 앞 질문들을 이번 질문
 * 앞에 붙여 한 번에 검색한다.
 *
 * 이번 질문만으로 한 검색과 섞는 방식도 재봤는데(261007, 이어지는 질문 3개)
 * 전부 나빴다. 이번 질문만으로 하면 "2아웃"이 들어간 아무 조항이나 1등이라
 * 섞는 순간 정답이 밀린다. 붙인 것만 쓰면 그럼 2아웃이면? 2등, 되물음에 대한
 * 대답 6등, 앞 대화와 상관없는 새 질문(피치클락) 6등으로 셋 다 상위 8개 안이다.
 * (섞을 때: 높은 쪽 29/7/4등, 평균 21/2/5등, 0.3:0.7 16/5/5등)
 */
export async function searchInConversation(
  query: string,
  history: PreviousTurn[],
  topK?: number,
): Promise<SearchResult[]> {
  if (history.length === 0) return search(query, topK);
  return search(`${history.map((t) => t.question).join(" ")} ${query}`, topK);
}

export async function search(
  query: string,
  topK?: number,
): Promise<SearchResult[]> {
  const queryVector = await embedQuery(query);
  const unit = queryVector && toUnit(queryVector);
  if (!unit) return searchByLetters(query, topK);

  const meaning = normalizedByDomain(semanticScores(unit));
  const byLetters = normalizedByDomain(lexicalWithSynonyms(query, true));
  const weights = domainWeights(unit, lexicalWithSynonyms(query, false));
  const blended = byLetters.map(
    (s, i) =>
      (s * (1 - EMBEDDING_WEIGHT) + meaning[i] * EMBEDDING_WEIGHT) *
      weights[DOMAIN_OF[i]],
  );

  return rank(blended, topK);
}
