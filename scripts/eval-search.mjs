/**
 * 검색 성능 채점 스크립트
 *
 *   npm run dev        (다른 터미널에서 켜두고)
 *   node scripts/eval-search.mjs
 *   node scripts/eval-search.mjs https://baseball-rule.vercel.app   (배포본 채점)
 *
 * data/testset.json의 질문마다 정답 조항이 검색 결과 몇 등에 나오는지 재고,
 * 상위 N개(LLM에 넘기는 개수) 안에 들어왔는지 집계한다.
 * 검색 방식을 바꾼 뒤 이 점수가 올랐는지로 개선 여부를 판단한다.
 *
 * 결과는 results/search-<메모>-<시각>.json에 남는다. 두 번째 인자로 메모를
 * 붙이면 무엇을 바꾼 측정인지 파일 이름에 남는다.
 *
 *   node scripts/eval-search.mjs http://localhost:3000 기준선
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";

const BASE = process.argv[2] ?? "http://localhost:3000";
// 파일 이름에 남길 메모 (무엇을 바꾼 측정인지)
const NOTE = process.argv[3] ?? "측정";
// lib/llm.ts의 CONTEXT_LIMIT과 같은 값이어야 한다.
const CONTEXT_LIMIT = 8;

const testset = JSON.parse(
  await readFile(new URL("../data/testset.json", import.meta.url), "utf8"),
);

async function searchApi(message) {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).results ?? [];
}

let top1 = 0;
let inContext = 0;
let missing = 0;
const rows = [];

for (const { q, expect, level } of testset) {
  const results = await searchApi(q);
  const ranks = expect.map((id) => {
    const i = results.findIndex((r) => r.id === id);
    return i === -1 ? Infinity : i + 1;
  });
  const best = ranks.length ? Math.min(...ranks) : null;

  // 함정 문제: 정답 조항이 없는 게 정답이라 순위 채점에서 제외한다.
  if (best === null) {
    rows.push({ q, expect, level, rank: "-", status: "함정(정답 없음)" });
    continue;
  }

  if (best === 1) top1++;
  if (best <= CONTEXT_LIMIT) inContext++;
  if (best === Infinity) missing++;

  rows.push({
    q,
    level,
    rank: best === Infinity ? "없음" : best,
    status:
      best === 1
        ? "1등"
        : best <= CONTEXT_LIMIT
          ? `상위 ${CONTEXT_LIMIT}개 안`
          : best === Infinity
            ? "검색 실패"
            : "밀려남",
  });
}

const scored = testset.filter((t) => t.expect.length > 0).length;
const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - [...String(s)].length));

console.log(`대상: ${BASE}\n`);
console.log(pad("질문", 34), pad("난이도", 8), pad("순위", 6), "상태");
console.log("-".repeat(74));
for (const r of rows) {
  console.log(pad(r.q, 34), pad(r.level ?? "", 8), pad(r.rank, 6), r.status);
}
console.log("-".repeat(74));
console.log(`채점 대상            : ${scored}문제`);
console.log(`1등으로 찾음         : ${top1}/${scored} (${((top1 / scored) * 100).toFixed(0)}%)`);
console.log(`상위 ${CONTEXT_LIMIT}개 안에 들어옴   : ${inContext}/${scored} (${((inContext / scored) * 100).toFixed(0)}%)  <- LLM이 볼 수 있는 범위`);
console.log(`아예 못 찾음         : ${missing}/${scored}`);

// 조항을 몇 개까지 LLM에 넘길지 정할 때 쓰는 표.
const ranked = rows.filter((r) => r.rank !== "-").map((r) => (r.rank === "없음" ? Infinity : r.rank));
const recall = {};
console.log("\n상위 N개 안에 정답이 들어오는 비율");
for (const n of [5, 8, 12, 16, 20, 30]) {
  const hit = ranked.filter((r) => r <= n).length;
  recall[n] = hit;
  console.log(`  상위 ${String(n).padStart(2)}개: ${String(hit).padStart(2)}/${scored} (${((hit / scored) * 100).toFixed(0)}%)`);
}

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "");
const name = `search-${NOTE}-${stamp}.json`;
await mkdir(new URL("../results/", import.meta.url), { recursive: true });
await writeFile(
  new URL(`../results/${name}`, import.meta.url),
  JSON.stringify({ base: BASE, note: NOTE, contextLimit: CONTEXT_LIMIT, scored, top1, inContext, missing, recall, rows }, null, 2),
);
console.log(`\n결과 저장: results/${name}`);
