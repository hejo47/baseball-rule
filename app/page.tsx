"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SearchResult } from "@/lib/search";
import { ANSWER_DONE } from "@/lib/answer-done";
import { clarificationBody, isClarification } from "@/lib/clarify";
import { HISTORY_LIMIT, type PreviousTurn } from "@/lib/conversation";
import {
  getServerTurns,
  getTurns,
  subscribe,
  updateTurns,
  type Turn,
} from "./chat-history";

// 목록에서 조항을 이만큼만 보여주고, 나머지는 "전체 보기"로 펼친다.
const PREVIEW_CHARS = 300;

// 모델이 "정의-40"을 "정의‑40"(유니코드 하이픈)으로 적는 일이 잦다.
const DASHES = /[‐-―−﹘﹣－]/g;
// 답변 끝에 붙는 대괄호 표기. [주1]이나 [규칙집에서 찾지 못했습니다]처럼
// 조항 번호가 아닌 것도 들어오므로 안쪽을 한 번 더 걸러낸다.
//
// 괄호도 받는다. nemotron-3-super는 대괄호로 달라고 해도 네 번에 한 번꼴로
// "(정의-40, 주1)"처럼 괄호로 적는다(측정 260929). 괄호 속 설명 문장은
// 조항 번호가 없어 아래 RULE_ID에서 걸러진다.
const BRACKET = /\[([^\]\n]{1,80})\]|\(([^)\n]{1,80})\)/g;
const RULE_ID = /(리그-[가-힣A-Za-z0-9()\-①-⑳]+|정의-\d{1,3}|\d{1,2}\.\d{2}[⒜-⒵⑴-⒇]*)/;

const flatId = (s: string) => s.replace(DASHES, "-").replace(/\s+/g, "");

/**
 * 답변이 인용한 번호에 맞는 조항을 찾는다.
 *
 * 모델은 우리가 쪼갠 단위보다 깊게(5.06⒞⑴) 적기도 하고 얕게(5.06) 적기도
 * 한다. 정확히 같은 것이 없으면 한쪽이 다른 쪽으로 시작하는 것 중 가장
 * 구체적인 조항을 고른다.
 */
function findRule(cited: string, results: SearchResult[]): SearchResult | null {
  const id = flatId(cited);
  let best: SearchResult | null = null;
  for (const r of results) {
    const rid = flatId(r.id);
    if (rid === id) return r;
    if (id.startsWith(rid) || rid.startsWith(id)) {
      if (!best || r.id.length > best.id.length) best = r;
    }
  }
  return best;
}

