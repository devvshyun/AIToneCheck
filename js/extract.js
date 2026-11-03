// 파일 → 텍스트 추출. 모두 브라우저 안에서 처리하고 서버로 보내지 않는다.
//
// 지원 형식
//   텍스트   txt, md, markdown, csv, tsv, json, srt, vtt, log   (UTF-8, UTF-16, EUC-KR 자동 판별)
//   웹 문서  html, htm, xhtml, xml
//   RTF      rtf
//   ZIP 계열 docx, docm, dotx, odt, ott, hwpx, epub, pptx, odp
//   PDF      pdf  (pdf.js, 텍스트 레이어가 있는 PDF만. 스캔 이미지는 OCR이 필요해 미지원)
//   한글     hwp  (HWP 5.0 바이너리. 배포용·암호 문서는 미지원)
// 미지원     doc, ppt, xls 같은 구형 MS Office 바이너리 → 새 형식으로 저장해 올리도록 안내

export const ACCEPT = [
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".srt", ".vtt", ".log",
  ".html", ".htm", ".xhtml", ".xml", ".rtf",
  ".docx", ".docm", ".dotx", ".odt", ".ott", ".hwpx", ".epub", ".pptx", ".odp",
  ".pdf", ".hwp",
].join(",");

export const FORMAT_LABEL = "TXT · MD · HTML · RTF · DOCX · ODT · HWP · HWPX · PDF · EPUB · PPTX";

export class ExtractError extends Error {}

const ext = (name) => (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

export async function extractText(file) {
  const kind = ext(file.name);
  const buf = new Uint8Array(await file.arrayBuffer());
  return extractFromBytes(buf, kind, file.name);
}

export async function extractFromBytes(buf, kind, name = "") {
  let text;
  switch (kind) {
    case "txt": case "csv": case "tsv": case "json": case "log": case "srt": case "vtt":
      text = decodeText(buf); break;
    case "md": case "markdown":
      text = stripMarkdown(decodeText(buf)); break;
    case "html": case "htm": case "xhtml":
      text = htmlToText(decodeText(buf)); break;
    case "xml":
      text = xmlToText(decodeText(buf)); break;
    case "rtf":
      text = rtfToText(buf); break;
    case "docx": case "docm": case "dotx":
      text = await docx(buf); break;
    case "odt": case "ott": case "odp":
      text = await odf(buf); break;
    case "hwpx":
      text = await hwpx(buf); break;
    case "epub":
      text = await epub(buf); break;
    case "pptx":
      text = await pptx(buf); break;
    case "pdf":
      text = await pdf(buf); break;
    case "hwp":
      text = await hwp(buf); break;
    case "doc": case "ppt": case "xls":
      throw new ExtractError(`구형 .${kind} 형식은 읽을 수 없습니다. 새 형식(.${kind}x)으로 저장한 뒤 올려 주세요.`);
    default:
      // 확장자를 모르면 텍스트로 시도
      text = decodeText(buf);
      if (!/[가-힣A-Za-z]/.test(text) || /\u0000/.test(text)) throw new ExtractError(`.${kind || "?"} 형식은 지원하지 않습니다.`);
  }
  text = tidy(text);
  if (!text.trim()) throw new ExtractError(kind === "pdf"
    ? "PDF에서 글자를 찾지 못했습니다. 스캔한 이미지 PDF는 글자 인식(OCR)이 필요해 읽을 수 없습니다."
    : "파일에서 글자를 찾지 못했습니다.");
  return { text, format: kind, name };
}

// ── 공통 ───────────────────────────────────────────────────
function tidy(t) {
  return t.replace(/\r\n?/g, "\n").replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("euc-kr").decode(buf); } // 한국어 윈도우 메모장 기본(CP949)
}

function stripMarkdown(md) {
  return md
    .replace(/^---\n[\s\S]*?\n---\n/, "")          // front matter
    .replace(/```[\s\S]*?```/g, "")                 // 코드 블록
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")           // 이미지
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")        // 링크
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")             // 제목
    .replace(/^\s{0,3}>\s?/gm, "")                  // 인용
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, "")        // 목록 기호
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, "")         // 표 구분선
    .replace(/\|/g, " ")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![*\w])\*(?!\s)(.+?)\*(?!\w)/g, "$1")
    .replace(/<[^>]+>/g, "");
}

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, style, noscript, nav, header, footer").forEach((n) => n.remove());
  return blockText(doc.body || doc.documentElement);
}

