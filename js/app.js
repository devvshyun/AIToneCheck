// 작업 화면: 왼쪽 편집기(밑줄 표시) + 오른쪽 결과 패널(요약·항목·변화·더 보기)
// 글은 편집기에 한 번만 보이고, 고친 안은 편집기 글을 직접 바꾼다(Ctrl+Z로 되돌림).

import { analyze, compare, flattenSpans, SEV } from "./analyzer.js";
import { GENRES, READ_ONLY } from "./rules.js";
import { extractText, ACCEPT, ExtractError } from "./extract.js";
import { SAMPLES } from "./samples.js";
import { buildPrompt } from "./prompt.js";
import { diffWords } from "./diff.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const STORE = "aitonecheck:v2";
const MAX_CHARS = 200000;
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const narrow = () => matchMedia("(max-width: 900px)").matches;

const ta = $("#src");
const backdrop = $("#backdrop");
const scroller = $("#scroller");

const state = {
  result: null,
  spans: [],
  baseline: null,   // 처음 글의 검사 결과. 변화 탭이 이것과 비교한다
  focus: null,      // 펼친 항목(finding id)
  active: -1,       // 고른 밑줄(spans 인덱스)
  tab: "summary",
  diff: false,
  diffMode: null,   // "split"(나란히) | "inline"(한 줄)
};

// ── 공통 ───────────────────────────────────────────────────
function genreLabel(d) {
  const pair = new Set([d.genre, d.runnerUp]);
  if (d.confidence < 0.65 && pair.has("fiction") && pair.has("essay")) return "소설 또는 에세이";
  return GENRES[d.genre];
}
function ro(word) {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  if (c < 0 || c > 11171) return "로";
  const j = c % 28;
  return j === 0 || j === 8 ? "로" : "으로";
}
const chars = (t) => t.replace(/\s/g, "").length;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}
function setStatus(html, isError = false) {
  const el = $("#status");
  el.innerHTML = html;
  el.classList.toggle("error", isError);
}

// ── 글 넣기·검사 ───────────────────────────────────────────
function setText(text, { baseline = true } = {}) {
  ta.value = text.normalize("NFC").replace(/\r\n?/g, "\n");
  state.baseline = null;
  state.diff = false;
  scroller.scrollTop = 0;
  run({ baseline });
}

let timer;
function onInput() {
  renderPlain();
  clearTimeout(timer);
  timer = setTimeout(() => run(), ta.value.length > 30000 ? 600 : 250);
}

function run({ baseline = false } = {}) {
  // 분석은 정규화된 글 기준이라, 위치가 어긋나지 않게 편집기 값도 맞춘다
  const norm = ta.value.normalize("NFC").replace(/\r\n?/g, "\n");
  if (norm !== ta.value) {
    const pos = ta.selectionStart;
    ta.value = norm;
    ta.setSelectionRange(pos, pos);
  }
  const text = ta.value;
  save(text);
  $("#count").textContent = text ? `${chars(text).toLocaleString()}자` : "";
  $("#empty").hidden = !!text;

  if (!text.trim()) {
    state.result = null;
    state.spans = [];
    state.baseline = null;
    renderPlain();
    renderPanel();
    setStatus("");
    return;
  }
  const r = analyze(text);
  state.result = r;
  state.spans = flattenSpans(r.findings);
  if (!state.focus || !r.findings.some((f) => f.id === state.focus)) state.focus = null;
  state.active = -1;
  if (baseline || !state.baseline) state.baseline = r;
  renderMarks();
  renderPanel();
  if (state.diff) renderDiff();
  const d = r.detected;
  setStatus(`<b>${esc(genreLabel(d))}</b>${ro(genreLabel(d))} 판단 · ${esc(d.reasons.slice(0, 2).join(", "))}`);
}

function save(text) {
  try { localStorage.setItem(STORE, JSON.stringify({ text, base: state.baseline?.text || "" })); } catch { /* 저장 불가 */ }
}

