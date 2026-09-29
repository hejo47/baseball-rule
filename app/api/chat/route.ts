import { search } from "@/lib/search";
import { ANSWER_DONE } from "@/lib/answer-done";
import {
  AnswerError,
  FIRST_TEXT_MS,
  STALL_MS,
  openAnswerStream,
  readAnswerStream,
} from "@/lib/llm";

// 글이 나오는 동안에는 끊지 않으므로, 함수 제한은 무료 플랜의 최대값으로 둔다.
// (Vercel Hobby는 기본값도 최대값도 300초다. 예전에 둔 60은 오히려 줄이고 있어서,
// 답이 느린 날은 60초에서 글이 잘렸다.)
export const maxDuration = 300;

/**
 * 시간이 되면 모델 호출을 끊는 타이머.
 * 새 글이 올 때마다 다시 감아서, 글이 멈춘 시간만 잰다.
 */
function watchdog(ms: number) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    reset(next: number) {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), next);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

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

  const results = await search(message);

  // 첫 글자는 다시 부르는 것까지 합쳐 이 시각까지 와야 한다.
  const firstTextBy = Date.now() + FIRST_TEXT_MS;

  // 스트림을 먼저 연다. 여기서 실패하면(키 없음, 모델 종료 등) 아직
  // 상태 코드를 붙일 수 있어서, 화면이 이유를 그대로 보여줄 수 있다.
  const dog = watchdog(FIRST_TEXT_MS);
  let answer;
  try {
    answer = await openAnswerStream(message, results, dog.signal);
  } catch (err) {
    dog.stop();
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
      /**
       * 흘려보낸 글자 수와, 끝까지 못 쓰고 끊겼는지를 돌려준다.
       * 글자 수가 0이면 모델이 아무것도 안 낸 것이다.
       */
      const pump = async (
        from: typeof answer,
        timer: ReturnType<typeof watchdog>,
      ) => {
        let sent = 0;
        let cut = false;
        try {
          for await (const piece of readAnswerStream(from)) {
            sent += piece.length;
            controller.enqueue(encoder.encode(piece));
            timer.reset(STALL_MS);
          }
        } catch (err) {
          // 이미 내보낸 부분까지는 화면에 남는다. 나머지는 포기하고 닫는다.
          console.error("readAnswerStream failed:", err);
          cut = true;
        } finally {
          timer.stop();
        }
        // 타이머가 끊으면 스트림은 에러 없이 그 자리에서 끝난다.
        if (timer.signal.aborted) {
          cut = true;
          console.error(
            sent
              ? `새 글이 ${STALL_MS / 1000}초 동안 오지 않아 끊었습니다 (${sent}자에서).`
              : `첫 글자가 ${FIRST_TEXT_MS / 1000}초 안에 오지 않았습니다.`,
          );
        }
        return { sent, cut };
      };

      let { sent, cut } = await pump(answer, dog);

      // 모델이 속으로 생각만 하다 끝나는 일이 이따금 있다. 같은 조건으로
      // 한 번 더 부르면 대개 답이 나온다. 스트림이 시작되기 전이라
      // 화면에는 답이 늦게 뜬 것으로만 보인다.
      // 첫 글자 시한이 이미 지났으면 사용자를 더 붙잡지 않는다.
      if (answer && sent === 0 && Date.now() < firstTextBy) {
        console.error("빈 답변 — 한 번 더 시도합니다.");
        const retryDog = watchdog(firstTextBy - Date.now());
        const retry = await openAnswerStream(
          message,
          results,
          retryDog.signal,
        ).catch(() => null);
        if (retry) ({ sent, cut } = await pump(retry, retryDog));
        else retryDog.stop();
      }

      // 비었으면 아무것도 보내지 않고 닫는다. 화면은 검색된 조항을
      // 펼쳐 보여준다. 끝까지 썼을 때만 완료 표시를 붙인다.
      if (sent === 0) console.error("빈 답변으로 끝났습니다.");
      else if (!cut) controller.enqueue(encoder.encode(ANSWER_DONE));

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
