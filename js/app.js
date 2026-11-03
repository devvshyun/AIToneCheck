import { analyze, compare, flattenSpans, applySuggestions, SEV } from "./analyzer.js";
import { GENRES, READ_ONLY } from "./rules.js";
import { detectGenre } from "./detect.js";
import { extractText, ACCEPT, FORMAT_LABEL, ExtractError } from "./extract.js";
import { SAMPLES } from "./samples.js";
import { buildPrompt } from "./prompt.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STORE = "aitonecheck:v1";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  file: null, // 마지막으로 올린 파일 이름
  result: null,
  spans: [],
  suggestions: [],
  applied: new Set(),
  open: null, // 펼친 메모의 finding id
  here: null, // 지금 고른 span
};

// ── 입력 ────────────────────────────────────────────────────
// 자동 판단 결과를 사람이 읽는 이름으로. 소설과 에세이가 비슷하면 둘 다 말한다.
function genreLabel(d) {
  const pair = new Set([d.genre, d.runnerUp]);
  if (d.confidence < 0.65 && pair.has("fiction") && pair.has("essay")) return "소설 또는 에세이";
  return GENRES[d.genre];
}

// 받침에 맞춰 '로/으로' (ㄹ 받침은 '로')
function ro(word) {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return "로";
  const jong = c % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
}

let detectTimer;
function liveDetect() {
  clearTimeout(detectTimer);
  detectTimer = setTimeout(() => {
    const t = $("#src").value;
    const el = $("#detect-live");
    if (t.replace(/\s/g, "").length < 40) { el.textContent = ""; return; }
    const d = detectGenre(t);
    el.innerHTML = `자동 판단 <b>${esc(genreLabel(d))}</b> <span>${esc(d.reasons.slice(0, 2).join(", "))}</span>`;
  }, 250);
}

function renderSamples() {
  $("#samples").insertAdjacentHTML("beforeend", SAMPLES.map((s) =>
    `<button type="button" class="u" data-s="${s.id}">${esc(s.label)}</button>`).join(""));
}

function updateCount() {
  const t = $("#src").value;
  $("#count").innerHTML = `${t.replace(/\s/g, "").length.toLocaleString()}<small>자</small>`;
  try { localStorage.setItem(STORE, JSON.stringify({ text: t })); } catch { /* 저장 불가 */ }
  liveDetect();
}

// ── 실행 ───────────────────────────────────────────────────
function run({ scroll = true } = {}) {
  const text = $("#src").value;
  if (!text.trim()) { toast("검사할 글을 먼저 넣어 주세요"); $("#src").focus(); return; }
  const r = analyze(text);
  state.result = r;
  state.spans = flattenSpans(r.findings);
  state.open = null;
  state.here = null;
  state.applied = new Set();
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

  $("#results").hidden = false;
  $("#second").hidden = true;
  renderVerdict(r);
  renderTop(r);
  renderMetrics(r);
  renderDoc();
  renderNotes();
  renderFixes();
  renderRevised();
  renderChecks();
  $("#prompt").textContent = buildPrompt(r);
  observe();
  if (scroll) $("#verdict-sec").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
}

// ── 02 판정 ────────────────────────────────────────────────
function renderVerdict(r) {
  const v = r.verdict;
  // 밀도를 0~1 눈금으로: 0~6 사람 쪽, 6~14 일부, 14~ 뚜렷
  const pos = v.per1k < 6 ? (v.per1k / 6) * 0.33 : v.per1k < 14 ? 0.33 + ((v.per1k - 6) / 8) * 0.33 : Math.min(1, 0.66 + ((v.per1k - 14) / 40) * 0.34);
  const words = { high: "AI 티가 <em>꽤</em> 보입니다", mid: "부분적으로 보입니다", low: "거의 사람 글입니다" };
  const el = $("#verdict");
  el.className = `verdict ${v.level}`;
  el.innerHTML = `
    <div data-reveal><span class="v-num">${v.per1k}</span><span class="v-unit">1,000자당 의심 표현 밀도</span></div>
    <p class="v-label" data-reveal style="--d:.1s"><span>${words[v.level]}</span></p>
    <div data-reveal style="--d:.18s">
      <div class="scale"><i style="left:0"></i></div>
      <div class="scale-labels"><span>적음</span><span>보통</span><span>많음</span></div>
      <p class="v-facts">${v.signals ? `의심 표현 ${v.signals}종류를 ${v.groups}개 분류에서 찾았습니다.` : "의심 표현을 찾지 못했습니다."} 글 종류는 <b>${esc(genreLabel(r.detected))}</b>${ro(genreLabel(r.detected))} 판단했습니다(${esc(r.detected.reasons.join(", "))}).</p>
    </div>`;
  requestAnimationFrame(() => setTimeout(() => { $(".scale i", el).style.left = `${(pos * 100).toFixed(1)}%`; }, 300));
}

