import OpenAI from "openai";
import type { SearchResult } from "@/lib/search";

// NVIDIA build.nvidia.com은 OpenAI 호환 엔드포인트를 무료로 제공한다.
// https://build.nvidia.com/models 에서 API 키를 받아 NVIDIA_API_KEY로 설정하면 된다.
const MODEL = process.env.NVIDIA_MODEL ?? "openai/gpt-oss-20b";
// 조항 하나가 2,500자까지 되므로 너무 많이 넘기면 응답이 크게 느려진다.
const CONTEXT_LIMIT = 8;
// 추론 + 답변을 합친 상한. reasoning_effort를 낮추면 실제로는 200~300토큰이면
// 끝나므로, 이 값은 모델이 폭주할 때만 걸리는 안전장치다.
const MAX_TOKENS = 900;

function getClient(): OpenAI | null {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: "https://integrate.api.nvidia.com/v1",
    // 무료 API가 종종 응답을 아예 주지 않는다. 그때 서버가 같이 멈추지
    // 않도록 끊고, 검색 결과만이라도 돌려준다.
    // 스트리밍이라 첫 글자는 보통 1~4초 안에 오고, 끝까지도 10초를 넘지 않는다.
    timeout: 30_000,
    maxRetries: 0,
  });
}

function buildPrompt(question: string, results: SearchResult[]): string {
  const context = results
    .slice(0, CONTEXT_LIMIT)
    .map((r) => `[${r.id}] ${r.title} (${r.source})\n${r.text}`)
    .join("\n\n---\n\n");

  return `아래는 KBO 공식 야구규칙과 KBO 리그 규정에서 검색으로 찾은 조항들이다.
이 조항들만 근거로 질문에 답하라.
조항에 없는 내용은 추측하지 말고 "규칙집에서 찾지 못했습니다"라고 답하라.
근거가 어느 문서에서 왔는지 답변에 밝혀라. 야구규칙과 리그 규정은 다른 문서다.
3~5문장으로 짧게 답하라. 표는 쓰지 말고 줄글로 쓴다.
답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).

# 검색된 조항
${context}

# 질문
${question}`;
}

export function isLlmConfigured(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY);
}

/**
 * 모델이 사람이 읽을 수 있는 이유를 담아 실패했을 때 쓰는 에러.
 * 키가 없거나 모델이 종료(410)된 경우처럼, 화면에 그대로 보여줘야
 * 무엇을 고쳐야 할지 알 수 있는 실패들이다.
 */
export class AnswerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AnswerError";
  }
}

/**
 * 모델 호출 실패를 화면에 보여줄 수 있는 문장으로 바꾼다.
 * 무엇을 고쳐야 하는지(키, 모델 이름, 사용량)까지 적는다.
 */
function toAnswerError(err: unknown): AnswerError {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 410) {
      return new AnswerError(
        `모델 ${MODEL}은(는) 서비스가 종료됐습니다. NVIDIA_MODEL 설정을 확인하세요.`,
        502,
      );
    }
    if (err.status === 404) {
      return new AnswerError(`모델 ${MODEL}을(를) 찾을 수 없습니다.`, 502);
    }
    if (err.status === 401 || err.status === 403) {
      return new AnswerError("NVIDIA API 키가 거부됐습니다.", 502);
    }
    if (err.status === 429) {
      return new AnswerError(
        "무료 API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도해주세요.",
        429,
      );
    }
    return new AnswerError(`모델 호출 실패 (${err.status ?? "응답 없음"}).`, 502);
  }
  return new AnswerError("모델 호출에 실패했습니다.", 502);
}

/**
 * 답변 스트림을 연다.
 *
 * 첫 조각을 흘려보내기 전에 실패를 확인할 수 있도록 호출만 따로 뗐다.
 * 이 단계에서 실패하면 라우트가 아직 에러 응답을 줄 수 있다.
 * (스트림이 시작된 뒤에는 상태 코드를 바꿀 수 없어, 예전에는 이런 실패가
 * 빈 응답으로 나가 화면에는 이유 없는 "실패"만 떴다.)
 *
 * 검색된 조항이 없으면 답변할 근거가 없으므로 null을 준다. 이건 에러가 아니다.
 */
export async function openAnswerStream(question: string, results: SearchResult[]) {
  const client = getClient();
  if (!client) {
    throw new AnswerError("서버에 NVIDIA_API_KEY가 설정되지 않았습니다.", 503);
  }
  if (results.length === 0) return null;

  try {
    return await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: buildPrompt(question, results) }],
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      // 작은 모델이 같은 문장을 무한 반복하는 것을 막는다.
      frequency_penalty: 0.5,
      // 이 프로젝트는 규칙 조항을 그대로 인용해 요약하는 일이라
      // 긴 추론이 필요 없다. 속도에 가장 크게 영향을 주는 설정이다.
      reasoning_effort: "low",
      stream: true,
    });
  } catch (err) {
    throw toAnswerError(err);
  }
}

/**
 * 열어둔 스트림에서 답변을 조각조각 흘려보낸다.
 *
 * 답변 지연의 대부분은 모델이 답을 쓰기 전에 하는 "추론"이었다.
 * (reasoning_effort 기본값에서는 첫 글자까지 25~45초, 전체 45~140초)
 * reasoning_effort를 low로 낮추고 답변 길이를 제한해 전체 7초 안팎으로,
 * 스트리밍으로 첫 글자는 1~4초 만에 화면에 뜨게 한다.
 */
export async function* readAnswerStream(
  stream: Awaited<ReturnType<typeof openAnswerStream>>,
): AsyncGenerator<string> {
  if (!stream) return;

  let sawContent = false;
  let reasoning = "";

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;

    const piece = delta?.content;
    if (piece) {
      sawContent = true;
      yield piece;
      continue;
    }
    if (!sawContent && delta?.reasoning_content) {
      reasoning += delta.reasoning_content;
    }
  }

  // content가 끝까지 비면 추론 과정이라도 보여준다.
  if (!sawContent && reasoning.trim()) yield reasoning.trim();
}
