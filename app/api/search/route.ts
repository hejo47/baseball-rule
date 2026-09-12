import { RESULT_LIMIT, search } from "@/lib/search";

// 글자 검색은 메모리 계산이라 즉시 끝나고, 뜻 검색을 위해 질문을 벡터로
// 바꾸는 데만 300ms 안팎이 든다. 느린 LLM 답변(/api/chat)과 분리해서
// 화면이 먼저 뜨게 한다.
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

  return Response.json({
    message,
    results: await search(message, RESULT_LIMIT),
  });
}
