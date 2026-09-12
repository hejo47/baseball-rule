/**
 * AI 답변 정확도 + 속도 측정 스크립트
 *
 *   npm run dev                          (다른 터미널에서 켜두고)
 *   node scripts/eval-answer.mjs                 지금 설정으로 측정
 *   node scripts/eval-answer.mjs before current  이전 설정과 나란히 비교
 *   node scripts/eval-answer.mjs --limit 5       앞의 5문항만
 *
 * data/testset.json의 질문마다 실제 /api/search로 조항을 뽑고, 그 조항으로
 * 모델을 직접 호출해 (1) 답이 맞았는지 (2) 첫 글자가 뜨기까지 (3) 답변이
 * 끝나기까지를 잰다. 결과는 results/answer-<프리셋>-<시각>.json에 남는다.
 *
 * 검색 순위만 보는 채점은 scripts/eval-search.mjs가 따로 한다. 그쪽이
 * 만점이어도 모델이 엉뚱한 조항을 인용하거나 지어낼 수 있어서, 최종 답변을
 * 따로 채점해야 "정확도"를 올렸는지 알 수 있다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import OpenAI from "openai";

const BASE = process.env.EVAL_BASE ?? "http://localhost:3000";
// 사용자가 기다려주는 한계. 넘기면 끊고 "미완"으로 기록해 측정 시간을 아낀다.
const PATIENCE_MS = 20_000;
// lib/llm.ts의 CONTEXT_LIMIT과 같은 값이어야 한다.
// --context N 으로 덮어써서 "조항을 몇 개 넘기는 게 좋은가"를 실험할 수 있다.
const DEFAULT_CONTEXT_LIMIT = 8;

// lib/llm.ts의 asksTerm과 같아야 한다.
const ASKS_CASE = /(언제|경우|어떻게|몇 번|조건|하면|되나|절차|신청)/;
const ASKS_TERM = /(뭐야|뭔가|무엇|이란|란\?|어디까지|몇 초)/;

// lib/llm.ts를 고칠 때 여기 current도 같이 고쳐야 비교가 의미 있다.
const PRESETS = {
  before: {
    label: "이전",
    note: "추론 제한 없음, 답변 길이 제한 없음",
    tail: "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).",
    params: { max_tokens: 4096, frequency_penalty: 0.5 },
  },
  current: {
    label: "지금",
    note: "reasoning_effort low, 3~5문장",
    tail:
      "3~5문장으로 짧게 답하라. 표는 쓰지 말고 줄글로 쓴다.\n" +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).",
    params: { max_tokens: 900, frequency_penalty: 0.5, reasoning_effort: "low" },
  },
  // 조건을 흘리는 걸 막아본다.
  //
  // 260912 기준 모델 탓 실패 4건 중 3건이 "답은 맞는데 조건 하나를 빠뜨림"이다.
  // 인필드 플라이는 '무사 또는 1사'를, 타임은 '볼 데드'를, 피치클락은
  // '타석간 33초'를 흘렸다. 셋 다 근거 조항에 그대로 적혀 있던 내용이다.
  // 짧게 쓰라는 지시에 맞추느라 요약하면서 잘라낸 것으로 보인다.
  문장포함: {
    label: "문장포함",
    note: "핵심 문장은 그대로 옮겨 적게",
    tail:
      "질문의 핵심 단어가 들어간 조항 문장은 요약하지 말고 그대로 옮겨 적어라.\n" +
      "그 문장에 있는 조건, 숫자, 예외를 하나도 빼지 마라.\n" +
      "그런 다음 3~5문장으로 풀어서 설명하라. 표는 쓰지 말고 줄글로 쓴다.\n" +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).",
    params: { max_tokens: 900, frequency_penalty: 0.5, reasoning_effort: "low" },
  },
  // lib/llm.ts에 실제로 들어간 방식. 질문 형태에 따라 지시를 나눈다.
  형태별: {
    label: "형태별",
    note: "단어형에만 문장 그대로",
    tail: (ids, question) =>
      (ASKS_TERM.test(question) && !ASKS_CASE.test(question)
        ? "질문의 핵심 단어가 들어간 조항 문장은 요약하지 말고 그대로 옮겨 적어라.\n" +
          "그 문장에 있는 조건, 숫자, 예외를 하나도 빼지 마라.\n" +
          "그런 다음 3~5문장으로 풀어서 설명하라. 표는 쓰지 말고 줄글로 쓴다.\n"
        : "3~5문장으로 짧게 답하라. 표는 쓰지 말고 줄글로 쓴다.\n") +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).",
    params: { max_tokens: 900, frequency_penalty: 0.5, reasoning_effort: "low" },
  },
  // 위와 같되 "표는 쓰지 말고"를 뺀다.
  // 피치클락 규정의 답은 하필 표로 되어 있어, 그 지시가 표 안의 숫자까지
  // 버리게 만들었을 수 있다.
  문장포함표허용: {
    label: "문장포함+표허용",
    note: "핵심 문장 그대로 + 표 금지 해제",
    tail:
      "질문의 핵심 단어가 들어간 조항 문장은 요약하지 말고 그대로 옮겨 적어라.\n" +
      "그 문장에 있는 조건, 숫자, 예외를 하나도 빼지 마라.\n" +
      "그런 다음 3~5문장으로 풀어서 설명하라.\n" +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).",
    params: { max_tokens: 900, frequency_penalty: 0.5, reasoning_effort: "low" },
  },
};

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);
const ctxAt = args.indexOf("--context");
const CONTEXT_LIMIT = ctxAt === -1 ? DEFAULT_CONTEXT_LIMIT : Number(args[ctxAt + 1]);
const names = args.filter((a) => PRESETS[a]);
// 채점 기준을 고쳤을 때, 모델을 다시 부르지 않고 지난 측정을 다시 채점한다.
// 답변 본문이 결과 파일에 그대로 남아 있어서 재채점만 하면 된다.
const regradeAt = args.indexOf("--regrade");
const REGRADE = regradeAt === -1 ? null : args[regradeAt + 1];
let RUN = names.length ? names : ["current"];

try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url).pathname);
} catch {
  // 이미 환경변수로 넣어뒀다면 파일이 없어도 된다.
}
if (!REGRADE && !process.env.NVIDIA_API_KEY) {
  console.error("NVIDIA_API_KEY가 없습니다. .env.local을 확인하세요.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
  timeout: 180_000,
  maxRetries: 0,
});
const MODEL = process.env.NVIDIA_MODEL ?? "openai/gpt-oss-20b";

const testset = JSON.parse(
  await readFile(new URL("../data/testset.json", import.meta.url), "utf8"),
);
// lib/search.ts의 DOCS와 같아야 한다. 리그 규정을 빼먹으면 그 조항들을
// 전부 "없는 번호"로 세고, 본문 조회도 빈 문자열이 돼 검색 탓/모델 탓
// 판정까지 틀어진다.
const rules = [
  ...JSON.parse(await readFile(new URL("../data/rules.json", import.meta.url), "utf8")),
  ...JSON.parse(await readFile(new URL("../data/league.json", import.meta.url), "utf8")),
];
const questions = testset.slice(0, LIMIT);

// ------------------------------------------------------------- 인용 채점

const RULE_IDS = rules.map((r) => r.id);

// 모델이 "정의-30"을 "정의‑30"(U+2011 등 유니코드 하이픈)으로 적는 일이 잦다.
// 눈으로는 같은 글자라 인용을 놓친 줄도 모르고 오답으로 셌었다.
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

const normId = (s) =>
  String(s).replace(DASHES, "-").replace(/\s+/g, "").replace(/[.·,]+$/, "");

/**
 * 두 조항 번호가 같은 곳을 가리키는지 본다.
 *
 * 모델이 5.05⑵ 대신 5.05처럼 상위 번호만 적는 일이 잦다. 규칙집은 긴
 * 조항을 하위 항목으로 쪼개 색인해서 "5.05"라는 id 자체가 없는데, 이걸
 * 지어낸 번호로 세면 환각 수치가 부풀려진다. 한쪽이 다른 쪽으로 시작하면
 * 같은 조항을 가리킨 것으로 본다.
 */
