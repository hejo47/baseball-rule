/**
 * 앞 대화를 이어받는 데 쓰는 것들. 화면과 서버가 같이 쓴다.
 *
 * 처음에는 질문마다 따로 처리해서, "그럼 2아웃이면?"처럼 앞 대화에 이어지는
 * 질문을 하면 AI는 무엇을 묻는지 몰랐다. 되물음("확인이 필요합니다")에 사용자가
 * 답해도 원래 질문을 몰라 답할 수 없었다(261007).
 */

/** 앞에서 주고받은 질문 하나와 그 답. */
export interface PreviousTurn {
  question: string;
  answer: string;
}

// 바로 앞 두 번만 넘긴다. 더 길면 프롬프트가 불어나고, 오래된 대화는 이번
// 질문과 상관없을 때가 많다.
export const HISTORY_LIMIT = 2;
// 답 하나가 길면 앞부분만 넘긴다. 결론은 보통 앞에 있다.
const MAX_QUESTION = 1_000;
const MAX_ANSWER = 1_500;

/** 요청 본문의 history를 검증하고 길이를 자른다. 이상하면 빈 배열. */
export function parseHistory(value: unknown): PreviousTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is PreviousTurn =>
        typeof t?.question === "string" &&
        typeof t?.answer === "string" &&
        t.question.trim() !== "" &&
        t.answer.trim() !== "",
    )
    .slice(-HISTORY_LIMIT)
    .map((t) => ({
      question: t.question.trim().slice(0, MAX_QUESTION),
      answer: t.answer.trim().slice(0, MAX_ANSWER),
    }));
}
