import { test } from "node:test";
import assert from "node:assert/strict";
import { detectGenre, scriptInfo } from "../js/detect.js";
import { analyze, dialogueRanges } from "../js/analyzer.js";

// 시나리오 형식 예문 (이 저장소에서 새로 쓴 글)
const SCRIPT = `S#1. 장례식장 주차장 (실외) / 낮

흰 승합차가 주차장 맨 끝 칸에 선다. 문이 열린다.

해든\t대표님 먼저 들어가시고요. 삼 분 뒤에 동팔 씨.
동팔\t예.
치훈\t저 이번엔 대사 있어요?
해든\t없어요. 밥 드시는 분들 옆에 계시면 돼요.

S#2. 장례식장 화장실 / 낮

봉례가 세면대 거울 앞에서 입을 크게 벌렸다 다문다.

봉례\t목으로 하지 마. 배로 해.
치훈\t배요? 배가 어딘데요?
\t(낮게) 아이고오—
봉례\t알았다니까, 실장!`;

test("시나리오 형식(씬 머리, 이름[탭]대사)을 시나리오·대본으로 판단한다", () => {
  const info = scriptInfo(SCRIPT);
  assert.equal(info.isScript, true);
  assert.equal(info.scenes, 2);
  assert.equal(detectGenre(SCRIPT).genre, "screenplay");
});

test("대본의 대사 줄과 이어지는 줄은 대사로, 씬 머리는 서술 지표에서 뺀다", () => {
  const d = dialogueRanges(SCRIPT);
  assert.equal(d.lines.length, 8);
  assert.equal(d.headings.length, 2);
  const r = analyze(SCRIPT);
  assert.equal(r.metrics.sentences, 3); // 지문 문장만
});

test("대사 어색함: 직함만 부르는 호칭, 맞세운 짧은 명령, '밥 드시다'", () => {
  const r = analyze(SCRIPT);
  const ids = r.findings.map((f) => f.id);
  for (const id of ["L1", "L2", "L3"]) assert.ok(ids.includes(id), `${id} 누락: ${ids}`);
  const l3 = r.findings.find((f) => f.id === "L3");
  assert.equal(l3.spans[0].suggestion.after, "식사하시");
  // '강 실장', '실장님'은 잡지 않는다
  const ok = analyze(`S#1. 사무실\n\nS#2. 복도\n\n봉례\t알았다니까, 강 실장!\n해든\t실장님, 가요.`);
  assert.ok(!ok.findings.some((f) => f.id === "L1"));
});

test("'이름: 값' 몇 줄만 있는 설명문은 대본으로 보지 않는다", () => {
  const memo = "회의록\n날짜: 11월 3일\n장소: 3층 회의실\n참석: 기획팀 4명\n\n다음 분기 예산을 논의했습니다. 결론적으로 예산은 동결합니다.";
  assert.equal(scriptInfo(memo).isScript, false);
  assert.notEqual(detectGenre(memo).genre, "screenplay");
});
