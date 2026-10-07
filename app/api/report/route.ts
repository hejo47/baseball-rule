import { ANSWER_MODEL } from "@/lib/llm";

// 틀린 답 신고를 받아 디스코드나 슬랙 채널로 보낸다.
//
// 서버 로그에만 남기면 Vercel 무료 플랜은 1시간 뒤 지운다. 대화는 탭을 닫으면
// 사라지므로, 틀린 답을 나중에 다시 볼 방법이 이것뿐이다. 웹훅 주소는
// REPORT_WEBHOOK_URL 환경변수로 받는다. 없으면 로그에만 남긴다.

// 누구나 이 주소로 보낼 수 있어서 채널이 도배되지 않게 길이를 자른다.
const MAX_QUESTION = 1_000;
const MAX_ANSWER = 4_000;
// 디스코드 메시지는 2,000자까지다. 넘으면 웹훅이 400을 준다.
const DISCORD_LIMIT = 2_000;

interface Report {
  question: string;
  answer: string;
  /** AI에게 넘긴 조항 번호. 틀린 게 검색 탓인지 모델 탓인지 가를 때 쓴다. */
  contextIds: string[];
}

function parse(body: unknown): Report | null {
  if (!body || typeof body !== "object") return null;
  const { question, answer, contextIds } = body as Record<string, unknown>;
  if (typeof question !== "string" || !question.trim()) return null;
  if (typeof answer !== "string" || !answer.trim()) return null;
  return {
    question: question.trim().slice(0, MAX_QUESTION),
    answer: answer.trim().slice(0, MAX_ANSWER),
    contextIds: Array.isArray(contextIds)
      ? contextIds.filter((id): id is string => typeof id === "string").slice(0, 8)
      : [],
  };
}

function format(report: Report): string {
  const head = [
    // 굵게(**)는 디스코드 문법이라 슬랙에서는 별표가 그대로 보인다.
    "[틀린 답 신고]",
    `질문: ${report.question}`,
    `넘긴 조항: ${report.contextIds.join(" ") || "(없음)"}`,
    `모델: ${ANSWER_MODEL}`,
    "답:",
  ].join("\n");
  return `${head}\n${report.answer}`;
}

async function deliver(url: string, text: string): Promise<boolean> {
  const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(url);
  const body = isDiscord
    ? {
        content:
          text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text,
        // 신고 내용에 @everyone이 들어 있어도 실제로 알림이 가지 않게 한다.
        allowed_mentions: { parse: [] },
      }
    : // 슬랙은 <!channel> 같은 멘션을 꺾쇠로 쓴다. 꺾쇠를 풀어 써서 막는다.
      {
        text: text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;"),
      };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`신고 웹훅 실패 ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("신고 웹훅 호출 실패:", err);
    return false;
  }
}

/**
 * 다른 사이트에서 이 주소로 신고를 쏘지 못하게 한다. 브라우저는 Origin을
 * 속일 수 없다. (스크립트로 직접 보내는 건 못 막지만 길이 제한이 있다.)
 */
function fromThisSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    // 샌드박스 iframe 등은 "null"을 보낸다.
    return false;
  }
}

export async function POST(request: Request) {
  if (!fromThisSite(request)) {
    return Response.json({ error: "다른 사이트에서 온 요청입니다." }, { status: 403 });
  }

  const report = parse(await request.json().catch(() => null));
  if (!report) {
    return Response.json(
      { error: "question과 answer가 필요합니다." },
      { status: 400 },
    );
  }

  // 웹훅이 실패해도 1시간은 로그에서 볼 수 있다.
  console.log("틀린 답 신고:", JSON.stringify({ ...report, model: ANSWER_MODEL }));

  const url = process.env.REPORT_WEBHOOK_URL;
  if (!url) return Response.json({ delivered: false });

  const delivered = await deliver(url, format(report));
  if (!delivered) {
    return Response.json(
      { error: "신고를 보내지 못했습니다." },
      { status: 502 },
    );
  }
  return Response.json({ delivered: true });
}