/** 답변 글을 조각으로 나눈다. 인용 번호는 눌러볼 수 있는 조각이 된다. */
function splitAnswer(text: string, results: SearchResult[]) {
  const parts: ({ text: string } | { cited: string; rule: SearchResult })[] = [];
  let at = 0;
  for (const m of text.matchAll(BRACKET)) {
    const inner = (m[1] ?? m[2]).replace(DASHES, "-");
    const found = inner.match(RULE_ID);
    const rule = found ? findRule(found[1], results) : null;
    if (!rule) continue;
    if (m.index! > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ cited: m[0], rule });
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

export default function Home() {
  const [message, setMessage] = useState("");
  // 이 브라우저에 남아 있는 대화. 서버에서 그릴 때와 하이드레이션 직후에는
  // null(아직 안 읽음)이고, 곧바로 저장된 내역으로 바뀐다.
  const stored = useSyncExternalStore(subscribe, getTurns, getServerTurns);
  const loaded = stored !== null;
  const turns = stored ?? [];
  // 조항 목록은 한 번에 한 질문 것만 펼친다. 한 질문에 30개씩 나와서
  // 다 펼쳐두면 지난 질문을 찾아보기가 어렵다.
  const [openRules, setOpenRules] = useState<number | null>(null);
  // 길게 잘린 조항 중 펼쳐본 것들. 같은 조항이 여러 질문에 나올 수 있어
  // 질문 id까지 붙여서 구분한다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 답변 속 인용 번호를 눌러 고정해둔 것들. 마우스를 올리면 잠깐 보이고,
  // 누르면 치울 때까지 남는다. 손가락으로 쓰는 화면에는 올리기가 없어서
  // 누르기가 본 동작이다.
  const [pinnedCites, setPinnedCites] = useState<Set<string>>(new Set());
  const [hoverCite, setHoverCite] = useState<string | null>(null);

  // 재검색으로 중간의 질문이 다시 진행 중이 될 수 있어 전부 본다.
  const busy = turns.some((t) => t.searching || t.answering);

  // 마지막 답이 되물음이면 다음 입력은 그 대답으로 이어진다.
  const last = turns.at(-1);
  const awaitingReply = Boolean(
    last?.answer && !last.answering && isClarification(last.answer),
  );

  // 대화 영역만 스크롤되고, 제목과 입력창은 제자리에 있다.
  // 새 글이 붙으면 따라 내려가되, 지난 질문을 읽으려고 위로 올려둔
  // 상태라면 끌어내리지 않는다.
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [stored]);
  // AI가 되물으면 바로 답할 수 있게 입력창으로 커서를 옮긴다.
  useEffect(() => {
    if (awaitingReply) inputRef.current?.focus();
  }, [awaitingReply]);

  function patch(id: number, next: Partial<Turn>) {
    updateTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...next } : t)));
  }

  /** 대화를 비우고 처음 화면으로 돌아간다. */
  function startNewChat() {
    updateTurns(() => []);
    setOpenRules(null);
    setExpanded(new Set());
    setPinnedCites(new Set());
    setHoverCite(null);
    setMessage("");
    stick.current = true;
    inputRef.current?.focus();
  }

  /**
   * 열어둔 원문을 닫는다.
   *
   * 마우스를 올려 연 것도 여기서만 닫는다. 커서가 벗어났다고 닫으면,
   * 아래로 읽어 내려가는 순간 사라진다. 조항 하나가 4,000자까지 되므로
   * 마우스를 올려둔 채로 읽는 건 불가능하다.
   */
  function closeCite(key: string) {
    setPinnedCites((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    setHoverCite((h) => (h === key ? null : h));
  }

  function toggleCite(key: string) {
    if (pinnedCites.has(key) || hoverCite === key) {
      closeCite(key);
      return;
    }
    setPinnedCites((prev) => new Set(prev).add(key));
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const question = message.trim();
    if (!question || busy) return;

    // 앞에서 답을 받은 질문들을 같이 보낸다. "그럼 2아웃이면?"처럼 이어지는
    // 질문이나, AI가 되물은 것에 대한 대답을 이해하려면 앞 대화가 필요하다.
    const history: PreviousTurn[] = turns
      .filter((t) => t.answer)
      .slice(-HISTORY_LIMIT)
      .map((t) => ({ question: t.question, answer: t.answer! }));

    const id = Date.now();
    updateTurns((ts) => [
      ...ts,
      {
        id,
        question,
        history,
        results: null,
        answer: null,
        searchError: null,
        answerError: null,
        searching: true,
        answering: false,
      },
    ]);
    // 조항 목록은 접어둔다. 답변 속 인용 번호를 눌러 근거를 보는 게 본 동작이고,
    // 이 목록은 검색이 무엇을 물어왔는지 확인할 때만 쓴다.
    setOpenRules(null);
    setMessage("");
    stick.current = true;
    void ask(id, question, history);
  }

  /**
   * 실패했거나 중간에 끊긴 질문을 그 자리에서 다시 묻는다.
   *
   * 새 질문으로 아래에 붙이지 않고 원래 자리를 고쳐 쓴다. 실패한 질문과
   * 다시 물은 질문이 둘 다 남으면 어느 게 최신인지 헷갈린다.
   */
  function retry(turn: Turn) {
    if (busy) return;
    patch(turn.id, {
      results: null,
      answer: null,
      searchError: null,
      answerError: null,
      searching: true,
      answering: false,
      reported: undefined,
    });
    // 이 질문에서 열어둔 원문과 목록은 새 결과와 안 맞으니 닫는다.
    const mine = `${turn.id}:`;
    setOpenRules((o) => (o === turn.id ? null : o));
    setPinnedCites((prev) => new Set([...prev].filter((k) => !k.startsWith(mine))));
    setHoverCite((h) => (h?.startsWith(mine) ? null : h));
    // 처음 물었을 때와 같은 앞 대화로 다시 묻는다.
    void ask(turn.id, turn.question, turn.history ?? []);
  }

  /**
   * 틀린 답을 신고한다. 질문과 답, AI에게 넘긴 조항 번호를 보낸다.
   *
   * 대화는 탭을 닫으면 사라져서, 틀린 답을 나중에 다시 볼 방법이 이것뿐이다.
   * 조항 번호가 있어야 틀린 게 검색 탓(정답 조항이 안 넘어감)인지 모델
   * 탓(넘겨받고도 못 씀)인지 가를 수 있다.
   */
  async function report(turn: Turn) {
    if (!turn.answer || turn.reported === "sending" || turn.reported === "done") return;
    patch(turn.id, { reported: "sending" });
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: turn.question,
          answer: turn.answer,
          // /api/chat이 AI에게 넘기는 개수(lib/llm.ts의 CONTEXT_LIMIT)와 같다.
          contextIds: (turn.results ?? []).slice(0, 8).map((r) => r.id),
        }),
      });
      patch(turn.id, { reported: res.ok ? "done" : "failed" });
    } catch {
      patch(turn.id, { reported: "failed" });
    }
  }

  async function ask(id: number, question: string, history: PreviousTurn[]) {
    // 검색과 AI 답변을 동시에 요청한다. 답변 쪽이 훨씬 오래 걸리므로
    // 검색이 끝난 뒤에 시작하면 그만큼 손해다.
    const searchPromise = fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history }),
    });
    const answerPromise = fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: question, history }),
    });
    // 검색이 실패해 아래에서 빠져나가도 예외가 떠돌지 않게 한다.
    answerPromise.catch(() => null);

    // 1단계: 검색 결과를 먼저 받아 즉시 보여준다.
    try {
      const res = await searchPromise;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "검색 실패");
      patch(id, { results: data.results, searching: false });
    } catch (err) {
      patch(id, {
        searchError: err instanceof Error ? err.message : "알 수 없는 오류",
        searching: false,
      });
      return;
    }

    // 2단계: AI 답변은 다 쓰일 때까지 기다리지 않고, 오는 대로 이어 붙인다.
    patch(id, { answering: true });
    let text = "";
    try {
      const res = await answerPromise;
      if (!res.ok) {
        // 라우트가 실패 이유를 담아 보낸다. 그대로 보여줘야 무엇을
        // 고쳐야 할지(키, 모델 이름, 사용량) 알 수 있다.
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `답변 생성 실패 (${res.status})`);
      }
      if (!res.body) throw new Error("답변 생성 실패");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        patch(id, { answer: text.replace(ANSWER_DONE, "") });
      }
      text += decoder.decode();
    } catch (err) {
      // 글이 오다가 연결이 끊긴 것은 아래에서 '중간에 끊김'으로 다룬다.
      if (!text) {
        patch(id, {
          answer: null,
          answerError: err instanceof Error ? err.message : "답변 생성 실패",
          answering: false,
        });
        setOpenRules(id);
        return;
      }
    }

    // 끝까지 쓰였다는 표시가 없으면 중간에 끊긴 것이다. 받은 데까지는
    // 남겨두고, 끊겼다는 것을 알려 다시 물을 수 있게 한다.
    const finished = text.endsWith(ANSWER_DONE);
    const answer = text.replace(ANSWER_DONE, "").trim() || null;
    patch(id, {
      answer,
      answerError: answer && !finished ? "답변이 중간에 끊겼습니다." : null,
      answering: false,
    });
    // 모델이 두 번 다 아무것도 내놓지 못하면 빈 채로 끝난다.
    // 그때는 검색된 조항이라도 바로 보이게 펼쳐둔다.
    if (!answer) setOpenRules(id);
  }

  return (
    <div className="flex h-dvh flex-col bg-zinc-50 font-sans dark:bg-black">
      <header className="shrink-0 border-b border-zinc-200 dark:border-zinc-800">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
              KBO 규칙 검색 테스트
            </h1>
            <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">
              KBO 공식 야구규칙과 KBO 리그 규정에서 찾아 답합니다.
            </p>
          </div>
          <button
            type="button"
            onClick={startNewChat}
            disabled={turns.length === 0}
            className="shrink-0 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 disabled:hover:bg-transparent dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            새 대화
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
      >
        <main className="mx-auto w-full max-w-2xl px-6 pt-6 pb-4">
          {loaded && turns.length === 0 && (
            <p className="py-16 text-center text-sm text-zinc-500">
              궁금한 규칙을 물어보세요. 예: 인필드 플라이 조건은?
            </p>
          )}

          <div className="flex flex-col gap-8">
            {turns.map((turn) => {
              // AI가 답 대신 되물었으면 전용 상자에 머리말을 떼고 보여준다.
              const clarifying = Boolean(turn.answer && isClarification(turn.answer));
              const shown =
                turn.answer && clarifying ? clarificationBody(turn.answer) : turn.answer;
              const parts = shown ? splitAnswer(shown, turn.results ?? []) : [];
              // 지금 원문을 보여줄 조항들. 누른 것 + 마우스를 올린 것.
              const openCites: { key: string; rule: SearchResult }[] = [];
              for (const part of parts) {
                if (!("rule" in part)) continue;
                const key = `${turn.id}:${part.rule.id}`;
                if (!pinnedCites.has(key) && hoverCite !== key) continue;
                if (openCites.some((c) => c.key === key)) continue;
                openCites.push({ key, rule: part.rule });
              }
              return (
                <section key={turn.id} className="flex flex-col gap-3">
                  {/* 질문 */}
                  <div className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-black px-4 py-2 text-sm text-white dark:bg-white dark:text-black">
                      {turn.question}
                    </p>
                  </div>

                  {turn.answering && !turn.answer && (
                    <div className="flex items-center gap-2 text-sm text-zinc-500">
                      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
                      AI가 조항을 읽고 답변을 정리하는 중…
                    </div>
                  )}

                  {turn.answer && (
                    <div
                      className={
                        clarifying
                          ? "rounded-lg border border-sky-300 bg-sky-50 p-4 text-sm whitespace-pre-line text-black dark:border-sky-800 dark:bg-sky-950/40 dark:text-zinc-50"
                          : "rounded-lg border border-zinc-300 bg-white p-4 text-sm whitespace-pre-line text-black dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
                      }
                    >
                      {clarifying && (
                        <p className="mb-1 font-medium text-sky-900 dark:text-sky-200">
                          조금 더 알려주세요
                        </p>
                      )}
                      {parts.map((part, i) =>
                        "rule" in part ? (
                          <button
                            key={i}
                            type="button"
                            onClick={() => toggleCite(`${turn.id}:${part.rule.id}`)}
                            // 커서가 벗어나도 닫지 않는다. 닫기는 '닫기' 버튼이나
                            // 번호를 다시 누르는 것으로만 한다.
                            onMouseEnter={() => setHoverCite(`${turn.id}:${part.rule.id}`)}
                            title={`${part.rule.title} — 눌러서 여닫기`}
                            className={`mx-0.5 rounded px-1 font-medium underline decoration-dotted underline-offset-2 ${
                              pinnedCites.has(`${turn.id}:${part.rule.id}`) ||
                              hoverCite === `${turn.id}:${part.rule.id}`
                                ? "bg-amber-200 text-black dark:bg-amber-300"
                                : "text-blue-700 hover:bg-zinc-100 dark:text-blue-400 dark:hover:bg-zinc-800"
                            }`}
                          >
                            {part.cited}
                          </button>
                        ) : (
                          <span key={i}>{part.text}</span>
                        ),
                      )}
                      {turn === last && awaitingReply && (
                        <p className="mt-3 text-xs text-sky-800 dark:text-sky-300">
                          아래 입력창에 답하면 이 질문에 이어서 답합니다.
                        </p>
                      )}
                    </div>
                  )}

                  {turn.answer && !turn.answering && (
                    <div className="flex justify-end text-xs">
                      {turn.reported === "done" ? (
                        <span className="text-zinc-500">신고했습니다. 고맙습니다.</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => report(turn)}
                          disabled={turn.reported === "sending"}
                          className="text-zinc-500 underline underline-offset-2 hover:text-black disabled:opacity-40 dark:hover:text-zinc-50"
                        >
                          {turn.reported === "sending"
                            ? "보내는 중…"
                            : turn.reported === "failed"
                              ? "신고를 보내지 못했습니다 · 다시 보내기"
                              : "틀렸어요"}
                        </button>
                      )}
                    </div>
                  )}

                  {openCites.map(({ key, rule }) => (
                    <div
                      key={key}
                      className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700/60 dark:bg-amber-950/30"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-black dark:text-zinc-50">
                          {rule.id} {rule.title}
                        </span>
                        <button
                          type="button"
                          onClick={() => closeCite(key)}
                          className="shrink-0 text-xs text-zinc-500 underline underline-offset-2 hover:text-black dark:hover:text-zinc-50"
                        >
                          닫기
                        </button>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {rule.source} · {rule.chapter}
                      </p>
                      {/* 전문을 그대로 보여준다. 높이를 제한하고 안쪽에 스크롤을
                          두면 잘린 줄 모르고 지나친다. 조항 하나가 1,400자면
                          920px인데 288px만 보이고 있었다. */}
                      <p className="mt-2 text-sm whitespace-pre-line text-zinc-700 dark:text-zinc-300">
                        {rule.text}
                      </p>
                    </div>
                  ))}

                  {!turn.searching &&
                    !turn.answering &&
                    (turn.searchError || turn.answerError || !turn.answer) && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span
                          className={
                            turn.searchError ? "text-red-600" : "text-zinc-500"
                          }
                        >
                          {turn.searchError
                            ? `검색 실패: ${turn.searchError}`
                            : turn.answer
                              ? turn.answerError
                              : turn.answerError
                                ? `AI 답변 실패: ${turn.answerError} 검색된 조항만 보여줍니다.`
                                : "AI 답변을 만들지 못해 검색된 조항만 보여줍니다."}
                        </span>
                        <button
                          type="button"
                          onClick={() => retry(turn)}
                          disabled={busy}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-zinc-700 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
                        >
                          {/* 답이 중간에 끊겼으면 검색은 멀쩡하니 '다시 시도'가 맞는 말이다. */}
                          {turn.answer ? "다시 시도" : "재검색"}
                        </button>
                      </div>
                    )}

                  {turn.results && (
                    <details className="text-sm" open={openRules === turn.id}>
                      <summary
                        className="cursor-pointer text-zinc-500 select-none"
                        onClick={(e) => {
                          e.preventDefault();
                          setOpenRules(openRules === turn.id ? null : turn.id);
                        }}
                      >
                        검색된 조항 {turn.results.length}개
                      </summary>
                      <ul className="mt-3 flex flex-col gap-3">
                        {turn.results.length === 0 && (
                          <li className="text-sm text-zinc-500">
                            일치하는 조항을 찾지 못했습니다.
                          </li>
                        )}
                        {turn.results.map((r) => {
                          const key = `${turn.id}:${r.id}`;
                          const isLong = r.text.length > PREVIEW_CHARS;
                          const isOpen = expanded.has(key);
                          return (
                            <li
                              key={key}
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
                                {r.source} · {r.chapter}
                              </p>
                              <p className="mt-2 text-sm whitespace-pre-line text-zinc-700 dark:text-zinc-300">
                                {isLong && !isOpen
                                  ? r.text.slice(0, PREVIEW_CHARS) + "…"
                                  : r.text}
                              </p>
                              {isLong && (
                                <button
                                  type="button"
                                  onClick={() => toggleExpanded(key)}
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
                </section>
              );
            })}
          </div>
        </main>
      </div>

      <div className="shrink-0 border-t border-zinc-200 dark:border-zinc-800">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex w-full max-w-2xl gap-2 px-6 py-4"
        >
          <input
            ref={inputRef}
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              awaitingReply ? "되물은 내용에 답해 주세요" : "예: 인필드 플라이 조건은?"
            }
            className="flex-1 rounded-lg border border-zinc-300 bg-white px-4 py-2 text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-black px-5 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {busy ? "답변 중…" : "검색"}
          </button>
        </form>
      </div>
    </div>
  );
}
