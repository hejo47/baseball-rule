/**
 * 질문을 뜻 벡터로 바꾼다.
 *
 * 규칙집 조각들은 scripts/build-vectors.mjs가 미리 벡터로 만들어
 * data/vectors.json에 넣어뒀다. 질문만 그때그때 API로 바꾼다.
 *
 * 이게 필요한 이유는 글자만 보는 검색이 "낫아웃"과 "제3스트라이크"처럼
 * 뜻은 같은데 글자가 안 겹치는 말을 영원히 못 찾기 때문이다.
 * 자세한 배경은 docs/search.md 참고.
 */
import vectorFile from "@/data/vectors.json";

const MODEL = process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b";
// 사용자가 답변을 기다리는 중이라 오래 붙들고 있을 수 없다.
// 보통 300ms 안에 오므로, 넘어가면 글자 검색만으로 답하는 편이 낫다.
const TIMEOUT_MS = 4_000;

/** data/vectors.json이 지금 규칙집으로 만들어진 게 맞는지 확인할 때 쓴다. */
export const VECTOR_FILE_MODEL = vectorFile.model;

/**
 * 실패하면 null을 준다. 에러를 던지지 않는 게 중요하다.
 * 무료 API는 502를 심심찮게 내는데, 그때 검색 전체가 죽는 대신
 * 글자 검색만으로라도 답이 나가야 한다.
 */
export async function embedQuery(query: string): Promise<number[] | null> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input: [query],
        // 이 모델은 질문과 문서를 다르게 취급한다.
        // 문서 쪽은 build-vectors.mjs가 "passage"로 넣었다.
        input_type: "query",
        encoding_format: "float",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`임베딩 실패 ${res.status} — 글자 검색만으로 답합니다.`);
      return null;
    }
    const json = await res.json();
    const vector = json?.data?.[0]?.embedding;
    return Array.isArray(vector) ? vector : null;
  } catch (err) {
    console.error("임베딩 호출 실패 — 글자 검색만으로 답합니다.", err);
    return null;
  }
}
