import { search } from "@/lib/search";
import { generateAnswer } from "@/lib/llm";

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
