import { analyze, compare, flattenSpans, applySuggestions, SEV } from "./analyzer.js";
import { GENRES, READ_ONLY } from "./rules.js";
import { SAMPLES } from "./samples.js";
import { buildPrompt } from "./prompt.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STORE = "aitonecheck:v1";

const state = {
  genre: "fiction",
  result: null,
  spans: [],          // flatten 결과
  suggestions: [],    // {key, finding, ...suggestion}
  applied: new Set(), // 적용할 suggestion key
  selected: null,     // finding id
};

// ── 입력부 ───────────────────────────────────────────────────
function renderGenre() {
  const box = $("#genre");
  box.innerHTML = Object.entries(GENRES).map(([k, v]) =>
    `<button type="button" role="radio" data-g="${k}" aria-checked="${k === state.genre}">${v}</button>`).join("");
  box.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state.genre = b.dataset.g;
    renderGenre();
    if (state.result) run();
  };
}

function renderSamples() {
  const box = $("#samples");
  box.insertAdjacentHTML("beforeend", SAMPLES.map((s) =>
    `<button type="button" class="ghost" data-s="${s.id}">${esc(s.label)}</button>`).join(""));
  box.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = SAMPLES.find((x) => x.id === b.dataset.s);
    $("#src").value = s.text;
    state.genre = s.genre;
    renderGenre();
    updateCount();
    run();
  };
}

function updateCount() {
  const t = $("#src").value;
  $("#count").textContent = `${t.replace(/\s/g, "").length.toLocaleString()}자 (공백 제외)`;
  try { localStorage.setItem(STORE, JSON.stringify({ text: t, genre: state.genre })); } catch { /* 저장 불가 환경 */ }
}

