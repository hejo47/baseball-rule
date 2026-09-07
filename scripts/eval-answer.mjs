/**
 * AI 답변 생성 속도 측정 스크립트
 *
 *   npm run dev                          (다른 터미널에서 켜두고)
 *   node scripts/eval-answer.mjs                 지금 설정으로 측정
 *   node scripts/eval-answer.mjs before current  이전 설정과 나란히 비교
 *   node scripts/eval-answer.mjs --limit 5       앞의 5문항만
 *
 * data/testset.json의 질문마다 실제 /api/search로 조항을 뽑고, 그 조항으로
 * 모델을 직접 호출해 (1) 첫 글자가 화면에 뜨기까지 (2) 답변이 끝나기까지
 * 걸린 시간을 잰다. 결과는 results/answer-<프리셋>-<시각>.json에 남는다.
 *
 * 검색 정확도는 scripts/eval-search.mjs가 따로 잰다. 이 스크립트는 속도만 본다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import OpenAI from "openai";

const BASE = process.env.EVAL_BASE ?? "http://localhost:3000";
// 사용자가 기다려주는 한계. 넘기면 끊고 "미완"으로 기록해 측정 시간을 아낀다.
const PATIENCE_MS = 20_000;
// lib/llm.ts의 CONTEXT_LIMIT과 같은 값이어야 한다.
const CONTEXT_LIMIT = 8;

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
};

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);
const names = args.filter((a) => PRESETS[a]);
const RUN = names.length ? names : ["current"];

try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url).pathname);
} catch {
  // 이미 환경변수로 넣어뒀다면 파일이 없어도 된다.
}
if (!process.env.NVIDIA_API_KEY) {
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
const questions = testset.slice(0, LIMIT);

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
  const context = results
    .slice(0, CONTEXT_LIMIT)
    .map((r) => `[${r.id}] ${r.title}\n${r.text}`)
    .join("\n\n---\n\n");

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
for (const { q, level } of questions) {
  const results = await searchApi(q);
  const row = { q, level, runs: {} };

  for (const name of RUN) {
    const { tail, params } = PRESETS[name];
    try {
      row.runs[name] = await measure(buildPrompt(q, results, tail), params);
    } catch (err) {
      row.runs[name] = { error: String(err.message).slice(0, 200) };
    }
    process.stderr.write(".");
  }
  rows.push(row);
}
process.stderr.write("\n\n");

const width = (s, n) => {
  s = String(s);
  let len = 0;
  for (const ch of s) len += /[가-힣ㄱ-ㅎㅏ-ㅣ·…]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - len));
};

// 한 칸에 들어갈 요약. 20초를 넘겨 끊긴 경우는 시간 대신 그 사실을 적는다.
const cell = (r) => {
  if (!r) return "-";
  if (r.error) return "에러";
  if (r.cut) return r.chars ? `20초+ (${(r.ttft / 1000).toFixed(1)}s부터 표시)` : "20초+ 표시 없음";
  if (!r.chars) return `${(r.total / 1000).toFixed(1)}s 빈 답변`;
  return `${(r.total / 1000).toFixed(1)}s (첫글자 ${(r.ttft / 1000).toFixed(1)}s)`;
};

console.log(`대상: ${BASE} · 모델: ${MODEL} · ${questions.length}문항 · 대기 한계 ${PATIENCE_MS / 1000}초\n`);
console.log(width("질문", 34) + width("난이도", 8) + RUN.map((n) => width(PRESETS[n].label, 30)).join(""));
console.log("-".repeat(34 + 8 + 30 * RUN.length));
for (const row of rows) {
  console.log(
    width(row.q, 34) + width(row.level ?? "", 8) + RUN.map((n) => width(cell(row.runs[n]), 30)).join(""),
  );
}
console.log("-".repeat(34 + 8 + 30 * RUN.length));

const summaries = {};
for (const name of RUN) {
  const rs = rows.map((r) => r.runs[name]).filter((r) => r && !r.error);
  const done = rs.filter((r) => !r.cut && r.chars > 0);
  const shown = rs.filter((r) => r.chars > 0);
  const avg = (list, f) => (list.length ? list.reduce((a, r) => a + f(r), 0) / list.length : 0);

  const summary = {
    문항: rs.length,
    "20초 안에 답변 완료": done.length,
    "20초 안에 첫 글자 표시": shown.length,
    "완료된 것의 평균 시간(초)": Number((avg(done, (r) => r.total) / 1000).toFixed(1)),
    "첫 글자까지 평균(초)": Number((avg(shown, (r) => r.ttft) / 1000).toFixed(1)),
    "평균 답변 길이(자)": Math.round(avg(done, (r) => r.chars)),
  };
  summaries[name] = summary;

  console.log(`\n[${PRESETS[name].label}] ${PRESETS[name].note}`);
  for (const [k, v] of Object.entries(summary)) {
    if (k === "문항") continue;
    const suffix = k.startsWith("20초") ? `/${summary.문항}` : "";
    console.log(`  ${width(k, 26)}: ${v}${suffix}`);
  }
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "").replace(/-/g, "");
const out = new URL(`../results/answer-${RUN.join("-")}-${stamp}.json`, import.meta.url);
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(out, JSON.stringify({ base: BASE, model: MODEL, patienceMs: PATIENCE_MS, presets: RUN, summaries, rows }, null, 2));
console.log(`\n결과 저장: results/${out.pathname.split("/").pop()}`);