// ── 편집기 밑줄 ────────────────────────────────────────────
// textarea 뒤에 같은 글을 투명하게 깔고, 밑줄과 배경만 보이게 한다.
// 마지막 줄바꿈이 높이에 반영되도록 끝에 공백 하나를 붙인다.
function renderPlain() {
  backdrop.textContent = ta.value + "\n ";
  backdrop.classList.remove("focus");
}

function renderMarks() {
  const text = ta.value;
  let html = "";
  let pos = 0;
  state.spans.forEach((s, i) => {
    html += esc(text.slice(pos, s.start));
    const ids = [s.f.id, ...s.also.map((f) => f.id)].join(" ");
    html += `<mark class="s${s.f.sev}" data-i="${i}" data-ids="${esc(ids)}">${esc(text.slice(s.start, s.end))}</mark>`;
    pos = s.end;
  });
  backdrop.innerHTML = html + esc(text.slice(pos)) + "\n ";
  paintFocus();
}

function paintFocus() {
  const id = state.focus;
  backdrop.classList.toggle("focus", !!id);
  $$("mark", backdrop).forEach((m) => {
    m.classList.toggle("match", !!id && m.dataset.ids.split(" ").includes(id));
    m.classList.toggle("on", +m.dataset.i === state.active);
  });
}

function scrollToSpan(i) {
  const m = $(`mark[data-i="${i}"]`, backdrop);
  if (!m) return;
  const top = m.offsetTop - scroller.clientHeight / 3;
  scroller.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
}

// 편집기를 누른 자리에 밑줄이 있으면 그 항목을 연다
function pickFromCaret() {
  if (!state.result || ta.selectionStart !== ta.selectionEnd) return;
  const pos = ta.selectionStart;
  const i = state.spans.findIndex((s) => pos >= s.start && pos <= s.end);
  if (i < 0) return;
  state.active = i;
  state.focus = state.spans[i].f.id;
  paintFocus();
  setTab("items");
  renderItems();
  const li = $(`.occ li[data-i="${i}"]`);
  li?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
}

function selectSpan(i) {
  const s = state.spans[i];
  if (!s) return;
  if (state.diff) toggleDiff(false);
  state.active = i;
  paintFocus();
  $$(".occ li").forEach((li) => li.classList.toggle("on", +li.dataset.i === i));
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(s.start, s.end);
  scrollToSpan(i);
  if (narrow()) openSheet(false);
}

// ── 고친 안 적용 ───────────────────────────────────────────
// execCommand를 쓰면 브라우저 실행 취소(Ctrl+Z)에 기록된다. 안 되는 브라우저는 setRangeText로.
function applyEdits(edits) {
  if (!edits.length) return;
  const list = [...edits].sort((a, b) => b.start - a.start);
  let lastStart = Infinity;
  ta.focus({ preventScroll: true });
  const keep = scroller.scrollTop;
  let done = 0;
  for (const e of list) {
    if (e.end > lastStart) continue; // 겹치는 제안은 건너뛴다
    ta.setSelectionRange(e.start, e.end);
    const ok = e.after ? document.execCommand("insertText", false, e.after) : document.execCommand("delete");
    if (!ok) ta.setRangeText(e.after, e.start, e.end, "end");
    lastStart = e.start;
    done++;
  }
  scroller.scrollTop = keep;
  clearTimeout(timer);
  run();
  toast(done > 1 ? `${done}곳을 고쳤습니다. Ctrl+Z로 되돌릴 수 있습니다` : "고쳤습니다. Ctrl+Z로 되돌릴 수 있습니다");
  return done;
}

// 글 전체에서 바로 고칠 수 있는 제안 (같은 자리는 한 번만)
function allSuggestions() {
  if (!state.result) return [];
  const seen = new Map();
  for (const f of state.result.findings) for (const s of f.spans) {
    if (!s.suggestion) continue;
    const k = `${s.suggestion.start}:${s.suggestion.end}`;
    if (!seen.has(k)) seen.set(k, s.suggestion);
  }
  return [...seen.values()];
}

