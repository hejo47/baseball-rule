"use client";

import { useState } from "react";
import type { SearchResult } from "@/lib/search";

// 목록에서 조항을 이만큼만 보여주고, 나머지는 "전체 보기"로 펼친다.
const PREVIEW_CHARS = 300;

export default function Home() {
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [answerLoading, setAnswerLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 길게 잘린 조항 중 사용자가 펼쳐본 것들의 id
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = message.trim();
    if (!question) return;

    setLoading(true);
    setError(null);
    setResults(null);
    setAnswer(null);
    setExpanded(new Set());

    // 검색과 AI 답변을 동시에 요청한다. 답변 쪽이 훨씬 오래 걸리므로
    // 검색이 끝난 뒤에 시작하면 그만큼 손해다.
    const searchPromise = fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question }),
    });
    const answerPromise = fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question }),
    });
    // 검색이 실패해 아래에서 빠져나가도 예외가 떠돌지 않게 한다.
    answerPromise.catch(() => null);

    // 1단계: 검색 결과를 먼저 받아 즉시 보여준다.
    try {
      const res = await searchPromise;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "검색 실패");
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
      setLoading(false);
      return;
    }
    setLoading(false);

    // 2단계: AI 답변은 다 쓰일 때까지 기다리지 않고, 오는 대로 이어 붙인다.
    setAnswerLoading(true);
    try {
      const res = await answerPromise;
      if (!res.ok || !res.body) throw new Error("답변 생성 실패");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setAnswer(text);
      }
      text += decoder.decode();
      setAnswer(text.trim() || null);
    } catch {
      setAnswer(null);
    } finally {
      setAnswerLoading(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            KBO 규칙 검색 테스트
          </h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            규칙집 조항을 코사인 유사도 순으로 점수가 0보다 큰 것 전부 보여줍니다.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="예: 인필드 플라이 조건은?"
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-black px-5 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {loading ? "검색 중…" : "검색"}
          </button>
        </form>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {answerLoading && !answer && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white p-4 text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
            AI가 조항을 읽고 답변을 정리하는 중…
          </div>
        )}

        {results && !answer && !answerLoading && (
          <p className="text-xs text-zinc-500">
            (AI 답변 생성에 실패해 검색된 조항만 보여줍니다. 잠시 후 다시
            시도해보세요.)
          </p>
        )}

        {answer && (
          <div className="rounded-lg border border-zinc-300 bg-white p-4 whitespace-pre-line text-sm text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50">
            {answer}
          </div>
        )}

        {results && (
          <details className="text-sm" open>
            <summary className="cursor-pointer text-zinc-500">
              검색된 조항 {results.length}개
            </summary>
            <ul className="mt-3 flex flex-col gap-3">
            {results.length === 0 && (
              <li className="text-sm text-zinc-500">
                일치하는 조항을 찾지 못했습니다.
              </li>
            )}
            {results.map((r) => {
              const isLong = r.text.length > PREVIEW_CHARS;
              const isOpen = expanded.has(r.id);
              return (
                <li
                  key={r.id}
                  className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-black dark:text-zinc-50">
                      {r.id} {r.title}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-500">
                      score {r.score.toFixed(3)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {r.chapter} · {r.type}
                  </p>
                  <p className="mt-2 whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
                    {isLong && !isOpen
                      ? r.text.slice(0, PREVIEW_CHARS) + "…"
                      : r.text}
                  </p>
                  {isLong && (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(r.id)}
                      className="mt-2 text-xs text-zinc-500 underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
                    >
                      {isOpen
                        ? "접기"
                        : `전체 보기 (${r.text.length.toLocaleString()}자)`}
                    </button>
                  )}
                </li>
              );
            })}
            </ul>
          </details>
        )}
      </main>
    </div>
  );
}
