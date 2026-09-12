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
  // 넘겨주지 않은 조항 번호를 지어내는 걸 막아본다.
  // 260912 기준 남은 실패 3건 중 2건이 6.02⒜, 9.13처럼 있지도 않은 번호였다.
  인용제한: {
    label: "인용제한",
    note: "목록 밖 번호 금지 (지시문만)",
    tail:
      "3~5문장으로 짧게 답하라. 표는 쓰지 말고 줄글로 쓴다.\n" +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).\n" +
      "인용은 위에 제시된 조항 번호 중에서만 골라라. 목록에 없는 번호는 절대 쓰지 마라.",
    params: { max_tokens: 900, frequency_penalty: 0.5, reasoning_effort: "low" },
  },
  인용제한목록: {
    label: "인용제한+목록",
    note: "쓸 수 있는 번호를 따로 나열",
    tail: (ids) =>
      "3~5문장으로 짧게 답하라. 표는 쓰지 말고 줄글로 쓴다.\n" +
      "답변 끝에 참고한 조항 번호를 대괄호로 표기하라 (예: [5.05⑵]).\n" +
      `인용할 수 있는 번호는 이것뿐이다: ${ids.join(", ")}\n` +
      "이 목록에 없는 번호는 절대 쓰지 마라.",
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
const rules = JSON.parse(
  await readFile(new URL("../data/rules.json", import.meta.url), "utf8"),
);
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
      const m = piece.match(/(정의\s*-\s*\d{1,3}|\d{1,2}\.\d{2}[⒜-⒵⑴-⒇]*)/);
      if (m) out.push(normId(m[1]));
    }
  }
  return [...new Set(out)];
}

const REFUSAL = /찾지\s*못했|찾을\s*수\s*없|규칙집에\s*없/;

/**
 * 답변 하나를 채점한다.
 *
 * 틀린 답을 "검색 탓"과 "모델 탓"으로 갈라놓는 게 핵심이다. 정답 조항을
 * 애초에 안 넘겨줬으면 검색을 고쳐야 하고, 넘겨줬는데도 안 썼으면 프롬프트나
 * 모델을 고쳐야 해서 할 일이 완전히 달라진다.
 */
function grade({ expect, text, contextIds }) {
  // 모델이 추론만 하다 끝나 본문을 한 글자도 안 뱉는 경우가 있다.
  // 인용이 없다는 점에서는 오답과 같지만 고칠 곳이 달라 따로 센다.
  if (!text.trim()) {
    return { verdict: "빈답변", correct: false, cited: [], invented: [], outside: [], searchMissed: false };
  }

  const cited = parseCitations(text);
  const refused = REFUSAL.test(text);

  // 지어낸 번호: 규칙집에 그런 조항이 아예 없다.
  const invented = cited.filter((c) => !RULE_IDS.some((id) => relates(c, id)));
  // 넘겨주지 않은 조항을 끌어다 썼다. 규칙집엔 있지만 근거로 본 적은 없는 것.
  const outside = cited.filter(
    (c) => !invented.includes(c) && !contextIds.some((id) => relates(c, id)),
  );

  // 함정 문제: 정답 조항이 없는 게 정답이다.
  if (expect.length === 0) {
    return {
      verdict: refused ? "정답" : "지어냄",
      correct: refused,
      cited,
      invented,
      outside,
      searchMissed: false,
    };
  }

  const searchMissed = !expect.some((e) => contextIds.some((c) => relates(c, e)));
  const exact = expect.some((e) => cited.some((c) => normId(c) === normId(e)));
  const partial = !exact && expect.some((e) => cited.some((c) => relates(c, e)));

  let verdict;
  if (exact) verdict = "정답";
  else if (partial) verdict = "부분";       // 상위 번호만 적음 (5.05⑵ -> 5.05)
  else if (searchMissed) verdict = "검색실패"; // 근거를 못 받았으니 모델 탓이 아니다
  else if (refused) verdict = "포기";        // 근거를 받고도 못 찾았다고 답함
  else verdict = "놓침";                     // 근거를 받고도 엉뚱한 조항을 인용

  return {
    verdict,
    correct: exact || partial,
    cited,
    invented,
    outside,
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
    .map((r) => `[${r.id}] ${r.title}\n${r.text}`)
    .join("\n\n---\n\n");

  // 프리셋에 따라 넘긴 조항 번호를 지시문에 넣어야 할 때가 있다.
  if (typeof tail === "function") tail = tail(shown.map((r) => r.id));

  return `아래는 KBO 공식 야구규칙에서 검색으로 찾은 조항들이다. 이 조항들만 근거로 질문에 답하라.
조항에 없는 내용은 추측하지 말고 "규칙집에서 찾지 못했습니다"라고 답하라.
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
    temperature: 0.2,
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
        : { ...run, ...grade({ expect: row.expect, text: run.text, contextIds: row.contextIds }) };
    }
    rows.push(next);
  }
} else
for (const { q, expect, level } of questions) {
  const results = await searchApi(q);
  const contextIds = results.slice(0, CONTEXT_LIMIT).map((r) => r.id);
  const row = { q, level, expect, contextIds, runs: {} };

  for (const name of RUN) {
    const { tail, params } = PRESETS[name];
    try {
      const run = await measure(buildPrompt(q, results, tail), params);
      row.runs[name] = { ...run, ...grade({ expect, text: run.text, contextIds }) };
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
const cell = (r) => {
  if (!r) return "-";
  if (r.error) return "에러";
  if (r.cut) return `20초+ ${r.verdict ?? ""}`.trim();
  if (!r.chars) return `${(r.total / 1000).toFixed(1)}s 빈 답변`;
  const flag = r.invented.length ? "+지어냄" : r.outside.length ? "+밖인용" : "";
  return `${r.verdict}${flag} ${(r.total / 1000).toFixed(1)}s`;
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

  const summary = {
    문항: rs.length,
    맞힌_문항: rs.filter((r) => r.correct).length,
    정답: count("정답"),
    부분정답: count("부분"),
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
  console.log(`  ${width("맞힘(정답+부분)", 26)}: ${pct(summary.맞힌_문항)}`);
  console.log(`  ${width("  정답 조항 정확히 인용", 26)}: ${summary.정답}`);
  console.log(`  ${width("  상위 번호만 인용", 26)}: ${summary.부분정답}`);
  console.log(`  ${width("틀림 - 모델 탓", 26)}: ${summary.놓침_모델탓 + summary.포기_모델탓 + summary.지어냄_함정오답 + summary.빈답변}`);
  console.log(`  ${width("  근거 받고도 엉뚱한 인용", 26)}: ${summary.놓침_모델탓}`);
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