function relates(a, b) {
  const x = normId(a);
  const y = normId(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/**
 * 답변에서 대괄호로 표기된 조항 번호를 모은다.
 *
 * 프롬프트가 [5.05⑵] 꼴을 요구하지만 실제로는 [5.06⒞, 5.09⒠]처럼 묶어
 * 적거나 [규칙 5.11]처럼 군더더기를 붙이는 경우가 있어 느슨하게 판다.
 * 조항 번호처럼 생기지 않은 대괄호([주1] 등)는 버린다.
 */
function parseCitations(text) {
  const out = [];
  for (const [, raw] of text.matchAll(/\[([^\]\n]{1,80})\]/g)) {
    const inner = raw.replace(DASHES, "-");
    for (const piece of inner.split(/[,;·]|\s{2,}/)) {
      // 야구규칙(5.05⒜, 정의-40)과 리그 규정(리그-제28조-4) 두 가지 꼴이 있다.
      const m = piece.match(
        /(리그-[가-힣A-Za-z0-9()\-①-⑳]+|정의\s*-\s*\d{1,3}|\d{1,2}\.\d{2}[⒜-⒵⑴-⒇]*)/,
      );
      if (m) out.push(normId(m[1]));
    }
  }
  return [...new Set(out)];
}

const REFUSAL = /찾지\s*못했|찾을\s*수\s*없|규칙집에\s*없/;

/**
 * 답을 못 하겠다고 물러선 답변인지 본다. **첫 문장만** 본다.
 *
 * 예전에는 답변 아무 데서나 찾으면 거부로 봤다. 그래서 제대로 답해놓고
 * 끝에 "이외의 경우는 규칙집에서 찾지 못했습니다"를 덧붙인 답변까지
 * 포기로 분류됐다. (`타임은 언제 선언할 수 있어?`)
 * 진짜 거부는 첫 문장부터 못 찾았다고 말한다.
 */
function isRefusal(text) {
  const first = text.trim().split(/(?<=[.!?다])\s+/)[0] ?? "";
  return REFUSAL.test(first);
}

/** 띄어쓰기와 대소문자 차이를 지운다. "볼 데드"와 "볼데드"를 같게 본다. */
const flat = (s) => String(s).replace(/\s+/g, "").toLowerCase();

/**
 * 답변 하나를 채점한다.
 *
 * 조항 번호를 맞혔는지가 아니라 **답에 들어가야 할 내용이 들어갔는지**를 본다.
 *
 * 예전에는 testset의 expect와 인용 번호를 대조했는데, 파서를 고쳐 조항이
 * 제대로 쪼개지자 정답이 될 수 있는 조항이 여러 개가 됐다. 모델이 더 나은
 * 조항을 골라도 오답이 되는 일이 생겨(세트 포지션의 정의-70은 "두 가지
 * 정규투구자세 가운데 하나다"가 전부인데 모델은 실제 설명이 있는 5.07⒜⑵를
 * 골랐다) 기준을 내용 쪽으로 옮겼다.
 *
 * 필요한 내용이 조항 하나에 다 없는 경우도 있다. "투수가 이물질을 바르면"은
 * 금지 행위가 6.02⒞에, 벌칙(즉시 퇴장)이 6.02⒟에 나뉘어 있다.
 *
 * 틀렸을 때 "검색 탓"과 "모델 탓"을 가르는 건 그대로 둔다. 다만 기준이
 * 나아졌다. 빠진 내용이 넘겨준 조항 안에 있었으면 모델 탓, 없었으면 검색 탓이다.
 */
function grade({ expect = [], must, text, contextIds }) {
  const cited = parseCitations(text);
  const invented = cited.filter((c) => !RULE_IDS.some((id) => relates(c, id)));
  const outside = cited.filter(
    (c) => !invented.includes(c) && !contextIds.some((id) => relates(c, id)),
  );
  // 필드 이름이 measure()의 total(걸린 밀리초)과 겹치면 시간이 덮인다.
  const base = { cited, invented, outside, hits: [], misses: [], mustTotal: must.length };

  // 모델이 추론만 하다 끝나 본문을 한 글자도 안 뱉는 경우가 있다.
  if (!text.trim()) {
    return { ...base, verdict: "빈답변", correct: false, searchMissed: false };
  }

  const refused = isRefusal(text);

  // 함정 문제: 채점할 내용이 없다. 못 찾았다고 답하는 게 정답이다.
  if (must.length === 0) {
    return {
      ...base,
      verdict: refused ? "정답" : "지어냄",
      correct: refused,
      searchMissed: false,
    };
  }

  const said = flat(text);

  const hits = [];
  const misses = [];
  for (const item of must) {
    const found = item.any.some((phrase) => said.includes(flat(phrase)));
    (found ? hits : misses).push(item);
  }

  // 검색이 정답 조항을 넘겨주기는 했나.
  //
  // 예전에는 "빠뜨린 내용의 표현이 넘겨준 조항 본문에 있나"로 봤는데,
  // "1루"나 "진루" 같은 흔한 말은 아무 조항에나 있어서 검색이 실패한
  // 경우까지 모델 탓으로 넘어갔다. (`몸에 맞는 공`은 정답 5.06⒞가 9등이라
  // 넘어가지도 않았는데 모델 탓으로 찍혔다)
  //
  // testset의 expect는 검색이 물어와야 할 조항이다. 답이 맞았는지는
  // 내용(must)으로 보고, 탓을 가르는 데만 expect를 쓴다.
  const gotSource =
    expect.length === 0 ||
    expect.some((id) => contextIds.some((c) => relates(c, id)));
  const searchMissed = misses.length > 0 && !gotSource;

  let verdict;
  if (misses.length === 0) verdict = "정답";
  else if (searchMissed) verdict = "검색실패";
  else if (refused) verdict = "포기";
  else if (hits.length >= must.length / 2) verdict = "일부";
  else verdict = "놓침";

  return {
    ...base,
    verdict,
    correct: misses.length === 0,
    hits: hits.map((i) => i.name),
    misses: misses.map((i) => i.name),
    searchMissed,
  };
}

// ------------------------------------------------------------- 측정

async function searchApi(message) {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).results ?? [];
}