function fixBar({ sticky = false } = {}) {
  const n = allSuggestions().length;
  const changed = state.result && state.baseline && state.baseline.text !== state.result.text;
  if (!n && !changed) return "";
  return `<div class="fixbar${sticky ? " sticky" : ""}">
    <span>${n ? `바로 고칠 수 있는 곳 <b>${n}</b>곳` : "바로 고칠 수 있는 곳이 없습니다"}</span>
    <span class="fixbar-actions">
      ${changed ? `<button class="sbtn line" type="button" data-act="diff">${state.diff ? "편집으로" : "처음 글과 비교"}</button>` : ""}
      ${n ? `<button class="sbtn" type="button" data-act="apply-all">모두 적용</button>` : ""}
    </span></div>`;
}

// ── 패널 ───────────────────────────────────────────────────
function setTab(tab) {
  if (state.tab !== tab) $("#panel-body").scrollTop = 0;
  state.tab = tab;
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $$(".tab").forEach((t) => { t.hidden = t.id !== `tab-${tab}`; });
  if (tab === "more") renderMore();
}

function renderPanel() {
  const r = state.result;
  $("#items-count").textContent = r && r.findings.length ? r.findings.length : "";
  const changed = r && state.baseline && state.baseline.text !== r.text;
  $("#changes-dot").hidden = !changed;
  const cb = $("#compare-btn");
  cb.hidden = !r;
  cb.disabled = !changed && !state.diff;
  cb.title = cb.disabled ? "글을 고치면 처음 글과 비교할 수 있습니다" : "";
  renderSummary();
  renderItems();
  renderChanges();
  if (state.tab === "more") renderMore();
  renderHandle();
}

function renderHandle() {
  const r = state.result;
  const el = $("#handle-text");
  if (!r) { el.textContent = "글을 넣으면 결과가 여기에 나옵니다"; return; }
  const v = r.verdict;
  el.innerHTML = `${v.per1k} · ${v.level === "high" ? "AI 티가 <em>꽤</em> 보입니다" : esc(v.label)}<small>항목 ${r.findings.length}</small>`;
}