// 블록 요소마다 줄을 바꿔 텍스트를 모은다
function blockText(root) {
  const BLOCK = /^(P|DIV|H[1-6]|LI|BR|TR|SECTION|ARTICLE|BLOCKQUOTE|PRE|DT|DD|FIGCAPTION|TD|TH)$/;
  let out = "";
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue.replace(/\s+/g, " ");
      else if (c.nodeType === 1) {
        const tag = c.tagName.toUpperCase();
        if (tag === "BR") { out += "\n"; continue; }
        const block = BLOCK.test(tag);
        if (block) out += "\n";
        walk(c);
        if (block) out += "\n";
      }
    }
  };
  walk(root);
  return out.split("\n").map((l) => l.trim()).join("\n");
}

function xmlToText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  return blockText(doc.documentElement);
}

// XML 문단 추출: 문단 태그 안의 텍스트 태그를 이어 붙인다
function paragraphs(xml, paraTag, textTags, extra = {}) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out = [];
  const paras = doc.getElementsByTagName(paraTag);
  for (const p of paras) {
    // 중첩 문단(표 안 문단 등)은 가장 안쪽 것만 센다
    if (p.getElementsByTagName(paraTag).length) continue;
    let line = "";
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (textTags.includes(c.tagName)) line += c.textContent;
        else if (extra[c.tagName]) line += extra[c.tagName];
        else walk(c);
      }
    };
    walk(p);
    out.push(line);
  }
  return out.join("\n");
}

// ── ZIP 계열 ───────────────────────────────────────────────
async function zip(buf) {
  const { unzipSync, strFromU8 } = await import("../vendor/zipcfb.js");
  let files;
  try { files = unzipSync(buf); } catch { throw new ExtractError("압축을 풀 수 없는 파일입니다. 손상되었거나 암호가 걸려 있을 수 있습니다."); }
  const read = (path) => (files[path] ? strFromU8(files[path]) : null);
  return { files, read, names: Object.keys(files) };
}
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true });

async function docx(buf) {
  const z = await zip(buf);
  const main = z.read("word/document.xml");
  if (!main) throw new ExtractError("Word 문서 본문(word/document.xml)을 찾지 못했습니다.");
  const extra = { "w:tab": "\t", "w:br": "\n", "w:cr": "\n" };
  const parts = [paragraphs(main, "w:p", ["w:t"], extra)];
  for (const n of z.names.filter((x) => /^word\/(footnotes|endnotes)\.xml$/.test(x))) parts.push(paragraphs(z.read(n), "w:p", ["w:t"], extra));
  return parts.join("\n\n");
}

async function odf(buf) {
  const z = await zip(buf);
  const xml = z.read("content.xml");
  if (!xml) throw new ExtractError("본문(content.xml)을 찾지 못했습니다.");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType !== 1) continue;
      if (c.tagName === "text:p" || c.tagName === "text:h") out.push(odfLine(c));
      else walk(c);
    }
  };
  walk(doc.documentElement);
  return out.join("\n");
}
function odfLine(el) {
  let s = "";
  for (const c of el.childNodes) {
    if (c.nodeType === 3) s += c.nodeValue;
    else if (c.nodeType === 1) {
      if (c.tagName === "text:s") s += " ".repeat(+c.getAttribute("text:c") || 1);
      else if (c.tagName === "text:tab") s += "\t";
      else if (c.tagName === "text:line-break") s += "\n";
      else if (c.tagName === "text:note") continue;
      else s += odfLine(c);
    }
  }
  return s;
}