function buildPrompt(question, results, tail) {
  const shown = results.slice(0, CONTEXT_LIMIT);
  const context = shown
    .map((r) => `[${r.id}] ${r.title} (${r.source})\n${r.text}`)
    .join("\n\n---\n\n");

  // 프리셋에 따라 넘긴 조항 번호를 지시문에 넣어야 할 때가 있다.
  if (typeof tail === "function") tail = tail(shown.map((r) => r.id), question);

  return `아래는 KBO 공식 야구규칙과 KBO 리그 규정에서 검색으로 찾은 조항들이다.
이 조항들만 근거로 질문에 답하라.
조항에 없는 내용은 추측하지 말고 "규칙집에서 찾지 못했습니다"라고 답하라.
근거가 어느 문서에서 왔는지 답변에 밝혀라. 야구규칙과 리그 규정은 다른 문서다.
${tail}

# 검색된 조항
${context}

# 질문
${question}`;
}

// 스트리밍으로 받아 첫 글자까지의 시간을 잰다. 이전 설정은 스트리밍이
// 아니었지만, 같은 조건에서 재야 비교가 되므로 양쪽 다 스트리밍으로 잰다.
// (이전 설정에서는 어차피 첫 글자가 곧 완료 시점이나 마찬가지였다.)
async function measure(prompt, params) {
  const started = Date.now();
  let ttft = null;
  let text = "";
  let usage = null;
  let cut = false;

  const stream = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
    ...params,
  });

  for await (const chunk of stream) {
    const piece = chunk.choices[0]?.delta?.content ?? "";
    if (piece && ttft === null) ttft = Date.now() - started;
    text += piece;
    if (chunk.usage) usage = chunk.usage;
    if (Date.now() - started > PATIENCE_MS) {
      cut = true;
      break;
    }
  }
  if (cut) await stream.controller.abort();

  return {
    total: Date.now() - started,
    ttft,
    text: text.trim(),
    chars: text.trim().length,
    outTokens: usage?.completion_tokens ?? null,
    promptTokens: usage?.prompt_tokens ?? null,
    cut,
  };
}