function renderSummary() {
  const box = $("#tab-summary");
  const r = state.result;
  if (!r) {
    box.innerHTML = `
      <p class="h">이 도구가 하는 일</p>
      <p class="note">한국어 글에서 AI가 쓴 것처럼 읽히는 표현을 찾아 밑줄을 긋고, 이유와 고칠 방향을 알려 줍니다. AI 작성 여부를 판별하지는 않습니다.</p>
      <p class="h">찾는 표현 예</p>
      <p class="note">"그게 다였다" 같은 결산 문장, 짧은 문장만 이어 쓰기, '한참'·'문득' 같은 상투어, "~되어지다" 같은 번역투, "결론적으로·따라서" 반복</p>
      <p class="h">개인정보</p>
      <p class="note">글과 파일은 이 브라우저 안에서만 처리되고 서버로 전송되지 않습니다.</p>`;
    return;
  }
  const v = r.verdict;
  const m = r.metrics;
  const pos = v.per1k < 6 ? (v.per1k / 6) * 0.33 : v.per1k < 14 ? 0.33 + ((v.per1k - 6) / 8) * 0.33 : Math.min(1, 0.66 + ((v.per1k - 14) / 40) * 0.34);
  const label = { high: "AI 티가 <em>꽤</em> 보입니다", mid: "부분적으로 보입니다", low: "거의 사람 글입니다" }[v.level];
  const pct = (x) => Math.round(x * 100);
  const stats = [
    { k: "서술 문장", v: m.sentences, u: "개", h: `대사 ${m.dialogueLines}줄 제외` },
    { k: "평균 길이", v: m.meanLen.toFixed(1), u: "자", warn: m.sentences >= 4 && (m.meanLen < 15 || m.meanLen > 60) },
    { k: "길이 변동", v: m.cv.toFixed(2), u: "", h: "낮으면 고름", warn: m.sentences >= 8 && m.cv < 0.3 },
    { k: "15자 이하", v: pct(m.shortRatio), u: "%", h: "끊어치기", warn: m.sentences >= 6 && m.shortRatio >= 0.35 },
    { k: "70자 이상", v: pct(m.longRatio), u: "%", h: "장황함", warn: m.longRatio >= 0.2 },
    { k: "한 줄 문단", v: m.oneLineParas, u: "개", warn: m.oneLineParas >= 3 },
  ];
  const max = Math.max(1, ...m.connectives.map((c) => c.count));
  const hot = r.findings.some((f) => f.id === "H1");
  const topKey = [...m.connectives].sort((a, b) => b.count - a.count)[0].key;

  box.innerHTML = `
    <div class="verdict-num">${v.per1k}<small>1,000자당 의심 표현 밀도</small></div>
    <p class="verdict-label">${label}</p>
    <div class="scale"><i style="left:${(pos * 100).toFixed(1)}%"></i></div>
    <div class="scale-labels"><span>적음</span><span>보통</span><span>많음</span></div>
    <p class="genre">글 종류 <b>${esc(genreLabel(r.detected))}</b> · ${esc(r.detected.reasons.join(", "))}</p>

    ${fixBar()}
    <p class="h">많이 나온 항목</p>
    ${r.top.length ? `<ol class="top3">${r.top.map((t) => `<li><button type="button" data-f="${esc(t.id)}">
      <b><span class="sevdot s${t.sev}"></span>${esc(t.name)}</b><span class="n">×${t.count}</span>
      <span class="fx">${esc(t.fix)}</span></button></li>`).join("")}</ol>`
      : `<p class="empty-tab">반복되는 의심 표현이 없습니다. "더 보기"의 확인 목록은 직접 읽으며 살펴보세요.</p>`}

    <p class="h">문장 리듬 <span class="muted">· 대사를 뺀 서술 문장 기준, 참고용</span></p>
    <div class="stats">${stats.map((s) => `<div class="stat${s.warn ? " warn" : ""}"><span class="k">${s.k}</span><span class="v">${s.v}<small>${s.u}</small></span>${s.h ? `<span class="hint">${s.h}</span>` : ""}</div>`).join("")}</div>
    <div class="conn">${m.connectives.map((c) => `<div class="conn-row${hot && c.key === topKey ? " hot" : ""}"><span>${esc(c.key)}</span><span class="bar"><i style="width:${(c.count / max) * 100}%"></i></span><span class="n">${c.count}</span></div>`).join("")}</div>`;
}

function snippet(text, s) {
  const a = Math.max(0, s.start - 14);
  const b = Math.min(text.length, s.end + 14);
  const pre = text.slice(a, s.start).replace(/\s+/g, " ");
  const post = text.slice(s.end, b).replace(/\s+/g, " ");
  return `${a > 0 ? "…" : ""}${esc(pre)}<mark>${esc(text.slice(s.start, s.end))}</mark>${esc(post)}${b < text.length ? "…" : ""}`;
}

