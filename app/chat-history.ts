/**
 * 지금 대화를 이 브라우저에 남겨둔다. 새로고침하거나 다시 들어와도 이어진다.
 *
 * 지난 대화 목록은 두지 않는다. 대화는 하나뿐이고, "새 대화"를 누르면 비운다.
 *
 * 브라우저 저장소는 서버에서 읽을 수 없어서, 처음 그리는 순간에는 서버와
 * 브라우저가 서로 다른 화면을 만들게 된다. useEffect에서 읽어 setState하는
 * 흔한 방법은 린트 규칙(react-hooks/set-state-in-effect)이 막고 있어,
 * 외부 저장소를 구독하는 useSyncExternalStore에 맞춰 만들었다. 서버에서는
 * null(아직 안 읽음)을 주고, 브라우저에서 저장된 내역으로 바꿔 끼운다.
 */
import type { SearchResult } from "@/lib/search";

/** 질문 하나와 그에 딸린 결과. 물어볼 때마다 하나씩 쌓인다. */
export interface Turn {
  id: number;
  question: string;
  results: SearchResult[] | null;
  answer: string | null;
  searchError: string | null;
  answerError: string | null;
  searching: boolean;
  answering: boolean;
}

const STORAGE_KEY = "kbo-rules:chat:v1";

/** null이면 아직 저장소를 읽지 않은 것이다. */
let turns: Turn[] | null = null;
const listeners = new Set<() => void>();

const INTERRUPTED = "답변을 받는 도중에 끊겼습니다.";

function read(): Turn[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    // 답변을 받는 도중에 새로고침했으면 그 질문은 멈춘 채로 되살리고,
    // 끊겼다는 걸 알린다. 받던 데까지는 남긴다. 화면은 오류가 있는
    // 질문에 재검색 버튼을 붙인다.
    return (parsed as Turn[]).map((t) =>
      t.searching || t.answering
        ? { ...t, searching: false, answering: false, answerError: INTERRUPTED }
        : t,
    );
  } catch {
    // 저장소를 못 쓰는 브라우저(개인정보 보호 모드 등)이거나 내용이 깨졌다.
    return [];
  }
}

// 답변이 흘러들어오는 동안에는 2초에 한 번만 저장한다. 글자 조각이 올
// 때마다 대화 전체(질문 하나에 20KB쯤)를 다시 쓰면 화면이 버벅인다.
// 그렇다고 다 받을 때까지 미루면, 도중에 새로고침했을 때 끊긴 질문이
// "답변을 만들지 못했다"는 엉뚱한 상태로 남는다.
const SAVE_EVERY_MS = 2000;
let pendingSave: ReturnType<typeof setTimeout> | null = null;

// 새로고침하거나 창을 닫으면 브라우저가 진행 중인 요청을 끊는다. 그러면
// 화면 쪽은 그걸 "답변 실패(Failed to fetch)"로 받아 저장하려 드는데,
// 그대로 두면 방금 저장한 "받는 중" 상태를 덮어써서 다시 열었을 때
// 끊긴 게 아니라 실패한 것처럼 보인다. 떠나기 직전에 받던 데까지
// 저장해 두고, 그 뒤로 들어오는 변경은 저장하지 않는다.
let leaving = false;

function saveBeforeLeaving() {
  if (leaving) return;
  // 아직 저장 못 한 게 있을 때만 쓴다. 무조건 쓰면 다른 창에서 비운
  // 대화를 이 창이 들고 있던 내역으로 되살려 놓는다.
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
    if (turns) persist(turns);
  }
  leaving = true;
}

if (typeof window !== "undefined") {
  // 새로고침할 때 신호가 오는 순서를 재 보니 이랬다.
  //   beforeunload → 요청이 끊겨 생긴 "실패" 처리 → pagehide
  // pagehide만 받으면 이미 실패가 저장된 뒤라 늦는다.
  window.addEventListener("beforeunload", () => {
    saveBeforeLeaving();
    // 다운로드 링크처럼 beforeunload만 오고 페이지는 그대로 남는 경우가
    // 있다. 1초 뒤에도 살아 있으면 떠나지 않은 것으로 보고 다시 저장한다.
    setTimeout(() => {
      leaving = false;
    }, 1000);
  });
  // 모바일 브라우저는 beforeunload를 건너뛰기도 한다.
  window.addEventListener("pagehide", saveBeforeLeaving);
  // 뒤로 가기 캐시에서 되살아난 경우에는 다시 저장해야 한다.
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
}

function write(next: Turn[]) {
  if (leaving) return;
  if (!next.some((t) => t.searching || t.answering)) {
    if (pendingSave) clearTimeout(pendingSave);
    pendingSave = null;
    persist(next);
    return;
  }
  if (pendingSave) return;
  pendingSave = setTimeout(() => {
    pendingSave = null;
    if (turns) persist(turns);
  }, SAVE_EVERY_MS);
}

function persist(next: Turn[]) {
  // 조항 원문까지 들고 있어서 질문 하나가 20KB쯤 된다. 저장소가 차면
  // 오래된 질문부터 덜어내며 다시 시도한다.
  let keep = next;
  for (;;) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keep));
      return;
    } catch {
      if (keep.length <= 1) return;
      keep = keep.slice(Math.ceil(keep.length / 4));
    }
  }
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTurns(): Turn[] {
  if (turns === null) turns = read();
  return turns;
}

export function getServerTurns(): null {
  return null;
}

export function updateTurns(update: (prev: Turn[]) => Turn[]) {
  turns = update(getTurns());
  write(turns);
  for (const listener of listeners) listener();
}
