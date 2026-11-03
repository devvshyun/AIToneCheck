// 단어 단위 diff (Myers O(ND)). 처음 글과 지금 글을 비교해 보여 줄 때 쓴다.
// 공백도 토큰으로 남겨서 이어 붙이면 원문이 그대로 복원된다.

// 공백, 낱말(한글·영문·숫자 묶음), 문장부호 한 글자씩으로 나눈다
const tokenize = (s) => s.match(/\s+|[가-힣A-Za-z0-9]+|[^\s가-힣A-Za-z0-9]/g) || [];

export function diffWords(before, after, maxEdits = 4000) {
  const a = tokenize(before);
  const b = tokenize(after);

  // 앞뒤 공통 부분은 미리 떼어 내 계산량을 줄인다
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);

  const ops = [];
  if (head) ops.push({ type: "eq", text: a.slice(0, head).join("") });
  ops.push(...myers(A, B, maxEdits));
  if (tail) ops.push({ type: "eq", text: a.slice(a.length - tail).join("") });
  return merge(ops);
}

function myers(a, b, maxEdits) {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ type: "ins", text: b.join("") }];
  if (!m) return [{ type: "del", text: a.join("") }];

  const max = Math.min(n + m, maxEdits);
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, v, a, b, off, d);
    }
  }
  // 편집이 너무 많으면 통째로 바뀐 것으로 본다
  return [{ type: "del", text: a.join("") }, { type: "ins", text: b.join("") }];
}

function backtrack(trace, last, a, b, off, dEnd) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ type: "eq", text: a[x - 1] }); x--; y--; }
    if (x === prevX) out.push({ type: "ins", text: b[y - 1] });
    else out.push({ type: "del", text: a[x - 1] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { out.push({ type: "eq", text: a[x - 1] }); x--; y--; }
  return out.reverse();
}

function merge(ops) {
  const out = [];
  for (const o of ops) {
    if (!o.text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.type === o.type) prev.text += o.text;
    else out.push({ ...o });
  }
  return out;
}