function renderItems() {
  const box = $("#tab-items");
  const r = state.result;
  if (!r) { box.innerHTML = `<p class="empty-tab">글을 넣으면 찾은 표현이 여기에 나옵니다.</p>`; return; }
  if (!r.findings.length) { box.innerHTML = `<p class="empty-tab">찾은 의심 표현이 없습니다.</p>`; return; }
  const spanIndex = new Map(state.spans.map((s, i) => [`${s.start}:${s.end}`, i]));
  const html = [1, 2, 3].map((sev) => {
    const list = r.findings.filter((f) => f.sev === sev);
    if (!list.length) return "";
    return `<p class="group-h"><span class="sevdot s${sev}"></span>${SEV[sev].label} (${SEV[sev].key})</p>` + list.map((f) => {
      const open = state.focus === f.id;
      const occ = f.spans.slice(0, 40).map((s) => {
        const i = spanIndex.get(`${s.start}:${s.end}`) ?? state.spans.findIndex((x) => x.start <= s.start && x.end >= s.end);
        const sg = s.suggestion;
        const fix = sg ? `<div class="fix"><del>${esc(sg.before.trim())}</del><span class="arrow">→</span><ins>${esc(sg.after)}</ins>
          <button class="sbtn" type="button" data-apply="${sg.start}:${sg.end}" data-f="${esc(f.id)}">적용</button></div>` : "";
        return `<li data-i="${i}" class="${i === state.active ? "on" : ""}"><button class="snip" type="button" data-go="${i}">${snippet(r.text, s)}</button>${fix}</li>`;
      }).join("");
      const more = f.spans.length > 40 ? `<p class="muted">외 ${f.spans.length - 40}곳</p>` : "";
      const fixable = f.spans.filter((s) => s.suggestion);
      return `<div class="item${open ? " open" : ""}" data-f="${esc(f.id)}">
        <button class="item-head" type="button" aria-expanded="${open}"><span><b>${esc(f.name)}</b><small>${esc(f.id)}${f.sev !== f.baseSev ? ` · 빈도 ${f.count}회로 조정` : ""}</small></span><span class="n">×${f.count}</span></button>
        <div class="item-body">
          <p><b>왜</b>${esc(f.why)}</p>
          <p><b>처방</b>${esc(f.fix)}</p>
          ${f.spans.length ? `<ul class="occ">${occ}</ul>${more}` : ""}
          ${fixable.length > 1 ? `<div class="item-actions"><button class="sbtn line" type="button" data-apply-all="${esc(f.id)}">이 항목 ${fixable.length}곳 모두 적용</button></div>` : ""}
        </div></div>`;
    }).join("");
  }).join("");
  box.innerHTML = fixBar({ sticky: true }) + html;
}

function renderChanges() {
  const box = $("#tab-changes");
  const r = state.result;
  const base = state.baseline;
  if (!r || !base || base.text === r.text) {
    box.innerHTML = `<p class="empty-tab">글을 고치면 처음 글과 비교해 여기에 보여 줍니다. 표현 하나를 지우면 다른 상투 표현이 그 자리에 들어가기 쉬워서, 고친 뒤 늘어난 항목을 따로 짚습니다.</p>`;
    return;
  }
  const c = compare(base, r);
  const alerts = [
    ...c.swaps.map((s) => `<div class="alert"><b>바꿔치기 의심</b>${esc(s.note)}<small>줄어든 항목 ${s.fromHit.join(", ")} · 늘어난 항목 ${s.toHit.join(", ")}</small></div>`),
    ...(c.fresh.length ? [`<div class="alert"><b>새로 생김</b>${c.fresh.map((x) => `${esc(x.name)} ${x.after}회`).join(", ")}</div>`] : []),
  ];
  if (!alerts.length) alerts.push(`<div class="alert ok"><b>이상 없음</b>알려진 바꿔치기 패턴은 보이지 않습니다.</div>`);
  const rows = c.rows.filter((x) => x.before !== x.after).concat(c.rows.filter((x) => x.before === x.after)).map((x) => {
    const d = x.after - x.before;
    return `<tr><td><small>${esc(x.id)}</small>${esc(x.name)}</td><td class="n">${x.before}</td><td class="n">${x.after}</td><td class="n ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}</td></tr>`;
  }).join("");
  box.innerHTML = `
    <div class="vs"><div><small>처음 글</small><b>${c.before.per1k}</b><span>${esc(c.before.label)}</span></div><span class="arrow">→</span>
      <div><small>지금 글</small><b>${c.after.per1k}</b><span>${esc(c.after.label)}</span></div></div>
    ${alerts.join("")}
    <table class="delta"><thead><tr><th>항목</th><th class="n">처음</th><th class="n">지금</th><th class="n">변화</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="row-actions">
      <button class="sbtn line" type="button" data-act="diff">${state.diff ? "편집으로 돌아가기" : "처음 글과 비교해 보기"}</button>
      <button class="sbtn line" type="button" data-act="rebase">지금 글을 새 기준으로</button>
      <button class="sbtn line" type="button" data-act="revert">처음 글로 되돌리기</button>
    </div>`;
}

