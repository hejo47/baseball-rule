import rules from "@/data/rules.json";

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

// 제목 유사도와 본문 유사도를 따로 계산해 제목 쪽에 훨씬 큰 가중치로
// 합친다. topK를 생략하면 점수가 0보다 큰 조항을 전부 반환한다.
export function search(query: string, topK?: number): SearchResult[] {
  const { titleSpace, textSpace } = getIndex();
  const titleScores = cosineScores(titleSpace, query);
  const textScores = cosineScores(textSpace, query);

  const scored = DOCS.map((entry, i) => ({
    entry,
    score: titleScores[i] * TITLE_WEIGHT + textScores[i] * TEXT_WEIGHT,
  }));

  const sorted = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return (topK === undefined ? sorted : sorted.slice(0, topK)).map(
    ({ entry, score }) => ({ ...entry, score }),
  );
}
