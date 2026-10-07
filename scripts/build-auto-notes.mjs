/**
 * 조항 전체에 사람 말 설명을 자동으로 만들어 data/plain-auto.json에 저장한다.
 *
 *   node scripts/build-auto-notes.mjs            없거나 원문이 바뀐 조항만 만든다
 *   node scripts/build-auto-notes.mjs --limit 5  앞의 5개만 (시험용)
 *
 * 손으로 붙인 사람 말 설명(data/plain.json)이 효과가 컸다(라인드라이브 16등 -> 4등,
 * 몸에 맞는 공 9등 -> 1등). 질문마다 손으로 붙이는 대신 전부 AI로 만든다.
 * Anthropic의 Contextual Retrieval과 같은 생각이다(조각에 설명을 붙여 검색하면
 * 검색 실패가 35~49% 줄었다고 한다). 자세한 배경은 docs/search.md.
 *
 * **261007 측정 결과 검색이 나아지지 않아 지금은 어디에도 쓰지 않는다.**
 * 글자 색인, 뜻 점수, 원문과 합친 벡터 등 여섯 가지로 붙여봤지만 시험 밖 질문
 * 12개에서 상위 8개 안이 10개 -> 8~10개로 같거나 나빠졌다(docs/search.md 5절).
 * 손으로 붙인 설명은 틀린 질문의 정답 조항 하나만 끌어올려서 효과가 있었고,
 * 전부에 붙이면 모든 조항이 같이 올라가 차이가 사라진다. 만든 설명에 틀린
 * 내용도 섞여 있다(5.05⒜에서 "포수"를 "투수"로, 핵심 조건 누락).
 * 다른 방식으로 다시 써볼 때를 위해 스크립트와 결과(data/plain-auto.json)는 남긴다.
 *
 * 무료 API가 자주 끊기므로 하나 만들 때마다 파일에 저장한다. 중간에 멈춰도
 * 다시 돌리면 이어서 만든다. 조항 원문이 바뀌면(source 지문이 다르면) 다시 만든다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const MODEL = process.env.NVIDIA_MODEL ?? "openai/gpt-oss-20b";
// 무료 API가 동시에 많이 받으면 과부하(503)를 낸다.
const CONCURRENCY = 4;
const TRIES = 5;
const OUT = new URL("../data/plain-auto.json", import.meta.url);

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // 이미 환경변수로 넣어뒀다면 파일이 없어도 된다.
}
if (!process.env.NVIDIA_API_KEY) {
  console.error("NVIDIA_API_KEY가 없습니다. .env.local을 확인하세요.");
  process.exit(1);
}

const args = process.argv.slice(2);
const limitAt = args.indexOf("--limit");
const LIMIT = limitAt === -1 ? Infinity : Number(args[limitAt + 1]);

// lib/search.ts의 DOCS와 같은 순서.
const docs = [
  ...JSON.parse(await readFile(new URL("../data/rules.json", import.meta.url), "utf8")),
  ...JSON.parse(await readFile(new URL("../data/league.json", import.meta.url), "utf8")),
];

/** 조항 원문의 지문. 원문이 바뀌면 설명을 다시 만든다. */
const fingerprint = (d) =>
  createHash("sha1").update(`${d.title}\n${d.text}`).digest("hex").slice(0, 12);

function prompt(d) {
  return `아래는 ${d.source}의 조항 하나다.
이 조항을 야구 팬이 질문할 때 쓰는 쉬운 말로 풀어 써라.

- 조항에 적힌 내용만 쓴다. 조항에 없는 규칙, 조건, 해석, 예시를 덧붙이지 마라.
- 이 조항이 어떤 경기 상황에 적용되는지 먼저 말하라.
- 조항이 여러 상황을 다루면 상황마다 한 문장씩 쓴다.
- 조항에 나오는 규칙집 용어에 사람들이 흔히 부르는 다른 이름이 있으면 함께 써라.
- 2~5문장. "~다"로 끝나는 문장으로 쓰고, 머리말이나 목록 기호 없이 본문만 써라.

# 조항
[${d.id}] ${d.title} (${d.chapter})
${d.text}`;
}

async function generate(d) {
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt(d) }],
          temperature: 0,
          max_tokens: 1200,
          reasoning_effort: "low",
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) {
        const text = (await res.json()).choices?.[0]?.message?.content?.trim() ?? "";
        // 과부하가 200 안에 실려 오거나 본문 없이 끝나는 일이 있다.
        if (text.length >= 30) return text.replace(/\s*\n\s*/g, " ");
      }
    } catch {
      // 시간 초과나 연결 끊김. 아래에서 쉬었다 다시 한다.
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return null;
}

const existing = existsSync(OUT) ? JSON.parse(await readFile(OUT, "utf8")) : [];
const byId = new Map(existing.map((n) => [n.id, n]));
const todo = docs
  .filter((d) => byId.get(d.id)?.source !== fingerprint(d))
  .slice(0, LIMIT);
console.log(`조항 ${docs.length}개 중 만들 것 ${todo.length}개 (모델 ${MODEL})`);

let done = 0;
let failed = 0;
async function save() {
  // DOCS 순서대로, 지금 있는 조항 것만 남긴다.
  const notes = docs.filter((d) => byId.has(d.id)).map((d) => byId.get(d.id));
  await writeFile(OUT, JSON.stringify(notes, null, 2) + "\n");
}

const queue = [...todo];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let d = queue.shift(); d; d = queue.shift()) {
      const plain = await generate(d);
      if (plain) {
        byId.set(d.id, { id: d.id, source: fingerprint(d), plain });
        done++;
        await save();
      } else {
        failed++;
      }
      process.stderr.write(`\r${done + failed}/${todo.length} (실패 ${failed})`);
    }
  }),
);
process.stderr.write("\n");
console.log(`만듦 ${done}, 실패 ${failed}. 실패한 것은 다시 돌리면 이어서 만든다.`);
