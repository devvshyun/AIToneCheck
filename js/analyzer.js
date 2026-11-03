// 신호 탐지 엔진. DOM 의존 없음 (브라우저·Node 공용).
//
// 판정 철학 (docs/ai-tone-essence.md 1장)
//  1. 수치는 읽을 자리를 고를 뿐, 판정은 읽어서 한다 → 결과는 '후보'와 '신호 밀도'로만 말한다
//  2. 지울지 고칠지는 사람이 정한다 → 고친 안은 제안만, 자동 치환 없음
//  3. 2차 검수까지가 한 번 → compare()로 버릇 바꿔치기 점검
//  4. 리듬 기준은 길이가 아니라 섞임 → CV, 15자↓·70자↑ 비율을 함께 본다

import { RULES, GROUPS, SWAPS, DELETE_SENTENCE } from "./rules.js";
import { detectGenre } from "./detect.js";

export const SEV = {
  1: { key: "S1", label: "강함" },
  2: { key: "S2", label: "중간" },
  3: { key: "S3", label: "약함" },
};
const WEIGHT = { 1: 3, 2: 2, 3: 1 };

const QUOTE_START = /^\s*["“「〈『'‘]/;
const CONNECTIVES = [
  { key: "는데", re: /[가-힣]?는데(?=[\s,.])/g },
  { key: "-고 (었·았·였고)", re: /[었았였]고(?=[\s,])/g },
  { key: "-서 (어·아·해·라서)", re: /[어아해라]서(?=[\s,])/g },
  { key: "더니", re: /더니(?=[\s,])/g },
  { key: "지만", re: /지만(?=[\s,])/g },
  { key: "다가", re: /[^에\s]다가(?=[\s,])/g }, // '~에다가'는 조사라서 뺀다
];
// 문장이 서술어로 끝나는지 (A2 명사 조각 판정용, 마지막 음절 기준 근사)
const PREDICATE_END = /[다요까죠네지군어아야니라자게걸데고며면서나래해대냐오소세마든고야지]$/;

// ── 기본 분해 ───────────────────────────────────────────────
export function splitSentences(text) {
  const out = [];
  const re = /[^.!?。\n]+(?:[.!?。…]+["'”’」)\]]*|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const t = raw.trim();
    if (!t || !/[가-힣A-Za-z0-9]/.test(t)) continue;
    const start = m.index + raw.indexOf(t);
    out.push({ text: t, start, end: start + t.length });
  }
  return out;
}

function lineRanges(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    out.push({ start: pos, end: pos + line.length, text: line });
    pos += line.length + 1;
  }
  return out;
}

function paragraphs(text) {
  const out = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

// 대사 범위: 따옴표로 시작하는 줄 전체 + 서술 줄 안의 인용 구간
export function dialogueRanges(text) {
  const lines = [];
  const inline = [];
  for (const l of lineRanges(text)) {
    if (QUOTE_START.test(l.text)) lines.push(l);
    else {
      const re = /“[^”\n]*”|"[^"\n]*"|「[^」\n]*」/g;
      let m;
      while ((m = re.exec(l.text)) !== null) inline.push({ start: l.start + m.index, end: l.start + m.index + m[0].length });
    }
  }
  return { lines, inline };
}

const inside = (pos, ranges) => ranges.some((r) => pos >= r.start && pos < r.end);

// ── 수치 지표 (서술 문단만, 2장) ─────────────────────────────
export function computeMetrics(text, dlg = dialogueRanges(text)) {
  const all = splitSentences(text);
  const narr = all.filter((s) => !inside(s.start, dlg.lines));
  const lens = narr.map((s) => s.text.length);
  const n = narr.length;
  const mean = n ? lens.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;

  const paras = paragraphs(text).filter((p) => !QUOTE_START.test(p.text));
  const oneLine = paras.filter((p) => p.text.trim().length <= 20 && (p.text.match(/[.!?。]/g) || []).length === 1);

  const narrText = narr.map((s) => s.text).join(" ");
  const connectives = CONNECTIVES.map((c) => ({ key: c.key, count: (narrText.match(c.re) || []).length }));

  return {
    narr, all,
    sentences: n,
    dialogueLines: dlg.lines.length,
    chars: text.replace(/\s/g, "").length,
    meanLen: mean,
    cv: mean ? sd / mean : 0,
    shortRatio: n ? lens.filter((l) => l <= 15).length / n : 0,
    longRatio: n ? lens.filter((l) => l >= 70).length / n : 0,
    oneLineParas: oneLine.length,
    connectives,
  };
}

// 등급 빈도 가중 (4장): 단일 1회는 한 단계 낮추고, 많이 나오면 올린다
export function effectiveSev(base, count) {
  if (count >= 10) return 1;
  if (base === 3 && count >= 6) return 2;
  if (base === 2 && count >= 8) return 1;
  if (count === 1 && base < 3) return base + 1;
  return base;
}

// ── 메인 ───────────────────────────────────────────────────
// genre를 생략하거나 "auto"면 글을 보고 장르를 판단한다
export function analyze(input, genre = "auto") {
  const text = input.normalize("NFC").replace(/\r\n?/g, "\n");
  const detected = detectGenre(text);
  if (!genre || genre === "auto") genre = detected.genre;
  const dlg = dialogueRanges(text);
  const dialogueAll = [...dlg.lines, ...dlg.inline];
  const metrics = computeMetrics(text, dlg);
  const sentences = metrics.all;
  const findings = [];

  for (const rule of RULES) {
    if (rule.genres && !rule.genres.includes(genre)) continue;
    const scope = rule.scope || "narration";
    const spans = [];
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (!m[0].length) { rule.re.lastIndex++; continue; }
      // (?<pre>...) 그룹은 lookbehind 대용으로 잡은 앞 글자라 하이라이트에서 뺀다
      const preLen = m.groups?.pre?.length || 0;
      const lead = m[0].slice(preLen).search(/[^\s.,!?\n]/);
      const start = m.index + preLen + Math.max(0, lead);
      const end = m.index + m[0].length;
      if (scope === "narration" && inside(start, dialogueAll)) continue;
      if (scope === "dialogue" && !inside(start, dlg.lines)) continue;
      if (rule.accept && !rule.accept(text.slice(start, end))) continue;
      spans.push(withSuggestion(rule, { start, end, text: text.slice(start, end) }, sentences, text));
    }
    if (spans.length >= (rule.min || 1)) findings.push(finding(rule, spans));
  }

  findings.push(...metricFindings(text, metrics, genre));

  for (const f of findings) f.sev = effectiveSev(f.baseSev, f.count);
  findings.sort((a, b) => a.sev - b.sev || b.count - a.count);

  const verdict = verdictOf(findings, metrics);
  return { text, genre, detected, findings, metrics, verdict, top: topHabits(findings) };
}

