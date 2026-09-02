import { search } from "@/lib/search";

// 검색은 전부 메모리 안에서 계산하므로 즉시 응답한다.
// 느린 LLM 답변(/api/chat)과 분리해서 화면이 먼저 뜨게 한다.
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

  return Response.json({ message, results: search(message) });
}