const rows = [];
// 지난 측정을 다시 채점할 때도 채점 기준은 지금 testset에서 가져온다.
const MUST = Object.fromEntries(testset.map((t) => [t.q, t.must ?? []]));

if (REGRADE) {
  // 경로는 절대경로이거나 프로젝트 루트 기준 상대경로(results/...)로 받는다.
  const src = REGRADE.startsWith("/")
    ? REGRADE
    : new URL(`../${REGRADE}`, import.meta.url);
  const past = JSON.parse(await readFile(src, "utf8"));
  RUN = past.presets;
  for (const row of past.rows) {
    const next = { ...row, runs: {} };
    for (const name of RUN) {
      const run = row.runs[name];
      next.runs[name] = run?.error
        ? run
        : { ...run, ...grade({ expect: row.expect ?? [], must: MUST[row.q] ?? [], text: run.text, contextIds: row.contextIds }) };
    }
    rows.push(next);
  }
} else
for (const { q, expect, level, must = [] } of questions) {
  const results = await searchApi(q);
  const contextIds = results.slice(0, CONTEXT_LIMIT).map((r) => r.id);
  const row = { q, level, expect, must: must.map((m) => m.name), contextIds, runs: {} };

  for (const name of RUN) {
    const { tail, params } = PRESETS[name];
    try {
      const run = await measure(buildPrompt(q, results, tail), params);
      row.runs[name] = { ...run, ...grade({ expect, must, text: run.text, contextIds }) };
    } catch (err) {
      row.runs[name] = { error: String(err.message).slice(0, 200) };
    }
    process.stderr.write(".");
  }
  rows.push(row);
}
process.stderr.write("\n\n");

