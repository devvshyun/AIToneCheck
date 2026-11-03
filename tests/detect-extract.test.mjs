import { test } from "node:test";
import assert from "node:assert/strict";
import { detectGenre } from "../js/detect.js";
import { analyze } from "../js/analyzer.js";
import { hwpSectionText, decodeText } from "../js/extract.js";
import { SAMPLES } from "../js/samples.js";

const sample = (id) => SAMPLES.find((s) => s.id === id).text;

test("장르 자동 판단: 대사 많은 소설, 습니다체 칼럼, 회상 에세이, 보고서", () => {
  assert.equal(detectGenre(sample("ai-fiction")).genre, "fiction");
  assert.equal(detectGenre(sample("ai-column")).genre, "nonfiction");
  const essay = "어릴 적 우리 집 마당에는 감나무가 한 그루 있었다. 나는 가을마다 그 나무 아래에서 떨어진 감을 주웠다. 요즘 시장에서 감을 보면 그 마당이 생각난다. 이제 그 집은 없다.";
  assert.equal(detectGenre(essay).genre, "essay");
  const report = "# 3분기 매출 분석\n\n- 매출은 전년 대비 12% 늘었다.\n- 영업이익률은 8.4%로 하락했다.\n\n원가 상승이 주원인이다. 따라서 4분기에는 가격 정책을 조정해야 한다.";
  assert.equal(detectGenre(report).genre, "nonfiction");
});

test("analyze는 장르를 주지 않으면 자동 판단 결과를 쓴다", () => {
  const r = analyze(sample("ai-column"));
  assert.equal(r.genre, "nonfiction");
  assert.ok(r.detected.reasons.length > 0);
});

// HWP 5.0 레코드: 헤더(tag | level<<10 | size<<20) + UTF-16LE 본문
function record(tag, payload) {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, tag | (payload.length << 20), true);
  return [...head, ...payload];
}
const utf16 = (s) => [...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]);
const ctrl = (code, wchars = 1) => [code, 0, ...new Array((wchars - 1) * 2).fill(0)];

test("HWP 본문 레코드에서 문단 텍스트를 꺼내고 제어 문자를 건너뛴다", () => {
  const para1 = [...utf16("그게 다였다."), ...ctrl(13)];
  // 표 개체(확장 제어 11, 8 WCHAR)와 탭(인라인 9, 8 WCHAR)이 섞인 문단
  const para2 = [...ctrl(11, 8), ...utf16("한참"), ...ctrl(9, 8), ...utf16("봤다."), ...ctrl(13)];
  const bytes = new Uint8Array([
    ...record(66, [0, 0, 0, 0]),   // PARA_HEADER (무시)
    ...record(67, para1),
    ...record(68, [1, 2, 3]),      // PARA_CHAR_SHAPE (무시)
    ...record(67, para2),
  ]);
  assert.equal(hwpSectionText(bytes), "그게 다였다.\n한참\t봤다.");
});

test("텍스트 파일 인코딩: UTF-8, UTF-16LE BOM, EUC-KR", () => {
  const s = "그게 다였다.";
  assert.equal(decodeText(new TextEncoder().encode(s)), s);
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, ...utf16(s)])), s);
  // '그게' EUC-KR 바이트
  assert.equal(decodeText(new Uint8Array([0xb1, 0xd7, 0xb0, 0xd4])), "그게");
});