function renderTop(r) {
  $("#top3").innerHTML = r.top.length
    ? r.top.map((t, i) => `<li data-reveal style="--d:${i * 0.07}s">
        <b><span class="id">${esc(t.id)}</span>${esc(t.name)}</b><span class="n">×${t.count}</span>
        <span class="fx">${esc(t.fix)}</span></li>`).join("")
    : `<li class="empty" data-reveal>반복되는 의심 표현이 없습니다. 07번 항목은 직접 읽으며 확인해 보세요.</li>`;
}

// ── 03 리듬 ────────────────────────────────────────────────
function renderMetrics(r) {
  const m = r.metrics;
  const pct = (x) => Math.round(x * 100);
  const stats = [
    { k: "서술 문장", v: m.sentences, u: "개", h: `대사 ${m.dialogueLines}줄은 따로` },
    { k: "평균 길이", v: m.meanLen.toFixed(1), u: "자", h: "너무 짧거나 길면 의심", warn: m.sentences >= 4 && (m.meanLen < 15 || m.meanLen > 60) },
    { k: "길이 변동", v: m.cv.toFixed(2), u: "CV", h: "낮을수록 리듬이 고름", warn: m.sentences >= 8 && m.cv < 0.3 },
    { k: "15자 이하", v: pct(m.shortRatio), u: "%", h: "높으면 끊어치기", warn: m.sentences >= 6 && m.shortRatio >= 0.35 },
    { k: "70자 이상", v: pct(m.longRatio), u: "%", h: "높으면 장황함", warn: m.longRatio >= 0.2 },
    { k: "한 줄 문단", v: m.oneLineParas, u: "개", h: "많으면 조각난 글", warn: m.oneLineParas >= 3 },
  ];
  $("#metrics").innerHTML = stats.map((s, i) => `<div class="stat${s.warn ? " warn" : ""}" data-reveal style="--d:${(i % 3) * 0.06}s">
    <span class="k">${s.k}</span><span class="v">${s.v}<small>${s.u}</small></span><span class="h">${s.h}</span></div>`).join("");

  const max = Math.max(1, ...m.connectives.map((c) => c.count));
  const hot = r.findings.some((f) => f.id === "H1");
  const topKey = [...m.connectives].sort((a, b) => b.count - a.count)[0].key;
  $("#connectives").innerHTML = `<p class="cap" data-reveal>이음말 분포 <span>하나가 다른 것의 2~3배를 넘으면 쏠림</span></p>` +
    m.connectives.map((c) => `<div class="conn-row${hot && c.key === topKey ? " hot" : ""}" data-reveal>
      <span>${esc(c.key)}</span><span class="cbar"><i data-w="${(c.count / max) * 100}"></i></span><span class="n">${c.count}</span></div>`).join("");
}

// ── 04 표시된 문장 ──────────────────────────────────────────────
function noteNo(id) { return state.result.findings.findIndex((f) => f.id === id) + 1; }

function renderDoc() {
  const { text } = state.result;
  let html = "";
  let pos = 0;
  state.spans.forEach((s, i) => {
    html += esc(text.slice(pos, s.start));
    const ids = [s.f, ...s.also].map((f) => f.id).join(" ");
    html += `<mark class="s${s.f.sev}" data-i="${i}" data-ids="${esc(ids)}" tabindex="0">${esc(text.slice(s.start, s.end))}</mark><sup>${noteNo(s.f.id)}</sup>`;
    pos = s.end;
  });
  html += esc(text.slice(pos));
  $("#doc").innerHTML = html;
}

