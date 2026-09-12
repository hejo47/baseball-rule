/**
 * 규칙집 조각들을 뜻 벡터로 바꿔 data/vectors.json에 저장한다.
 *
 *   node scripts/build-vectors.mjs
 *
 * 규칙집(data/rules.json)이 바뀌었을 때만 다시 돌리면 된다.
 * 결과 파일은 저장소에 커밋한다. 규칙집은 1년에 한 번 바뀌는 데이터라
 * 배포 때마다 251번씩 API를 다시 탈 이유가 없고, 그때 무료 API가 죽어 있으면
 * 배포 자체가 실패하기 때문이다.
 *
 * 글자만 보는 검색은 "낫아웃"과 "제3스트라이크"처럼 뜻은 같은데 글자가 안 겹치는
 * 말을 영원히 못 찾는다. 그 구멍을 메우려고 뜻 벡터를 같이 쓴다.
 * 자세한 배경은 docs/search.md 참고.
 */
import { readFile, writeFile } from "node:fs/promises";

const MODEL = process.env.NVIDIA_EMBED_MODEL ?? "nvidia/nemotron-3-embed-1b";
// 한 번에 너무 많이 보내면 무료 API가 거부한다.
const BATCH = 16;
// 조각 하나가 최대 4,248자인데 임베딩 모델은 입력 길이에 한도가 있다.
// 앞부분만 넣는다. 조항의 핵심은 보통 앞에 나온다.
const MAX_CHARS = 1200;
// 소수점 이하 자릿수. 코사인 유사도에는 4자리면 충분하고,
// 그대로 저장하면 파일이 6.5MB가 되는데 4자리로 줄이면 절반 이하가 된다.
const PRECISION = 4;

try {
  process.loadEnvFile(new URL("../.env.local", import.meta.url).pathname);
} catch {
  // 이미 환경변수로 넣어뒀다면 파일이 없어도 된다.
}
if (!process.env.NVIDIA_API_KEY) {
  console.error("NVIDIA_API_KEY가 없습니다. .env.local을 확인하세요.");
  process.exit(1);
}

// lib/search.ts의 DOCS와 같은 순서여야 한다. 어긋나면 조항과 벡터가
// 엇갈려 엉뚱한 점수가 나온다. (search.ts가 개수를 확인해 막고 있다)
const docs = [
  ...JSON.parse(await readFile(new URL("../data/rules.json", import.meta.url), "utf8")),
  ...JSON.parse(await readFile(new URL("../data/league.json", import.meta.url), "utf8")),
];

/** 무료 API가 간헐적으로 502를 낸다. 몇 번 쉬었다 다시 걸어본다. */
async function embed(input, inputType, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        input_type: inputType,
        encoding_format: "float",
      }),
    });
    if (res.ok) return (await res.json()).data.map((d) => d.embedding);

    const body = (await res.text()).slice(0, 200);
    if (attempt >= tries) throw new Error(`${res.status} ${body}`);
    console.error(`\n  ${res.status} — ${attempt}번째 재시도`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

// 미리 길이를 1로 맞춰두면 검색할 때 코사인 유사도가 그냥 내적이 된다.
// 나눗셈과 제곱근이 사라져 질문마다 하는 계산이 줄어든다.
function toUnit(vector) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((v) => Number((v / norm).toFixed(PRECISION)));
}

const vectors = [];
for (let i = 0; i < docs.length; i += BATCH) {
  const chunk = docs.slice(i, i + BATCH);
  const batch = await embed(
    chunk.map((d) => `${d.title}\n${d.text}`.slice(0, MAX_CHARS)),
    "passage",
  );
  vectors.push(...batch.map(toUnit));
  process.stderr.write(`\r${Math.min(i + BATCH, docs.length)}/${docs.length}`);
}
process.stderr.write("\n");

const out = new URL("../data/vectors.json", import.meta.url);
await writeFile(
  out,
  JSON.stringify({
    model: MODEL,
    dim: vectors[0].length,
    maxChars: MAX_CHARS,
    // rules.json과 같은 순서. 검색할 때 순서로 맞춰 쓴다.
    ids: docs.map((d) => d.id),
    vectors,
  }),
);

const { size } = await import("node:fs/promises").then((fs) => fs.stat(out));
console.log(
  `조각 ${vectors.length}개 · ${vectors[0].length}차원 · ${(size / 1024 / 1024).toFixed(1)}MB -> data/vectors.json`,
);