function finding(rule, spans, extra = {}) {
  return {
    id: rule.id, name: rule.name, group: rule.group, groupLabel: GROUPS[rule.group]?.label || "",
    baseSev: rule.sev, why: rule.why, fix: rule.fix, spans, count: spans.length, ...extra,
  };
}

function withSuggestion(rule, span, sentences, text) {
  if (!rule.suggest) return span;
  const out = rule.suggest(span.text);
  if (out === null || out === undefined) return span;
  if (out === DELETE_SENTENCE) {
    const s = sentences.find((x) => span.start >= x.start && span.start < x.end);
    if (!s) return span;
    // 뒤따르는 공백까지 함께 지운다
    let end = s.end;
    while (end < text.length && text[end] === " ") end++;
    return { ...span, suggestion: { start: s.start, end, before: text.slice(s.start, end), after: "", kind: "문장 삭제" } };
  }
  // 대체: 지우는 경우 뒤 공백 하나도 정리
  let end = span.end;
  if (out === "" && text[end] === " " && (span.start === 0 || /\s/.test(text[span.start - 1]))) end++;
  return { ...span, suggestion: { start: span.start, end, before: text.slice(span.start, end), after: out, kind: out === "" ? "삭제" : "바꾸기" } };
}

function metricFindings(text, m, genre) {
  const out = [];
  const story = genre !== "nonfiction";
  const S = (s) => ({ start: s.start, end: s.end, text: s.text });

  // A1 단문 끊어치기: 15자 이하 문장이 3개 이상 이어진 구간
  if (story && m.sentences >= 6 && m.shortRatio >= 0.35) {
    const spans = [];
    let run = [];
    const flush = () => { if (run.length >= 3) spans.push(...run.map(S)); run = []; };
    for (const s of m.narr) {
      const prev = run[run.length - 1];
      const contiguous = !prev || !/\n\s*\n/.test(text.slice(prev.end, s.start));
      if (s.text.length <= 15 && contiguous) run.push(s);
      else { flush(); if (s.text.length <= 15) run.push(s); }
    }
    flush();
    if (spans.length) out.push(finding({
      id: "A1", group: "A", sev: 2, name: "단문 끊어치기",
      why: `서술 문장의 ${pct(m.shortRatio)}가 15자 이하입니다. 마침표가 박자를 만드는 '도왔다. 일찍 갔다. 다 도왔다.' 리듬.`,
      fix: "연결어미로 잇고, 끊는 건 시선을 멈출 한 자리만",
    }, spans));
  }

  // A2 명사 조각
  if (story) {
    const frags = m.narr.filter((s) => s.text.length <= 20 && /[.。]$/.test(s.text) &&
      !PREDICATE_END.test(s.text.replace(/[.。"'”’」)\]\s]+$/u, "")));
    if (frags.length >= 3) out.push(finding({
      id: "A2", group: "A", sev: 3, name: "명사 조각",
      why: "'열아홉의 그 애.'처럼 서술어 없이 끝나는 짧은 문장이 여러 번 나옵니다.",
      fix: "앞 문장 안에 넣는다. 화면 글자·메시지 인용은 예외",
    }, frags.map(S)));
  }

  // G1 긴 문장
  const longs = m.narr.filter((s) => s.text.length >= 70);
  if (longs.length >= 2 && (genre !== "nonfiction" || m.longRatio >= 0.3)) out.push(finding({
    id: "G1", group: "G", sev: 2, name: "긴 문장 (70자 이상)",
    why: `70자 넘는 서술 문장이 ${longs.length}개(${pct(m.longRatio)}). 끊어치기를 고치다 반대로 넘어간 판에서 잘 생깁니다.`,
    fix: "자연스러운 이음매에서 한 번 자른다",
  }, longs.map(S)));

  // R1 길이 고름 (1장 원칙 4)
  if (m.sentences >= 8 && m.cv < 0.3) out.push(finding({
    id: "R1", group: "G", sev: 2, name: "문장 길이가 고름",
    why: `길이 변동계수 ${m.cv.toFixed(2)}. 짧은 문장과 긴 문장이 섞이지 않아 기계적인 리듬이 납니다.`,
    fix: "짧게만 또는 길게만 쓰지 말고, 문단 안에서 길이를 섞는다",
  }, [], { count: 1, metric: true }));

  // H1 이음말 쏠림
  const sorted = [...m.connectives].sort((a, b) => b.count - a.count);
  const [top, second] = sorted;
  if (top.count >= 5 && top.count >= 2.5 * Math.max(1, second.count)) {
    const c = CONNECTIVES.find((x) => x.key === top.key);
    const spans = [];
    for (const s of m.narr) {
      c.re.lastIndex = 0;
      let mm;
      while ((mm = c.re.exec(s.text)) !== null) {
        const st = s.start + mm.index;
        spans.push({ start: st, end: st + mm[0].length, text: mm[0] });
      }
    }
    out.push(finding({
      id: "H1", group: "H", sev: 2, name: `이음말 쏠림 '${top.key}'`,
      why: `'${top.key}'가 ${top.count}회로 두 번째(${second.key} ${second.count}회)의 ${(top.count / Math.max(1, second.count)).toFixed(1)}배입니다.`,
      fix: "같은 이음말을 다른 연결(는데·더니·지만·다가)이나 문장 분리로 섞는다",
    }, spans));
  }
  return out;
}

const pct = (x) => `${Math.round(x * 100)}%`;

// ── 판정 (신호 밀도로 말한다, 6장 1) ─────────────────────────
export function verdictOf(findings, m) {
  const load = findings.reduce((a, f) => a + WEIGHT[f.sev] * Math.sqrt(f.count), 0);
  const per1k = load / Math.max(0.3, m.chars / 1000);
  const groups = new Set(findings.map((f) => f.group)).size;
  let level = per1k >= 14 ? "high" : per1k >= 6 ? "mid" : "low";
  if (level === "high" && groups < 2) level = "mid"; // 한 가지 버릇만이면 개인 습관일 수 있다
  if (findings.every((f) => f.sev === 3)) level = "low"; // 약한 신호만으로는 판정을 올리지 않는다
  const label = { high: "AI 티가 꽤 보입니다", mid: "부분적으로 AI 티가 보입니다", low: "거의 사람 글입니다" }[level];
  return { level, label, per1k: +per1k.toFixed(1), signals: findings.length, groups };
}

// 가장 많이 나온 버릇 3개 (6장 5)
export function topHabits(findings) {
  return [...findings]
    .sort((a, b) => WEIGHT[b.sev] * Math.sqrt(b.count) - WEIGHT[a.sev] * Math.sqrt(a.count))
    .slice(0, 3)
    .map((f) => ({ id: f.id, name: f.name, count: f.count, fix: f.fix, sev: f.sev }));
}

// ── 2차 검수 (5장) ──────────────────────────────────────────
export function compare(before, after) {
  const count = (r) => Object.fromEntries(r.findings.map((f) => [f.id, f]));
  const b = count(before), a = count(after);
  const ids = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const rows = ids.map((id) => ({
    id, name: (a[id] || b[id]).name,
    before: b[id]?.count || 0, after: a[id]?.count || 0,
  })).sort((x, y) => (y.after - y.before) - (x.after - x.before));
  const dec = new Set(rows.filter((r) => r.after < r.before).map((r) => r.id));
  const inc = new Set(rows.filter((r) => r.after > r.before).map((r) => r.id));
  const swaps = SWAPS.filter((s) => s.from.some((id) => dec.has(id)) && s.to.some((id) => inc.has(id)))
    .map((s) => ({ ...s, fromHit: s.from.filter((id) => dec.has(id)), toHit: s.to.filter((id) => inc.has(id)) }));
  const fresh = rows.filter((r) => r.before === 0 && r.after > 0);
  return { rows, swaps, fresh, before: before.verdict, after: after.verdict };
}

// 하이라이트용: 겹치는 span은 강한 신호 우선
export function flattenSpans(findings) {
  const all = [];
  for (const f of findings) for (const s of f.spans) all.push({ ...s, f });
  all.sort((x, y) => x.start - y.start || x.f.sev - y.f.sev || (y.end - y.start) - (x.end - x.start));
  const out = [];
  let lastEnd = -1;
  for (const s of all) {
    if (s.start >= lastEnd) { out.push({ ...s, also: [] }); lastEnd = s.end; }
    else if (out.length && s.start < out[out.length - 1].end) out[out.length - 1].also.push(s.f);
  }
  return out;
}

// 선택한 고친 안을 원문에 적용 (뒤에서부터, 겹치면 앞선 것 우선)
export function applySuggestions(text, suggestions) {
  const list = [...suggestions].sort((a, b) => a.start - b.start);
  const kept = [];
  let lastEnd = -1;
  for (const s of list) if (s.start >= lastEnd) { kept.push(s); lastEnd = s.end; }
  let out = text;
  for (const s of kept.reverse()) out = out.slice(0, s.start) + s.after + out.slice(s.end);
  return out.replace(/ {2,}/g, " ").replace(/ +\n/g, "\n");
}