function renderNotes() {
  const fs = state.result.findings;
  $("#note-count").textContent = fs.length ? `${fs.length}건` : "";
  $("#notes").innerHTML = fs.length ? fs.map((f, i) => `
    <li class="note s${f.sev}${state.open === f.id ? " open" : ""}" data-f="${esc(f.id)}">
      <button type="button" aria-expanded="${state.open === f.id}">
        <span class="no">${i + 1}</span>
        <span class="nm"><small>${esc(f.id)} · ${SEV[f.sev].key}${f.sev !== f.baseSev ? ` (빈도 ${f.count}회로 조정)` : ""}</small>${esc(f.name)}</span>
        <span class="ct">×${f.count}</span>
      </button>
      <div class="note-body"><div>${noteBody(f)}</div></div>
    </li>`).join("") : `<li class="empty">표시할 곳이 없습니다.</li>`;
}

function noteBody(f) {
  const s = state.here && (state.here.f.id === f.id || state.here.also.some((x) => x.id === f.id)) ? state.here : null;
  let here = "";
  if (s) {
    here = `<p><b>이 자리</b><span class="here">「${esc(s.text)}」</span></p>`;
    if (s.suggestion && s.f.id === f.id) here += `<p><b>고친 안 · ${esc(s.suggestion.kind)}</b></p>${baHtml(s.suggestion)}${toggleHtml(s.suggestion)}<p></p>`;
  }
  return `${here}<p><b>왜</b>${esc(f.why)}</p><p><b>처방</b>${esc(f.fix)}</p>`;
}

function baHtml(sg) { return `<div class="ba"><del>${esc(sg.before)}</del><ins>${esc(sg.after)}</ins></div>`; }
function toggleHtml(sg) {
  const key = `${sg.start}:${sg.end}`;
  const on = state.applied.has(key);
  return `<div class="toggle" data-k="${key}"><button type="button" data-v="1" aria-pressed="${on}">적용</button><button type="button" data-v="0" aria-pressed="${!on}">원문 유지</button></div>`;
}

function focusFinding(id, { scrollTo = false } = {}) {
  $$("#doc mark").forEach((m) => m.classList.toggle("dim", id !== null && !m.dataset.ids.split(" ").includes(id)));
  if (scrollTo && id) {
    const first = $$("#doc mark").find((m) => m.dataset.ids.split(" ").includes(id));
    if (first) {
      const box = $("#doc");
      box.scrollTo({ top: first.offsetTop - box.clientHeight / 3, behavior: reduced ? "auto" : "smooth" });
    }
  }
}

function openNote(id, span = null) {
  state.open = state.open === id && !span ? null : id;
  state.here = span;
  $$("#doc mark").forEach((m) => m.classList.toggle("on", span ? +m.dataset.i === state.spans.indexOf(span) : false));
  $$(".note").forEach((n) => {
    const on = n.dataset.f === state.open;
    n.classList.toggle("open", on);
    $("button", n).setAttribute("aria-expanded", String(on));
    if (n.dataset.f === id) $(".note-body > div", n).innerHTML = noteBody(state.result.findings.find((f) => f.id === id));
  });
  if (span) {
    const n = $(`.note[data-f="${CSS.escape(id)}"]`);
    const margin = $(".margin");
    if (n && margin.scrollHeight > margin.clientHeight) margin.scrollTo({ top: n.offsetTop - 60, behavior: reduced ? "auto" : "smooth" });
  }
}

// ── 05 고친 안 ─────────────────────────────────────────────
function renderFixes() {
  const box = $("#suggestions");
  box.innerHTML = state.suggestions.length ? state.suggestions.map((s, i) => `
    <li class="fix${state.applied.has(s.key) ? " applied" : ""}" data-reveal style="--d:${Math.min(i, 6) * 0.04}s">
      <span class="who"><b>${esc(s.finding.name)}</b>${esc(s.finding.id)} · ${esc(s.kind)}</span>
      ${baHtml(s)}
      ${toggleHtml(s)}
    </li>`).join("")
    : `<li class="empty" data-reveal>자동으로 고칠 수 있는 곳이 없습니다. 04번 항목의 처방을 보고 수정본 칸에서 직접 고치세요.</li>`;
}

function setApplied(key, on) {
  if (on) state.applied.add(key); else state.applied.delete(key);
  $$(`.toggle[data-k="${key}"] button`).forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.v === "1") === on)));
  $$(".fix").forEach((li) => li.classList.toggle("applied", state.applied.has($(".toggle", li)?.dataset.k)));
  renderRevised();
}

