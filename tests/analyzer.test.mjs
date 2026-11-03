import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, compare, applySuggestions, effectiveSev, dialogueRanges } from "../js/analyzer.js";
import { SAMPLES } from "../js/samples.js";

const ids = (r) => r.findings.map((f) => f.id);
const sample = (id) => SAMPLES.find((s) => s.id === id);

test("AI 티 나는 소설 예문은 '꽤 보입니다'로 판정되고 핵심 신호를 잡는다", () => {
  const s = sample("ai-fiction");
  const r = analyze(s.text, s.genre);
  assert.equal(r.verdict.level, "high");
  for (const id of ["A1", "A3", "A4", "A8", "F1", "B1"]) assert.ok(ids(r).includes(id), `${id} 누락: ${ids(r)}`);
  assert.equal(r.top.length, 3);
});

test("사람 쪽 소설 예문은 '거의 사람 글'로 판정된다", () => {
  const s = sample("human-fiction");
  const r = analyze(s.text, s.genre);
  assert.equal(r.verdict.level, "low");
  assert.ok(r.findings.every((f) => f.sev === 3));
});

test("AI 티 나는 칼럼은 설명문 관용구와 번역투를 잡는다", () => {
  const s = sample("ai-column");
  const r = analyze(s.text, s.genre);
  assert.equal(r.verdict.level, "high");
  for (const id of ["K1", "K8", "T1", "K10"]) assert.ok(ids(r).includes(id), `${id} 누락`);
  // 칼럼 장르에서는 소설 전용 신호를 돌리지 않는다
  assert.ok(!ids(r).includes("A1"));
});

test("단일 1회 출현은 한 단계 낮춰 표시하고, 많이 나오면 올린다", () => {
  assert.equal(effectiveSev(1, 1), 2);
  assert.equal(effectiveSev(2, 1), 3);
  assert.equal(effectiveSev(3, 1), 3);
  assert.equal(effectiveSev(3, 10), 1);
  assert.equal(effectiveSev(2, 8), 1);
});

test("대사 줄은 서술 지표와 서술 신호에서 빠진다", () => {
  const text = `"그게 다였다."\n그는 문을 닫았다.`;
  const d = dialogueRanges(text);
  assert.equal(d.lines.length, 1);
  const r = analyze(text, "fiction");
  assert.ok(!ids(r).includes("A4"), "대사 안의 '그게 다였다'를 서술 결산으로 잡으면 안 된다");
  assert.equal(r.metrics.sentences, 1);
});

test("고친 안: 이중 피동 바꾸기, 결산 문장 삭제", () => {
  const r1 = analyze("이 문제는 곧 해결되어질 것이다. 판단되어진다.", "nonfiction");
  const t1 = r1.findings.find((f) => f.id === "T1");
  assert.equal(t1.spans[0].suggestion.after, "될");
  const out1 = applySuggestions(r1.text, t1.spans.map((s) => s.suggestion));
  assert.equal(out1, "이 문제는 곧 해결될 것이다. 판단된다.");

  const r2 = analyze("그는 버스에 올랐다. 그게 다였다.", "fiction");
  const a4 = r2.findings.find((f) => f.id === "A4");
  assert.equal(a4.spans[0].suggestion.kind, "문장 삭제");
  assert.equal(applySuggestions(r2.text, [a4.spans[0].suggestion]).trim(), "그는 버스에 올랐다.");
});

test("2차 검수: 해설을 지우고 '한참'이 늘면 버릇 바꿔치기로 짚는다", () => {
  const before = analyze(
    "그녀가 웃었다. 그것은 미안하다는 뜻이었다. 그는 고개를 끄덕였다. 그건 알겠다는 뜻이었다. 비가 그쳤다.", "fiction");
  const after = analyze(
    "그녀가 웃었다. 나는 한참 그 얼굴을 봤다. 그는 고개를 끄덕였다. 한참을 그대로 서 있었다. 비가 그쳤다.", "fiction");
  const c = compare(before, after);
  assert.ok(c.swaps.some((s) => s.to.includes("A8")), JSON.stringify(c.swaps));
});

test("연결어미 쉼표는 숫자 천 단위 쉼표와 구분한다", () => {
  const r = analyze("1,200명이 왔고, 3,400명이 갔으며, 5,600명이 남았지만, 아무도 몰랐다.", "nonfiction");
  const t8 = r.findings.find((f) => f.id === "T8");
  assert.equal(t8.count, 3);
});