function renderMore() {
  const box = $("#tab-more");
  const r = state.result;
  const keep = new Set($$("#tab-more .checks input:checked").map((i) => i.dataset.id));
  box.innerHTML = `
    <p class="h">직접 확인할 것</p>
    <p class="note">자동으로는 찾기 어려운 항목입니다. 글을 읽으며 확인하세요.</p>
    <ul class="checks">${READ_ONLY.map((x) => `<li><label><input type="checkbox" data-id="${esc(x.id + x.name)}"${keep.has(x.id + x.name) ? " checked" : ""}><span><b><small>${esc(x.id)}</small>${esc(x.name)}</b><p>${esc(x.desc)}. ${esc(x.fix)}.</p></span></label></li>`).join("")}</ul>

    <p class="h">LLM에게 맡기기</p>
    <div class="prompt">
      <p class="note">이 페이지는 LLM을 호출하지 않습니다. 더 자세한 피드백이 필요하면 프롬프트를 복사해 Claude 같은 챗봇에 붙여 넣으세요. 지금 글, 검사 결과, 검사 기준이 함께 들어갑니다.</p>
      <button class="sbtn" type="button" data-act="prompt"${r ? "" : " disabled"}>프롬프트 복사</button>
      ${r ? `<details><summary>미리 보기</summary><pre>${esc(buildPrompt(r))}</pre></details>` : ""}
    </div>

    <p class="h">검사 기준</p>
    <ol class="rules">
      <li>숫자는 어디부터 읽을지 고르는 참고값입니다. 숫자를 낮추려고 고치면 글이 오히려 어색해집니다.</li>
      <li>한 번 나온 표현은 대체로 괜찮습니다. 반복되거나 몰렸을 때 무겁게 봅니다.</li>
      <li>고친 뒤에는 "변화" 탭에서 새로 늘어난 표현이 없는지 봅니다.</li>
      <li>문장 길이가 고르면 의심합니다. 짧은 문장만, 긴 문장만 이어지는 글이 기계적으로 읽힙니다.</li>
    </ol>
    <p class="links">기준 문서 <a href="docs/ai-tone-essence.md">ai-tone-essence.md</a> · 번역투 규칙 <a href="https://github.com/epoko77-ai/im-not-ai">im-not-ai</a>, <a href="https://github.com/leeandev/stop-slop-ko">stop-slop-ko</a> · 쉼표 통계 KatFish (ACL 2025)</p>`;
}