async function hwpx(buf) {
  const z = await zip(buf);
  const sections = z.names.filter((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort(natural);
  if (!sections.length) throw new ExtractError("한글 문서 본문(Contents/section*.xml)을 찾지 못했습니다.");
  return sections.map((s) => paragraphs(z.read(s), "hp:p", ["hp:t"], { "hp:lineBreak": "\n", "hp:tab": "\t" })).join("\n\n");
}

async function pptx(buf) {
  const z = await zip(buf);
  const slides = z.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(natural);
  return slides.map((s) => paragraphs(z.read(s), "a:p", ["a:t"], { "a:br": "\n" })).join("\n\n");
}

async function epub(buf) {
  const z = await zip(buf);
  const container = z.read("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  let order = [];
  if (opfPath && z.read(opfPath)) {
    const opf = new DOMParser().parseFromString(z.read(opfPath), "application/xml");
    const base = opfPath.includes("/") ? opfPath.replace(/[^/]+$/, "") : "";
    const items = {};
    for (const it of opf.getElementsByTagName("item")) items[it.getAttribute("id")] = it.getAttribute("href");
    for (const ref of opf.getElementsByTagName("itemref")) {
      const href = items[ref.getAttribute("idref")];
      if (href) order.push(decodeURIComponent(base + href));
    }
  }
  if (!order.length) order = z.names.filter((n) => /\.(x?html?)$/i.test(n)).sort(natural);
  return order.filter((p) => z.files[p]).map((p) => htmlToText(z.read(p))).join("\n\n");
}

// ── RTF ────────────────────────────────────────────────────
function rtfToText(buf) {
  const src = new TextDecoder("latin1").decode(buf);
  const cp = +(src.match(/\\ansicpg(\d+)/)?.[1] || 1252);
  const dec = new TextDecoder(cp === 949 ? "euc-kr" : cp === 65001 ? "utf-8" : "windows-1252");
  const SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|rsidtbl|generator)$/;
  let out = "";
  let bytes = [];
  const flush = () => { if (bytes.length) { out += dec.decode(new Uint8Array(bytes)); bytes = []; } };
  const stack = [];
  let skip = false;
  let uc = 1;
  let skipChars = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") { stack.push({ skip, uc }); continue; }
    if (ch === "}") { flush(); ({ skip, uc } = stack.pop() || { skip: false, uc: 1 }); continue; }
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "'") {
        const hex = src.substr(i + 2, 2);
        i += 3;
        if (skipChars > 0) { skipChars--; continue; }
        if (!skip) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") { flush(); if (!skip) out += next; i++; continue; }
      if (next === "*") { skip = true; i++; continue; }
      const m = /^([a-z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const [, word, arg] = m;
      flush();
      if (SKIP.test(word)) { skip = true; continue; }
      if (skip) continue;
      if (word === "par" || word === "line") out += "\n";
      else if (word === "tab") out += "\t";
      else if (word === "uc") uc = +arg;
      else if (word === "u") { let n = +arg; if (n < 0) n += 65536; out += String.fromCharCode(n); skipChars = uc; }
      continue;
    }
    if (ch === "\r" || ch === "\n") continue;
    if (skipChars > 0) { skipChars--; continue; }
    if (!skip) { flush(); out += ch; }
  }
  flush();
  return out;
}

// ── PDF ────────────────────────────────────────────────────
let pdfjsPromise;
async function pdf(buf) {
  pdfjsPromise ||= import("../vendor/pdfjs/pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  const pdfjs = await pdfjsPromise;
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: buf,
      cMapUrl: new URL("../vendor/pdfjs/cmaps/", import.meta.url).href,
      cMapPacked: true,
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    if (e?.name === "PasswordException") throw new ExtractError("암호가 걸린 PDF는 읽을 수 없습니다.");
    throw new ExtractError("PDF를 열 수 없습니다. 파일이 손상되었을 수 있습니다.");
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let s = "";
    let lastY = null;
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      const y = it.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2 && !s.endsWith("\n")) s += "\n";
      s += it.str;
      if (it.hasEOL) s += "\n";
      lastY = y;
    }
    pages.push(joinPdfLines(s));
  }
  return pages.join("\n\n");
}