// ------------------------------------------------------------- 출력

const width = (s, n) => {
  s = String(s);
  let len = 0;
  for (const ch of s) len += /[가-힣ㄱ-ㅎㅏ-ㅣ·…]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - len));
};

// 한 칸에 들어갈 요약. 판정을 앞에, 걸린 시간을 뒤에 적는다.
// 판정과 '필요한 내용 중 몇 개를 말했는지'를 함께 보여준다.
const cell = (r) => {
  if (!r) return "-";
  if (r.error) return "에러";
  if (!r.chars) return "빈 답변";
  // 판정 · 필요한 내용 중 몇 개를 말했는지 · 걸린 시간
  const score = r.mustTotal ? ` ${r.hits.length}/${r.mustTotal}` : "";
  const flag = r.invented.length ? "+지어냄" : "";
  return `${r.verdict}${score}${flag} ${(r.total / 1000).toFixed(1)}s`;
};

console.log(`대상: ${BASE} · 모델: ${MODEL} · ${questions.length}문항 · 조항 ${CONTEXT_LIMIT}개 · 대기 한계 ${PATIENCE_MS / 1000}초\n`);
console.log(width("질문", 34) + width("난이도", 8) + RUN.map((n) => width(PRESETS[n].label, 22)).join(""));
console.log("-".repeat(34 + 8 + 22 * RUN.length));
for (const row of rows) {
  console.log(
    width(row.q, 34) + width(row.level ?? "", 8) + RUN.map((n) => width(cell(row.runs[n]), 22)).join(""),
  );
}
console.log("-".repeat(34 + 8 + 22 * RUN.length));

