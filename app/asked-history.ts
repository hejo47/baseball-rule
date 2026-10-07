/**
 * 입력창에서 ↑/↓로 다시 불러올 수 있는, 앞서 한 질문 기록.
 *
 * 대화(chat-history.ts)와 따로 이 탭의 sessionStorage에 둔다. "새 대화"로
 * 대화를 비워도 기록은 남고, 탭을 닫으면 사라진다.
 */
const STORAGE_KEY = "kbo-rules:asked:v1";
// 오래된 것부터 버린다.
const LIMIT = 10;

/** 오래된 것부터 최근 것 순서. */
export function readAsked(): string[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === "string")
      : [];
  } catch {
    // 저장소를 못 쓰는 브라우저(개인정보 보호 모드 등)이거나 내용이 깨졌다.
    return [];
  }
}

/** 질문을 기록 맨 뒤에 넣는다. 같은 질문이 앞에 있으면 지워 10칸을 아낀다. */
export function rememberAsked(question: string) {
  const next = [...readAsked().filter((q) => q !== question), question].slice(-LIMIT);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 저장 못 해도 질문은 그대로 진행된다. ↑ 기록만 안 남을 뿐이다.
  }
}
