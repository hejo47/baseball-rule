/**
 * 조항 전체를 형태소로 잘라 data/tokens.json에 저장한다.
 *
 *   node scripts/build-tokens.mjs
 *
 * 글자 점수(BM25)는 조항을 형태소로 잘라 둬야 계산할 수 있다. oktjs로 457개를
 * 자르는 데 10초 넘게 걸려서, 서버가 뜰 때마다 하지 않고 미리 해 둔다.
 * 서버는 질문만 그때그때 자른다.
 *
 * 규칙집(rules.json, league.json)이나 사람 말 설명(plain.json)을 고쳤으면 다시
 * 돌린다. 안 돌리면 lib/search.ts가 지문이 다르다며 에러를 낸다.
 *
 * 자르는 규칙은 lib/tokenizer.ts를 그대로 불러 쓴다(Node 24가 TypeScript를 직접 읽는다).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fieldsFingerprint, lexicalFields, tokenize, TOKENIZER } from "../lib/tokenizer.ts";

const read = async (path) =>
  JSON.parse(await readFile(new URL(`../data/${path}`, import.meta.url), "utf8"));

// lib/search.ts의 DOCS와 같은 순서.
const docs = [...(await read("rules.json")), ...(await read("league.json"))];
const plain = new Map((await read("plain.json")).map((n) => [n.id, n.plain]));
const fields = docs.map((d) => lexicalFields(d, plain.get(d.id)));

const started = Date.now();
const title = [];
const body = [];
for (const [i, f] of fields.entries()) {
  title.push(tokenize(f.title));
  body.push(tokenize(f.body));
  if (i % 50 === 0) process.stderr.write(`\r${i}/${fields.length}`);
}
process.stderr.write(`\r${fields.length}/${fields.length}\n`);

await writeFile(
  new URL("../data/tokens.json", import.meta.url),
  JSON.stringify({
    tokenizer: TOKENIZER,
    fingerprint: fieldsFingerprint(fields),
    ids: docs.map((d) => d.id),
    title,
    body,
  }),
);
console.log(
  `조항 ${docs.length}개 -> data/tokens.json (${TOKENIZER}, ${((Date.now() - started) / 1000).toFixed(1)}초)`,
);
