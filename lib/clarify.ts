// AI가 답 대신 되물을 때 첫머리에 붙이는 말.
//
// 질문에 상황(아웃카운트, 주자 위치 등)이 빠져 조항에 따라 답이 갈리면 AI가
// 하나를 찍어 답하는 대신 되묻는다. 화면은 이 말로 시작하는 답을 보고 다음
// 입력을 그 되물음에 대한 대답으로 다룬다. (lib/llm.ts, app/page.tsx)
export const CLARIFY_PREFIX = "확인이 필요합니다";

// 모델이 앞에 따옴표나 굵게(**)를 붙이는 일이 있다.
const LEADING_MARKS = /^[\s*"“'#>]+/;

/** AI의 답이 되물음인지. */
export function isClarification(answer: string): boolean {
  return answer.replace(LEADING_MARKS, "").startsWith(CLARIFY_PREFIX);
}

/** 되물음에서 "확인이 필요합니다:"를 뗀 본문. 화면은 머리말을 따로 단다. */
export function clarificationBody(answer: string): string {
  return answer
    .replace(LEADING_MARKS, "")
    .slice(CLARIFY_PREFIX.length)
    .replace(/^[\s*:：.]+/, "");
}