// ── 처음 글과 비교 ─────────────────────────────────────────
function renderDiff() {
  const base = state.baseline?.text || "";
  const ops = diffWords(base, ta.value);
  const mode = state.diffMode || (narrow() ? "inline" : "split");
  const del = ops.filter((o) => o.type === "del").length;
  const ins = ops.filter((o) => o.type === "ins").length;
  const bar = `<div class="diff-bar">
    <span class="diff-title">처음 글과 지금 글 <small>지운 곳 ${del} · 넣은 곳 ${ins} · 읽기 전용</small></span>
    <span class="seg" role="group" aria-label="보기 방식">
      <button type="button" data-mode="split" aria-pressed="${mode === "split"}">나란히</button>
      <button type="button" data-mode="inline" aria-pressed="${mode === "inline"}">한 줄로</button>
    </span>
    <button class="sbtn" type="button" data-act="diff">편집으로 돌아가기</button>
  </div>`;
  const view = $("#diffview");
  view.classList.toggle("split", mode === "split");
  if (mode === "split") {
    // 문단마다 한 행으로 묶어 좌우 높이를 맞춘다. 문단 경계는 양쪽에 공통인 빈 줄(eq)에서 자른다.
    const rows = [];
    let cur = { l: "", r: "" };
    for (const o of ops) {
      if (o.type === "eq") {
        const parts = o.text.split(/\n\s*\n/);
        parts.forEach((part, k) => {
          if (k > 0) { rows.push(cur); cur = { l: "", r: "" }; }
          cur.l += esc(part);
          cur.r += esc(part);
        });
      } else if (o.type === "del") {
        cur.l += `<del>${esc(o.text)}</del>`;
        if (/\S/.test(o.text)) cur.r += `<span class="gap" title="지운 자리"></span>`;
      } else {
        cur.r += `<ins>${esc(o.text)}</ins>`;
      }
    }
    rows.push(cur);
    view.innerHTML = bar + `<div class="diff-cols head"><p class="diff-cap">처음 글</p><p class="diff-cap">지금 글</p></div>` +
      rows.map((x) => `<div class="diff-cols row"><div class="diff-text">${x.l.replace(/^\n+|\n+$/g, "")}</div><div class="diff-text">${x.r.replace(/^\n+|\n+$/g, "")}</div></div>`).join("");
  } else {
    view.innerHTML = bar + `<div class="diff-text">${ops.map((o) => o.type === "eq" ? esc(o.text) : o.type === "del" ? `<del>${esc(o.text)}</del>` : `<ins>${esc(o.text)}</ins>`).join("")}</div>`;
  }
}
function toggleDiff(on = !state.diff) {
  state.diff = on;
  $("#doc").hidden = on;
  $("#diffview").hidden = !on;
  $("#compare-btn").classList.toggle("on", on);
  $("#compare-btn").textContent = on ? "편집으로 돌아가기" : "처음 글과 비교";
  if (on) renderDiff();
  renderPanel();
  scroller.scrollTop = 0;
}

// ── 파일 ───────────────────────────────────────────────────
async function loadFile(file) {
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) { setStatus("50MB가 넘는 파일은 열 수 없습니다.", true); return; }
  setStatus(`${esc(file.name)} 읽는 중…`);
  try {
    let { text } = await extractText(file);
    let note = "";
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); note = ` (앞 ${MAX_CHARS.toLocaleString()}자만 검사)`; }
    setText(text);
    toast(`${file.name}에서 ${chars(text).toLocaleString()}자를 꺼냈습니다${note}`);
  } catch (e) {
    setStatus(esc(e instanceof ExtractError ? e.message : `${file.name}을 읽지 못했습니다. (${e.message})`), true);
  }
}

function bindFiles() {
  $("#file").accept = ACCEPT;
  $("#file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
  const editor = $(".editor");
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; depth++; editor.classList.add("dragging"); });
  addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) editor.classList.remove("dragging"); });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    editor.classList.remove("dragging");
    loadFile(e.dataTransfer.files[0]);
  });
}

// ── 모바일 시트 ────────────────────────────────────────────
function openSheet(on) {
  $("#panel").classList.toggle("open", on);
  $("#handle").setAttribute("aria-expanded", String(on));
}

// ── 이벤트 ─────────────────────────────────────────────────
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); toast(done); } catch { toast("복사하지 못했습니다"); }
    t.remove();
  }
}