// ── 실행 ───────────────────────────────────────────────────
function run() {
  const text = $("#src").value;
  if (!text.trim()) { toast("검사할 글을 넣어 주세요"); return; }
  const r = analyze(text, state.genre);
  state.result = r;
  state.spans = flattenSpans(r.findings);
  state.selected = null;
  state.suggestions = [];
  const seen = new Set();
  for (const f of r.findings) for (const s of f.spans) {
    if (!s.suggestion) continue;
    const key = `${s.suggestion.start}:${s.suggestion.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.suggestions.push({ key, finding: f, ...s.suggestion });
  }
  state.suggestions.sort((a, b) => a.start - b.start);
  state.applied = new Set();

  $("#results").hidden = false;
  $("#second").hidden = true;
  renderVerdict(r);
  renderTop(r);
  renderMetrics(r);
  renderDoc();
  renderDetail(null);
  renderSignals(r);
  renderSuggestions();
  renderRevised();
  renderReadOnly();
  $("#prompt").textContent = buildPrompt(r);
  $("#verdict").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── 1. 판정 ─────────────────────────────────────────────────
function renderVerdict(r) {
  const v = r.verdict;
  const el = $("#verdict");
  el.className = `card verdict ${v.level}`;
  const badge = { high: "AI 티<br>많음", mid: "일부", low: "사람<br>쪽" }[v.level];
  el.innerHTML = `
    <div class="badge">${badge}</div>
    <div class="label">${v.label}</div>
    <div class="facts">신호 ${v.signals}종 · ${v.groups}개 계열 · 1,000자당 신호 밀도 ${v.per1k} · ${GENRES[r.genre]} 기준.
      판결이 아니라 후보가 얼마나 몰려 있는지 말하는 값입니다.</div>`;
}

function renderTop(r) {
  $("#top3").innerHTML = r.top.length
    ? r.top.map((t) => `<li><span class="pill s${t.sev}">${SEV[t.sev].key}</span><b>${esc(t.id)} ${esc(t.name)}</b> ${t.count}회<br><span class="fix">→ ${esc(t.fix)}</span></li>`).join("")
    : `<li class="empty">반복·밀집된 버릇이 잡히지 않았습니다. 아래 '읽어서 확인할 항목'은 직접 살펴보세요.</li>`;
}

// ── 2. 수치 ─────────────────────────────────────────────────
function renderMetrics(r) {
  const m = r.metrics;
  const pct = (x) => `${Math.round(x * 100)}%`;
  const cards = [
    { k: "서술 문장 수", v: m.sentences, h: `대사 줄 ${m.dialogueLines}개는 따로 셈` },
    { k: "평균 문장 길이", v: `${m.meanLen.toFixed(1)}자`, h: "극단이면 의심", warn: m.sentences >= 4 && (m.meanLen < 15 || m.meanLen > 60) },
    { k: "길이 변동 CV", v: m.cv.toFixed(2), h: "낮을수록 리듬이 고름", warn: m.sentences >= 8 && m.cv < 0.3 },
    { k: "15자 이하 비율", v: pct(m.shortRatio), h: "높으면 끊어치기(A1)", warn: m.sentences >= 6 && m.shortRatio >= 0.35 },
    { k: "70자 이상 비율", v: pct(m.longRatio), h: "높으면 장황함(G1)", warn: m.longRatio >= 0.2 },
    { k: "한 줄 문단", v: m.oneLineParas, h: "많으면 조각·끊어치기", warn: m.oneLineParas >= 3 },
  ];
  $("#metrics").innerHTML = cards.map((c) =>
    `<div class="metric${c.warn ? " warn" : ""}"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="h">${c.warn ? "주의 · " : ""}${c.h}</div></div>`).join("");

  const max = Math.max(1, ...m.connectives.map((c) => c.count));
  const hot = r.findings.some((f) => f.id === "H1");
  const topKey = [...m.connectives].sort((a, b) => b.count - a.count)[0].key;
  $("#connectives").innerHTML = `<h3>이음말 분포 <span class="muted small">하나가 다른 것의 2~3배를 넘으면 쏠림(H1)</span></h3>` +
    m.connectives.map((c) => `<div class="conn${hot && c.key === topKey ? " hot" : ""}"><span>${esc(c.key)}</span><span class="bar"><i style="width:${(c.count / max) * 100}%"></i></span><span class="n">${c.count}</span></div>`).join("");
}

// ── 3. 하이라이트 ───────────────────────────────────────────
function renderDoc() {
  const { text } = state.result;
  let html = "";
  let pos = 0;
  state.spans.forEach((s, i) => {
    html += esc(text.slice(pos, s.start));
    const title = [s.f, ...s.also].map((f) => `${f.id} ${f.name}`).join(" / ");
    html += `<mark class="s${s.f.sev}" data-i="${i}" data-f="${esc(s.f.id)}" tabindex="0" title="${esc(title)}">${esc(text.slice(s.start, s.end))}</mark>`;
    pos = s.end;
  });
  html += esc(text.slice(pos));
  const doc = $("#doc");
  doc.innerHTML = html || '<span class="muted">(빈 글)</span>';
  const pick = (e) => {
    const mk = e.target.closest("mark");
    if (!mk) return;
    const s = state.spans[+mk.dataset.i];
    selectFinding(s.f.id, s);
  };
  doc.onclick = pick;
  doc.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e); } };
}

function selectFinding(id, span = null) {
  state.selected = id;
  document.querySelectorAll("#doc mark").forEach((m) => {
    const s = state.spans[+m.dataset.i];
    const match = s.f.id === id || s.also.some((f) => f.id === id);
    m.classList.toggle("dim", !match);
    m.classList.toggle("active", span ? +m.dataset.i === state.spans.indexOf(span) : false);
  });
  document.querySelectorAll(".sig").forEach((el) => el.classList.toggle("active", el.dataset.f === id));
  const f = state.result.findings.find((x) => x.id === id);
  renderDetail(f, span);
}

function renderDetail(f, span = null) {
  const el = $("#detail");
  if (!f) {
    el.innerHTML = `<p class="muted">하이라이트나 아래 신호 목록에서 항목을 고르세요.</p>`;
    document.querySelectorAll("#doc mark").forEach((m) => m.classList.remove("dim", "active"));
    return;
  }
  const sugg = span?.suggestion;
  const others = span?.also?.length ? `<dt>같은 자리의 다른 신호</dt><dd>${span.also.map((x) => `${esc(x.id)} ${esc(x.name)}`).join(", ")}</dd>` : "";
  const sample = span ? "" : f.spans.length
    ? `<dt>나온 곳 (${f.count}회)</dt><dd>${f.spans.slice(0, 6).map((s) => `「${esc(s.text.length > 40 ? s.text.slice(0, 40) + "…" : s.text)}」`).join(" ")}</dd>`
    : "";
  let ba = "";
  if (sugg) {
    const key = `${sugg.start}:${sugg.end}`;
    const on = state.applied.has(key);
    ba = `<dt>고친 안 (${esc(sugg.kind)})</dt><dd><div class="ba"><span class="b">${esc(sugg.before)}</span><span class="a">${esc(sugg.after)}</span></div>
      <div class="toggle" style="margin-top:8px" data-k="${key}"><button type="button" data-v="1" aria-pressed="${on}">적용</button><button type="button" data-v="0" aria-pressed="${!on}">원문 유지</button></div></dd>`;
  }
  el.innerHTML = `
    <div><span class="pill s${f.sev}">${SEV[f.sev].key}</span><span class="id">${esc(f.id)} ${esc(f.name)}</span></div>
    <div class="muted small">${esc(f.groupLabel)}${f.sev !== f.baseSev ? ` · 기본 ${SEV[f.baseSev].key}, 빈도 ${f.count}회로 조정` : ""}</div>
    <dl>
      ${span ? `<dt>이 자리</dt><dd>「${esc(span.text)}」</dd>` : ""}
      <dt>왜 AI 같은가</dt><dd>${esc(f.why)}</dd>
      <dt>처방</dt><dd>${esc(f.fix)}</dd>
      ${ba}${sample}${others}
    </dl>`;
  el.querySelector(".toggle")?.addEventListener("click", onToggle);
}

// ── 신호 목록 ──────────────────────────────────────────────
function renderSignals(r) {
  const box = $("#signals");
  if (!r.findings.length) { box.innerHTML = `<p class="empty">잡힌 신호가 없습니다.</p>`; return; }
  box.innerHTML = [1, 2, 3].map((sev) => {
    const list = r.findings.filter((f) => f.sev === sev);
    if (!list.length) return "";
    return `<div class="sig-group"><h3><span class="pill s${sev}">${SEV[sev].key}</span>${SEV[sev].label}</h3>` +
      list.map((f) => `<div class="sig" data-f="${esc(f.id)}" tabindex="0" role="button">
        <span class="t">${esc(f.id)} ${esc(f.name)}</span><span class="c">${f.count}회</span>
        <span class="w">${esc(f.why)}</span></div>`).join("") + "</div>";
  }).join("");
  const pick = (e) => {
    const el = e.target.closest(".sig");
    if (!el) return;
    selectFinding(el.dataset.f);
    $("#doc").querySelector(`mark[data-f="${CSS.escape(el.dataset.f)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  box.onclick = pick;
  box.onkeydown = (e) => { if (e.key === "Enter") pick(e); };
}

// ── 4. 고친 안 ─────────────────────────────────────────────
function renderSuggestions() {
  const box = $("#suggestions");
  if (!state.suggestions.length) {
    box.innerHTML = `<p class="empty">기계적으로 바꿀 수 있는 후보가 없습니다. 신호 목록의 처방을 보고 수정본 칸에서 직접 고치세요.</p>`;
    return;
  }
  box.innerHTML = state.suggestions.map((s) => {
    const on = state.applied.has(s.key);
    return `<div class="sugg">
      <div><div class="meta"><span class="pill s${s.finding.sev}">${SEV[s.finding.sev].key}</span>${esc(s.finding.id)} ${esc(s.finding.name)} · ${esc(s.kind)}</div>
        <div class="ba"><span class="b">${esc(s.before)}</span><span class="a">${esc(s.after)}</span></div></div>
      <div class="toggle" data-k="${s.key}"><button type="button" data-v="1" aria-pressed="${on}">적용</button><button type="button" data-v="0" aria-pressed="${!on}">원문 유지</button></div>
    </div>`;
  }).join("");
  box.onclick = onToggle;
}

function onToggle(e) {
  const b = e.target.closest(".toggle button");
  if (!b) return;
  const key = b.parentElement.dataset.k;
  if (b.dataset.v === "1") state.applied.add(key); else state.applied.delete(key);
  document.querySelectorAll(`.toggle[data-k="${key}"] button`).forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === (b.dataset.v))));
  renderRevised();
}

