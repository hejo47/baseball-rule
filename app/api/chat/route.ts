import { search } from "@/lib/search";
import { generateAnswer } from "@/lib/llm";

// Vercel 무료 플랜의 기본 함수 실행 제한은 짧다. LLM 응답을 기다릴 수 있도록 늘린다.
export const maxDuration = 60;

// 검색 결과는 /api/search가 이미 즉시 돌려줬으므로, 여기서는 답변만 만든다.
// 검색은 메모리 계산이라 다시 돌려도 부담이 없어 클라이언트가 조항을
// 통째로 되돌려보내지 않아도 된다.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const message =
    typeof body?.message === "string" ? body.message.trim() : "";

  if (!message) {
    return Response.json(
      { error: "message 필드가 필요합니다." },
      { status: 400 },
    );
  }

  let answer: string | null = null;
  try {
    answer = await generateAnswer(message, search(message));
  } catch (err) {
    console.error("generateAnswer failed:", err);
  }

  return Response.json({ message, answer });
}
