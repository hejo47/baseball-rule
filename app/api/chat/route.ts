import { search } from "@/lib/search";
import { AnswerError, openAnswerStream, readAnswerStream } from "@/lib/llm";

// Vercel 무료 플랜의 기본 함수 실행 제한은 짧다. LLM 응답을 기다릴 수 있도록 늘린다.
export const maxDuration = 60;

// 검색 결과는 /api/search가 이미 돌려줬으므로, 여기서는 답변만 만든다.
// 검색을 다시 돌리는 값은 질문 임베딩 한 번(300ms 안팎)이라, 클라이언트가
// 조항을 통째로 되돌려보내는 것보다 싸고 단순하다.
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

  // 스트림을 먼저 연다. 여기서 실패하면(키 없음, 모델 종료 등) 아직
  // 상태 코드를 붙일 수 있어서, 화면이 이유를 그대로 보여줄 수 있다.
  const results = await search(message);

  let answer;
  try {
    answer = await openAnswerStream(message, results);
  } catch (err) {
    console.error("openAnswerStream failed:", err);
    const known = err instanceof AnswerError;
    return Response.json(
      { error: known ? err.message : "답변을 만들지 못했습니다." },
      { status: known ? err.status : 502 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      /** 흘려보낸 글자 수를 돌려준다. 0이면 모델이 아무것도 안 낸 것이다. */
      const pump = async (from: typeof answer) => {
        let sent = 0;
        try {
          for await (const piece of readAnswerStream(from)) {
            sent += piece.length;
            controller.enqueue(encoder.encode(piece));
          }
        } catch (err) {
          // 이미 내보낸 부분까지는 화면에 남는다. 나머지는 포기하고 닫는다.
          console.error("readAnswerStream failed:", err);
        }
        return sent;
      };

      let sent = await pump(answer);

      // 모델이 속으로 생각만 하다 끝나는 일이 이따금 있다. 같은 조건으로
      // 한 번 더 부르면 대개 답이 나온다. 스트림이 시작되기 전이라
      // 화면에는 답이 늦게 뜬 것으로만 보인다.
      if (sent === 0) {
        console.error("빈 답변 — 한 번 더 시도합니다.");
        const retry = await openAnswerStream(message, results).catch(() => null);
        if (retry) sent = await pump(retry);
      }

      // 두 번 다 비면 아무것도 보내지 않고 닫는다. 화면은 검색된 조항을
      // 펼쳐 보여준다.
      if (sent === 0) console.error("두 번 다 빈 답변이었습니다.");

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