function bulk(apply) {
  state.applied = apply ? new Set(state.suggestions.map((s) => s.key)) : new Set();
  renderSuggestions();
  if (state.selected) {
    const f = state.result.findings.find((x) => x.id === state.selected);
    renderDetail(f);
  }
  renderRevised();
}

function renderRevised() {
  const { text } = state.result;
  const chosen = state.suggestions.filter((s) => state.applied.has(s.key));
  $("#revised").value = applySuggestions(text, chosen);
  let html = "";
  let pos = 0;
  let lastEnd = -1;
  for (const s of chosen) {
    if (s.start < lastEnd) continue;
    html += esc(text.slice(pos, s.start)) + `<del>${esc(s.before)}</del>` + (s.after ? `<ins>${esc(s.after)}</ins>` : "");
    pos = s.end;
    lastEnd = s.end;
  }
  html += esc(text.slice(pos));
  $("#diff-before").innerHTML = html;
}

// ── 5. 2차 검수 ─────────────────────────────────────────────
function recheck() {
  const revised = $("#revised").value;
  if (!revised.trim()) { toast("수정본이 비어 있습니다"); return; }
  const after = analyze(revised, state.genre);
  const c = compare(state.result, after);
  const box = $("#second-body");
  const vs = `<div class="vs"><b>전</b> ${esc(c.before.label)} (밀도 ${c.before.per1k}) <span class="muted">→</span> <b>후</b> ${esc(c.after.label)} (밀도 ${c.after.per1k})</div>`;
  const swaps = c.swaps.length
    ? c.swaps.map((s) => `<div class="alert"><b>버릇 바꿔치기 의심</b> · ${esc(s.note)} <span class="muted small">(줄어든 것: ${s.fromHit.join(", ")} / 늘어난 것: ${s.toHit.join(", ")})</span></div>`).join("")
    : `<div class="good">알려진 버릇 바꿔치기 패턴은 보이지 않습니다.</div>`;
  const fresh = c.fresh.length
    ? `<div class="alert"><b>새로 생긴 신호</b> · ${c.fresh.map((r) => `${esc(r.id)} ${esc(r.name)} ${r.after}회`).join(", ")}</div>` : "";
  const rows = c.rows.length ? `<table><thead><tr><th>신호</th><th class="num">전</th><th class="num">후</th><th class="num">변화</th></tr></thead><tbody>` +
    c.rows.map((r) => {
      const d = r.after - r.before;
      return `<tr><td>${esc(r.id)} ${esc(r.name)}</td><td class="num">${r.before}</td><td class="num">${r.after}</td><td class="num ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}</td></tr>`;
    }).join("") + "</tbody></table>" : `<p class="empty">전후 모두 신호가 없습니다.</p>`;
  box.innerHTML = vs + swaps + fresh + rows +
    `<div class="row end gap"><button class="primary" id="adopt" type="button">수정본을 입력창으로 옮겨 다시 진단</button></div>`;
  $("#second").hidden = false;
  $("#adopt").onclick = () => { $("#src").value = revised; updateCount(); run(); };
  $("#second").scrollIntoView({ behavior: "smooth", block: "start" });
}