function bulk(on) {
  for (const s of state.suggestions) setApplied(s.key, on);
  if (!state.suggestions.length) renderRevised();
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
  $("#diff-before").innerHTML = html + esc(text.slice(pos));
}

// ── 06 다시 검수 ───────────────────────────────────────────
function recheck() {
  const revised = $("#revised").value;
  if (!revised.trim()) { toast("수정본이 비어 있습니다"); return; }
  const after = analyze(revised, state.result.genre); // 전후 비교는 같은 기준으로
  const c = compare(state.result, after);
  const alerts = [
    ...c.swaps.map((s) => `<div class="alert"><b>바꿔치기 의심</b>${esc(s.note)}<small>줄어든 신호 ${s.fromHit.join(", ")}, 늘어난 신호 ${s.toHit.join(", ")}</small></div>`),
    ...(c.fresh.length ? [`<div class="alert"><b>새로 생김</b>${c.fresh.map((r) => `${esc(r.id)} ${esc(r.name)} ${r.after}회`).join(", ")}</div>`] : []),
  ];
  if (!alerts.length) alerts.push(`<div class="alert ok"><b>이상 없음</b>알려진 바꿔치기 패턴은 보이지 않습니다.</div>`);
  const rows = c.rows.map((r) => {
    const d = r.after - r.before;
    return `<tr><td><small>${esc(r.id)}</small>${esc(r.name)}</td><td class="n">${r.before}</td><td class="n">${r.after}</td><td class="d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}</td></tr>`;
  }).join("");
  $("#second-body").innerHTML = `
    <div class="vs" data-reveal>
      <div class="side"><small>원문</small><b>${c.before.per1k}</b><span>${esc(c.before.label)}</span></div>
      <span class="arrow">→</span>
      <div class="side"><small>수정본</small><b>${c.after.per1k}</b><span>${esc(c.after.label)}</span></div>
    </div>
    <div class="alerts" data-reveal>${alerts.join("")}</div>
    ${rows ? `<table class="delta" data-reveal><tbody>${rows}</tbody></table>` : ""}
    <div class="actions" data-reveal><button class="btn" id="adopt" type="button"><span>수정본으로 다시 검사</span><i aria-hidden="true">↺</i></button></div>`;
  $("#second").hidden = false;
  $("#adopt").onclick = () => {
    $("#src").value = revised;
    updateCount();
    $("#manuscript").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
    run({ scroll: false });
  };
  observe();
  $("#second").scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
}

// ── 07 ─────────────────────────────────────────────────────
function renderChecks() {
  $("#readonly").innerHTML = READ_ONLY.map((r, i) => `<li data-reveal style="--d:${i * 0.04}s"><label>
    <input type="checkbox"><span><b><small>${esc(r.id)}</small>${esc(r.name)}</b><p>${esc(r.desc)}. ${esc(r.fix)}.</p></span></label></li>`).join("");
}

// ── 연출 ───────────────────────────────────────────────────
let io;
function observe() {
  if (reduced || !("IntersectionObserver" in window)) { $$("[data-reveal]").forEach((el) => el.classList.add("in")); fillBars(); return; }
  io ||= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add("in");
      $$(".cbar i", e.target).forEach((b) => { b.style.width = `${b.dataset.w}%`; });
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  $$("[data-reveal]:not(.in)").forEach((el) => io.observe(el));
}
function fillBars() { $$(".cbar i").forEach((b) => { b.style.width = `${b.dataset.w}%`; }); }

function parallax() {
  if (reduced) return;
  const word = $(".hero-title");
  if (!word) return;
  let ticking = false;
  addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scrollY;
      if (y < innerHeight * 1.2) word.style.transform = `translate3d(0, ${y * 0.18}px, 0)`;
      ticking = false;
    });
  }, { passive: true });
}

function cursor() {
  if (!matchMedia("(pointer: fine)").matches || reduced) return;
  const c = $(".cursor");
  let x = -100, y = -100, cx = x, cy = y;
  addEventListener("pointermove", (e) => {
    x = e.clientX; y = e.clientY;
    c.classList.add("on");
    const t = e.target;
    c.classList.toggle("text", !!t.closest("textarea"));
    c.classList.toggle("big", !t.closest("textarea") && !!t.closest("a, button, mark, label, summary"));
  }, { passive: true });
  document.addEventListener("pointerleave", () => c.classList.remove("on"));
  const loop = () => {
    cx += (x - cx) * 0.2; cy += (y - cy) * 0.2;
    c.style.transform = `translate3d(${cx}px, ${cy}px, 0)`;
    requestAnimationFrame(loop);
  };
  loop();
}

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
    try { document.execCommand("copy"); toast(done); } catch { toast("복사하지 못했습니다"); }
    ta.remove();
  }
}