// PDF는 줄마다 끊겨 나오므로, 문장 중간에서 끊긴 줄은 다시 잇는다.
// 줄 끝에 공백이 남아 있으면 띄어쓰기 자리에서 바뀐 줄이고, 없으면 단어 중간에서 바뀐 줄로 본다.
function joinPdfLines(s) {
  const lines = s.split("\n");
  let out = "";
  let prevRaw = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { out += "\n\n"; prevRaw = ""; continue; }
    if (!out || out.endsWith("\n")) out += l;
    else if (/[.!?。"'”’」:)\]]$/.test(out)) out += "\n" + l;
    else if (/\s$/.test(prevRaw) || !(/[가-힣]$/.test(out) && /^[가-힣]/.test(l))) out += " " + l;
    else out += l;
    prevRaw = raw;
  }
  return out;
}

// ── HWP 5.0 바이너리 ───────────────────────────────────────
// 구조: OLE 복합 파일 → FileHeader(속성 플래그) + BodyText/Section0..N (raw deflate 압축된 레코드 스트림)
// 레코드 헤더 32비트: tag(10) | level(10) | size(12, 0xFFF면 다음 4바이트가 크기)
// HWPTAG_PARA_TEXT = 67. 본문은 UTF-16LE이고 0~31 제어 문자가 섞여 있다.
//   문자 제어(1 WCHAR): 0, 10(줄바꿈), 13(문단 끝), 24~31
//   인라인·확장 제어(8 WCHAR): 그 밖의 1~31 (표·그림·각주 등 개체 자리, 9는 탭)
export async function hwp(buf) {
  const { CFB, inflateSync } = await import("../vendor/zipcfb.js");
  let cfb;
  try { cfb = CFB.read(buf, { type: "array" }); } catch { throw new ExtractError("한글(.hwp) 파일을 열 수 없습니다. HWP 5.0 이후 형식만 지원합니다."); }
  const header = CFB.find(cfb, "FileHeader");
  if (!header) throw new ExtractError("한글 5.0 형식이 아닙니다. 한글 97 이하 문서는 새 형식으로 저장해 주세요.");
  const h = Uint8Array.from(header.content);
  const sig = new TextDecoder("latin1").decode(h.slice(0, 17));
  if (sig !== "HWP Document File") throw new ExtractError("한글 문서 서명이 맞지 않습니다.");
  const flags = h[36] | (h[37] << 8) | (h[38] << 16) | (h[39] << 24);
  const compressed = (flags & 1) !== 0;
  if (flags & 2) throw new ExtractError("암호가 걸린 한글 문서는 읽을 수 없습니다.");
  if (flags & 4) throw new ExtractError("배포용 한글 문서는 본문이 암호화되어 있어 읽을 수 없습니다. 일반 문서로 저장해 올려 주세요.");

  const sections = cfb.FullPaths
    .map((p, i) => ({ p, e: cfb.FileIndex[i] }))
    .filter(({ p }) => /\/BodyText\/Section\d+$/i.test(p))
    .sort((a, b) => natural(a.p, b.p));
  if (!sections.length) throw new ExtractError("한글 문서 본문(BodyText)을 찾지 못했습니다.");

  const out = [];
  for (const { e } of sections) {
    let data = Uint8Array.from(e.content);
    if (compressed) {
      try { data = inflateSync(data); } catch { throw new ExtractError("한글 문서 본문 압축을 풀지 못했습니다."); }
    }
    out.push(hwpSectionText(data));
  }
  return out.join("\n");
}

export function hwpSectionText(data) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const paras = [];
  let pos = 0;
  while (pos + 4 <= data.length) {
    const head = dv.getUint32(pos, true);
    pos += 4;
    const tag = head & 0x3ff;
    let size = (head >>> 20) & 0xfff;
    if (size === 0xfff) { size = dv.getUint32(pos, true); pos += 4; }
    if (tag === 67) paras.push(hwpParaText(data.subarray(pos, pos + size)));
    pos += size;
  }
  return paras.join("\n");
}

function hwpParaText(b) {
  let s = "";
  for (let i = 0; i + 1 < b.length;) {
    const c = b[i] | (b[i + 1] << 8);
    if (c >= 32) { s += String.fromCharCode(c); i += 2; continue; }
    if (c === 0 || c === 13 || (c >= 24 && c <= 31)) { i += 2; continue; }
    if (c === 10) { s += "\n"; i += 2; continue; }
    if (c === 9) s += "\t";
    i += 16; // 인라인·확장 제어는 8 WCHAR
  }
  return s;
}
