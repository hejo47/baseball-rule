import OpenAI from "openai";
import type { SearchResult } from "@/lib/search";

// NVIDIA build.nvidia.com은 OpenAI 호환 엔드포인트를 무료로 제공한다.
// https://build.nvidia.com/models 에서 API 키를 받아 NVIDIA_API_KEY로 설정하면 된다.
const MODEL = process.env.NVIDIA_MODEL ?? "openai/gpt-oss-120b";
// 조항 하나가 2,500자까지 되므로 너무 많이 넘기면 응답이 크게 느려진다.
const CONTEXT_LIMIT = 8;

function getClient(): OpenAI | null {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: "https://integrate.api.nvidia.com/v1",
    // 무료 API가 종종 응답을 아예 주지 않는다. 그때 서버가 같이 멈추지
    // 않도록 끊고, 검색 결과만이라도 돌려준다.
    timeout: 25_000,
    maxRetries: 1,
  });
}

function buildPrompt(question: string, results: SearchResult[]): string {
  const context = results
    .slice(0, CONTEXT_LIMIT)
    .map((r) => `[${r.id}] ${r.title}\n${r.text}`)
    .join("\n\n---\n\n");

  return `아래는 KBO 공식 야구규칙에서 검색으로 찾은 조항들이다. 이 조항들만 근거로 질문에 답하라.
조항에 없는 내용은 추측하지 말고 "규칙집에서 찾지 못했습니다"라고 답하라.
답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).

# 검색된 조항
${context}

# 질문
${question}`;
}

export async function generateAnswer(
  question: string,
  results: SearchResult[],
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;
  if (results.length === 0) return null;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: buildPrompt(question, results) }],
    temperature: 0.2,
    // 추론(reasoning) 모델은 생각하는 데 토큰을 먼저 쓰기 때문에
    // 넉넉히 잡지 않으면 정작 답변 본문이 비어서 돌아온다.
    max_tokens: 4096,
    // 작은 모델이 같은 문장을 무한 반복하는 것을 막는다.
    frequency_penalty: 0.5,
  });

  const message = completion.choices[0]?.message as
    | { content?: string | null; reasoning_content?: string | null }
    | undefined;

  // content가 비면 추론 과정이라도 보여준다.
  return message?.content?.trim() || message?.reasoning_content?.trim() || null;
}