// ── 파일 ───────────────────────────────────────────────────
const MAX_CHARS = 200000;

function setFileStatus(msg, isError = false) {
  const el = $("#file-status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

async function loadFile(file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { setFileStatus("50MB가 넘는 파일은 올릴 수 없습니다.", true); return; }
  setFileStatus(`${file.name} 읽는 중…`);
  try {
    let { text } = await extractText(file);
    let note = "";
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); note = ` 앞부분 ${MAX_CHARS.toLocaleString()}자만 검사합니다.`; }
    $("#src").value = text;
    updateCount();
    setFileStatus(`${file.name}에서 ${text.replace(/\s/g, "").length.toLocaleString()}자를 꺼냈습니다.${note}`);
    run();
  } catch (e) {
    setFileStatus(e instanceof ExtractError ? e.message : `${file.name}을 읽지 못했습니다. (${e.message})`, true);
  }
}

function bindFiles() {
  $("#file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  const drop = $("#drop");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; drop.classList.add("dragging"); });
  addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove("dragging"); });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    drop.classList.remove("dragging");
    loadFile(e.dataTransfer.files[0]);
  });
}

// ── 이벤트 ─────────────────────────────────────────────────
function bind() {
  $("#samples").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const s = SAMPLES.find((x) => x.id === b.dataset.s);
    $("#src").value = s.text;
    setFileStatus("");
    updateCount();
  });
  $("#src").addEventListener("input", updateCount);
  $("#src").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run(); });
  $("#run").addEventListener("click", () => run());
  $("#clear").addEventListener("click", () => { $("#src").value = ""; updateCount(); $("#results").hidden = true; $("#src").focus(); });

  const doc = $("#doc");
  const pickMark = (e) => {
    const m = e.target.closest("mark");
    if (!m) return;
    const s = state.spans[+m.dataset.i];
    openNote(s.f.id, s);
    focusFinding(s.f.id);
  };
  doc.addEventListener("click", pickMark);
  doc.addEventListener("keydown", (e) => { if (e.key === "Enter") pickMark(e); });
  doc.addEventListener("mouseover", (e) => { const m = e.target.closest("mark"); if (m && !state.open) focusFinding(m.dataset.ids.split(" ")[0]); });
  doc.addEventListener("mouseleave", () => { if (!state.open) focusFinding(null); });

  const notes = $("#notes");
  notes.addEventListener("click", (e) => {
    if (e.target.closest(".toggle")) return;
    const b = e.target.closest(".note > button");
    if (!b) return;
    const id = b.parentElement.dataset.f;
    openNote(id);
    focusFinding(state.open, { scrollTo: !!state.open });
  });
  notes.addEventListener("mouseover", (e) => { const n = e.target.closest(".note"); if (n && !state.open) focusFinding(n.dataset.f); });
  notes.addEventListener("mouseleave", () => { if (!state.open) focusFinding(null); });

  document.addEventListener("click", (e) => {
    const b = e.target.closest(".toggle button");
    if (!b) return;
    setApplied(b.parentElement.dataset.k, b.dataset.v === "1");
  });
  $("#all-apply").addEventListener("click", () => bulk(true));
  $("#all-keep").addEventListener("click", () => bulk(false));
  $("#recheck").addEventListener("click", recheck);
  $("#copy-revised").addEventListener("click", () => copy($("#revised").value, "수정본을 복사했습니다"));
  $("#copy-prompt").addEventListener("click", () => copy($("#prompt").textContent, "프롬프트를 복사했습니다"));
}

function init() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (saved?.text) $("#src").value = saved.text;
  } catch { /* 무시 */ }
  renderSamples();
  $("#file").accept = ACCEPT;
  $("#formats").textContent = `올릴 수 있는 파일: ${FORMAT_LABEL}`;
  bindFiles();
  updateCount();
  bind();
  observe();
  parallax();
  cursor();
  requestAnimationFrame(() => document.documentElement.classList.add("is-loaded"));
}

init();
