import { search } from "@/lib/search";
import { streamAnswer } from "@/lib/llm";

// Vercel 무료 플랜의 기본 함수 실행 제한은 짧다. LLM 응답을 기다릴 수 있도록 늘린다.
export const maxDuration = 60;

// 검색 결과는 /api/search가 이미 즉시 돌려줬으므로, 여기서는 답변만 만든다.
// 검색은 메모리 계산이라 다시 돌려도 부담이 없어 클라이언트가 조항을
// 통째로 되돌려보내지 않아도 된다.
//
// 답변은 완성될 때까지 기다리지 않고 생성되는 대로 흘려보낸다.
// 화면에는 첫 글자가 뜨는 순간부터 글이 차오른다.
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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const piece of streamAnswer(message, search(message))) {
          controller.enqueue(encoder.encode(piece));
        }
      } catch (err) {
        // 이미 내보낸 부분까지는 화면에 남는다. 나머지는 포기하고 닫는다.
        console.error("streamAnswer failed:", err);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // 프록시가 조각을 모아뒀다가 한 번에 보내지 않도록 한다.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
