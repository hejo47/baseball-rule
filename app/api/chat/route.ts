import { search } from "@/lib/search";
import { generateAnswer } from "@/lib/llm";

// Vercel 무료 플랜의 기본 함수 실행 제한은 짧다. LLM 응답을 기다릴 수 있도록 늘린다.
export const maxDuration = 60;

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

  const results = search(message);

  let answer: string | null = null;
  try {
    answer = await generateAnswer(message, results);
  } catch (err) {
    console.error("generateAnswer failed:", err);
  }

  return Response.json({ message, answer, results });
}
