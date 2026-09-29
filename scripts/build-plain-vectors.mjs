/**
 * data/plain.json의 사람 말 설명을 뜻 벡터로 바꿔 data/plain-vectors.json에 저장한다.
 *
 *   node scripts/build-plain-vectors.mjs
 *
 * plain.json을 고칠 때마다 다시 돌린다. 설명은 몇 개뿐이라 몇 초면 끝난다.
 * 조항 전체 벡터(build-vectors.mjs)를 다시 만들 필요는 없다.
 *
 * 설명 원문을 벡터와 같이 저장한다. lib/search.ts가 plain.json과 비교해,
 * 설명만 고치고 이 스크립트를 안 돌렸으면 바로 알려준다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MODEL = process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b";
// build-vectors.mjs와 같게 둔다. 조항 벡터와 같은 눈금이어야 비교가 된다.
const PRECISION = 4;

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch {
  // 이미 환경변수로 넣어뒀다면 파일이 없어도 된다.
}
if (!process.env.NVIDIA_API_KEY) {
  console.error("NVIDIA_API_KEY가 없습니다. .env.local을 확인하세요.");
  process.exit(1);
}

const plain = JSON.parse(
  await readFile(new URL("../data/plain.json", import.meta.url), "utf8"),
);

const res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: MODEL,
    input: plain.map((p) => p.plain),
    // 조항과 같은 쪽(문서)으로 만든다. 질문은 검색할 때 "query"로 만든다.
    input_type: "passage",
    encoding_format: "float",
  }),
});
if (!res.ok) {
  console.error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  process.exit(1);
}
const vectors = (await res.json()).data.map((d) => d.embedding);

// 길이를 1로 맞춰두면 검색할 때 코사인 유사도가 그냥 내적이 된다.
function toUnit(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((v) => Number((v / norm).toFixed(PRECISION)));
}

await writeFile(
  new URL("../data/plain-vectors.json", import.meta.url),
  JSON.stringify({
    model: MODEL,
    items: plain.map((p, i) => ({ id: p.id, plain: p.plain, vector: toUnit(vectors[i]) })),
  }),
);
console.log(`설명 ${plain.length}개 -> data/plain-vectors.json`);