// ── 읽기 체크리스트 ─────────────────────────────────────────
function renderReadOnly() {
  $("#readonly").innerHTML = READ_ONLY.map((r, i) => `<li><input type="checkbox" id="ro${i}"><label for="ro${i}"><b>${esc(r.id)} ${esc(r.name)}</b>${r.sev === 1 ? ' <span class="pill s1">S1</span>' : ""}<div class="d">${esc(r.desc)} → ${esc(r.fix)}</div></label></li>`).join("");
}

// ── 유틸 ───────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast(done); } catch { toast("복사하지 못했습니다. 직접 선택해 복사하세요"); }
    ta.remove();
  }
}

// ── 초기화 ─────────────────────────────────────────────────
function init() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved?.text) { $("#src").value = saved.text; state.genre = GENRES[saved.genre] ? saved.genre : "fiction"; }
  } catch { /* 무시 */ }
  renderGenre();
  renderSamples();
  updateCount();
  $("#src").addEventListener("input", updateCount);
  $("#src").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
  $("#run").onclick = run;
  $("#clear").onclick = () => { $("#src").value = ""; updateCount(); $("#results").hidden = true; $("#src").focus(); };
  $("#all-apply").onclick = () => bulk(true);
  $("#all-keep").onclick = () => bulk(false);
  $("#recheck").onclick = recheck;
  $("#copy-revised").onclick = () => copy($("#revised").value, "수정본을 복사했습니다");
  $("#copy-prompt").onclick = () => copy($("#prompt").textContent, "프롬프트를 복사했습니다");
}

init();