function bind() {
  ta.addEventListener("input", onInput);
  ta.addEventListener("click", pickFromCaret);
  ta.addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow")) pickFromCaret(); });
  ta.addEventListener("paste", () => { if (!ta.value) state.baseline = null; });

  const sampleButtons = SAMPLES.map((s) => `<button type="button" data-s="${s.id}">${esc(s.label)}</button>`).join("");
  $("#samples").innerHTML = sampleButtons;
  $("#empty-samples").innerHTML = SAMPLES.map((s) => `<button class="chip" type="button" data-s="${s.id}">${esc(s.label)}</button>`).join("");
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-s]");
    if (!b) return;
    const s = SAMPLES.find((x) => x.id === b.dataset.s);
    $("#sample-menu").open = false;
    setText(s.text);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(0, 0);
  });
  document.addEventListener("click", (e) => {
    const menu = $("#sample-menu");
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  $(".tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    setTab(b.dataset.tab);
    if (narrow()) openSheet(true);
  });
  $("#handle").addEventListener("click", () => openSheet(!$("#panel").classList.contains("open")));

  $("#panel-body").addEventListener("click", (e) => {
    const t = e.target;
    const top = t.closest(".top3 button");
    if (top) {
      state.focus = top.dataset.f;
      setTab("items");
      renderItems();
      paintFocus();
      $(`.item[data-f="${CSS.escape(top.dataset.f)}"]`)?.scrollIntoView({ block: "nearest" });
      const first = state.spans.findIndex((s) => s.f.id === top.dataset.f);
      if (first >= 0 && !narrow()) scrollToSpan(first);
      return;
    }
    const head = t.closest(".item-head");
    if (head) {
      const id = head.parentElement.dataset.f;
      state.focus = state.focus === id ? null : id;
      state.active = -1;
      renderItems();
      paintFocus();
      const first = state.spans.findIndex((s) => s.f.id === id || s.also.some((f) => f.id === id));
      if (state.focus && first >= 0 && !narrow()) scrollToSpan(first);
      return;
    }
    const go = t.closest("[data-go]");
    if (go) { selectSpan(+go.dataset.go); return; }
    const ap = t.closest("[data-apply]");
    if (ap) {
      const f = state.result.findings.find((x) => x.id === ap.dataset.f);
      const s = f.spans.find((x) => x.suggestion && `${x.suggestion.start}:${x.suggestion.end}` === ap.dataset.apply);
      if (s) applyEdits([s.suggestion]);
      return;
    }
    const all = t.closest("[data-apply-all]");
    if (all) {
      const f = state.result.findings.find((x) => x.id === all.dataset.applyAll);
      applyEdits(f.spans.filter((x) => x.suggestion).map((x) => x.suggestion));
      return;
    }
    const act = t.closest("[data-act]")?.dataset.act;
    if (act === "apply-all") {
      const done = applyEdits(allSuggestions());
      if (done) { toggleDiff(true); if (narrow()) openSheet(false); }
      return;
    }
    if (act === "diff") toggleDiff();
    if (act === "rebase") { state.baseline = state.result; renderPanel(); toast("지금 글을 새 기준으로 삼았습니다"); }
    if (act === "revert") {
      ta.focus({ preventScroll: true });
      ta.select();
      if (!document.execCommand("insertText", false, state.baseline.text)) ta.value = state.baseline.text;
      if (state.diff) toggleDiff(false);
      run();
      toast("처음 글로 되돌렸습니다. Ctrl+Z로 다시 돌아올 수 있습니다");
    }
    if (act === "prompt" && state.result) copy(buildPrompt(state.result), "프롬프트를 복사했습니다");
  });

  $("#compare-btn").addEventListener("click", () => toggleDiff());
  $("#diffview").addEventListener("click", (e) => {
    const m = e.target.closest("[data-mode]");
    if (m) { state.diffMode = m.dataset.mode; renderDiff(); return; }
    if (e.target.closest('[data-act="diff"]')) toggleDiff(false);
  });
  $("#copy").addEventListener("click", () => { if (ta.value) copy(ta.value, "글을 복사했습니다"); });
  $("#clear").addEventListener("click", () => {
    if (!ta.value) return;
    ta.focus();
    ta.select();
    if (!document.execCommand("delete")) ta.value = "";
    state.baseline = null;
    if (state.diff) toggleDiff(false);
    run();
  });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { state.focus = null; state.active = -1; paintFocus(); renderItems(); } });
}

// ── 시작 ───────────────────────────────────────────────────
function boot() {
  bindFiles();
  bind();
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) || "null"); } catch { /* 무시 */ }
  if (saved?.text) {
    ta.value = saved.text;
    if (saved.base && saved.base !== saved.text) {
      state.baseline = analyze(saved.base);
    }
    run();
  } else {
    run();
  }
}

try {
  boot();
  window.__appReady = true;
} catch (e) {
  if (window.__bootErrors) window.__bootErrors.push(e.message);
  throw e;
}
