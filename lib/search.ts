import rules from "@/data/rules.json";
import synonyms from "@/data/synonyms.json";

export interface RuleEntry {
  id: string;
  title: string;
  chapter: string;
  type: string;
  text: string;
  chars: number;
  english?: string;
}

export interface SearchResult extends RuleEntry {
  score: number;
}

const DOCS = rules as RuleEntry[];

interface Synonym {
  words: string[];
  expand: string[];
  note?: string;
}

const SYNONYMS = synonyms as Synonym[];

// 제목 쪽이 본문보다 훨씬 정확한 신호라 최종 점수에서 크게 반영한다.
// 본문은 제목에 없는 단어를 보충하는 정도의 역할만 한다.
const TITLE_WEIGHT = 0.85;
const TEXT_WEIGHT = 0.15;

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
  textSpace: VectorSpace;
}

let cached: Index | null = null;

function getIndex(): Index {
  if (!cached) {
    cached = {
      titleSpace: buildVectorSpace(
        DOCS.map((doc) => `${doc.title} ${doc.english ?? ""}`),
      ),
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

// 제목 유사도와 본문 유사도를 따로 계산해 제목 쪽에 훨씬 큰 가중치로 합친다.
function combinedScores(query: string): number[] {
  const { titleSpace, textSpace } = getIndex();
  const titleScores = cosineScores(titleSpace, query);
  const textScores = cosineScores(textSpace, query);
  return DOCS.map(
    (_, i) => titleScores[i] * TITLE_WEIGHT + textScores[i] * TEXT_WEIGHT,
  );
}

// topK를 생략하면 점수가 0보다 큰 조항을 전부 반환한다.
export function search(query: string, topK?: number): SearchResult[] {
  const scores = combinedScores(query);

  // 확장한 질문은 따로 채점해 더 높은 쪽을 쓴다. 원래 질문 뒤에 붙이면
  // 확장어(흔한 말이 섞이기 쉽다)가 원래 질문의 비중을 깎아, 이미 잘 찾던
  // 질문까지 밀려났다. ("주루방해" 6등 -> 16등)
  const expanded = expandQuery(query);
  if (expanded) {
    const expandedScores = combinedScores(expanded);
    for (let i = 0; i < scores.length; i++) {
      scores[i] = Math.max(scores[i], expandedScores[i]);
    }
  }

  const scored = DOCS.map((entry, i) => ({ entry, score: scores[i] }));

  const sorted = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return (topK === undefined ? sorted : sorted.slice(0, topK)).map(
    ({ entry, score }) => ({ ...entry, score }),
  );
}