const summaries = {};
for (const name of RUN) {
  const rs = rows.map((r) => r.runs[name]).filter((r) => r && !r.error);
  const done = rs.filter((r) => !r.cut && r.chars > 0);
  const shown = rs.filter((r) => r.chars > 0);
  const avg = (list, f) => (list.length ? list.reduce((a, r) => a + f(r), 0) / list.length : 0);
  const count = (v) => rs.filter((r) => r.verdict === v).length;
  const pct = (n) => `${n}/${rs.length} (${((n / (rs.length || 1)) * 100).toFixed(0)}%)`;

  // 문항 단위(전부 말했나)와 항목 단위(70개 중 몇 개를 말했나)를 같이 본다.
  // 문항 단위만 보면 4개 중 3개를 말한 답과 하나도 못 말한 답이 똑같이 오답이 된다.
  const items = rs.reduce((a, r) => a + (r.mustTotal ?? 0), 0);
  const itemHits = rs.reduce((a, r) => a + (r.hits?.length ?? 0), 0);

  const summary = {
    문항: rs.length,
    전부_말한_문항: rs.filter((r) => r.correct).length,
    채점항목: items,
    말한_항목: itemHits,
    일부만_말함: count("일부"),
    놓침_모델탓: count("놓침"),
    포기_모델탓: count("포기"),
    검색실패_검색탓: count("검색실패"),
    지어냄_함정오답: count("지어냄"),
    빈답변: count("빈답변"),
    없는조항_지어냄: rs.filter((r) => r.invented?.length).length,
    컨텍스트밖_인용: rs.filter((r) => r.outside?.length).length,
    "20초 안에 답변 완료": done.length,
    "20초 안에 첫 글자 표시": shown.length,
    "완료된 것의 평균 시간(초)": Number((avg(done, (r) => r.total) / 1000).toFixed(1)),
    "첫 글자까지 평균(초)": Number((avg(shown, (r) => r.ttft) / 1000).toFixed(1)),
    "평균 답변 길이(자)": Math.round(avg(done, (r) => r.chars)),
  };
  summaries[name] = summary;

  console.log(`\n[${PRESETS[name].label}] ${PRESETS[name].note}`);
  console.log(`  ── 정확도 ──`);
  console.log(`  ${width("필요한 내용을 전부 말함", 26)}: ${pct(summary.전부_말한_문항)}`);
  console.log(`  ${width("항목 단위 적중", 26)}: ${itemHits}/${items} (${((itemHits / (items || 1)) * 100).toFixed(0)}%)`);
  console.log(`  ${width("틀림 - 모델 탓", 26)}: ${summary.일부만_말함 + summary.놓침_모델탓 + summary.포기_모델탓 + summary.지어냄_함정오답 + summary.빈답변}`);
  console.log(`  ${width("  절반 이상은 말함", 26)}: ${summary.일부만_말함}`);
  console.log(`  ${width("  절반도 못 말함", 26)}: ${summary.놓침_모델탓}`);
  console.log(`  ${width("  근거 받고도 못 찾겠다 함", 26)}: ${summary.포기_모델탓}`);
  console.log(`  ${width("  함정에 답을 지어냄", 26)}: ${summary.지어냄_함정오답}`);
  console.log(`  ${width("  답변이 비어 있음", 26)}: ${summary.빈답변}`);
  console.log(`  ${width("틀림 - 검색 탓", 26)}: ${summary.검색실패_검색탓}`);
  console.log(`  ${width("없는 조항 번호 지어냄", 26)}: ${summary.없는조항_지어냄}`);
  console.log(`  ${width("안 넘긴 조항 끌어다 씀", 26)}: ${summary.컨텍스트밖_인용}`);
  console.log(`  ── 속도 ──`);
  for (const k of ["20초 안에 답변 완료", "20초 안에 첫 글자 표시", "완료된 것의 평균 시간(초)", "첫 글자까지 평균(초)", "평균 답변 길이(자)"]) {
    const suffix = k.startsWith("20초") ? `/${summary.문항}` : "";
    console.log(`  ${width(k, 26)}: ${summary[k]}${suffix}`);
  }
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "").replace(/-/g, "");
const out = new URL(
  `../results/answer-${RUN.join("-")}-조항${CONTEXT_LIMIT}개${REGRADE ? "-재채점" : ""}-${stamp}.json`,
  import.meta.url,
);
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify({ base: BASE, model: MODEL, patienceMs: PATIENCE_MS, contextLimit: CONTEXT_LIMIT, presets: RUN, summaries, rows }, null, 2));
console.log(`\n결과 저장: results/${decodeURIComponent(out.pathname.split("/").pop())}`);
