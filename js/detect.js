// 장르 자동 판단. 사용자가 고르지 않아도 글의 겉모양으로 판단한다.
// 결과는 규칙 적용 범위를 고르는 데만 쓰고, 근거를 화면에 함께 보여 준다.

const QUOTE_LINE = /^\s*["“「〈『'‘]/;

export function detectGenre(input) {
  const text = input.normalize("NFC");
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const sentences = text.split(/(?<=[.!?。])\s+|\n+/).map((s) => s.trim()).filter((s) => /[가-힣]/.test(s));
  const n = Math.max(1, sentences.length);
  const L = Math.max(1, lines.length);

  const dialogue = lines.filter((l) => QUOTE_LINE.test(l)).length;
  const inlineQuotes = (text.match(/“[^”\n]{1,80}”|"[^"\n]{1,80}"/g) || []).length;
  const formal = sentences.filter((s) => /(니다|니까|세요|에요|예요|해요|어요|아요|죠)[.!?]?["'”’]?$/.test(s)).length;
  const plain = sentences.filter((s) => /다[.!?]?["'”’]?$/.test(s)).length;
  const past = sentences.filter((s) => /[었았였했갔왔쳤렸졌]다[.!?]?["'”’]?$/.test(s)).length;
  const firstPerson = (text.match(/(?<![가-힣])(나는|내가|나의|내\s|나도|나를|나에게|우리는|우리가)/g) || []).length;
  const thirdPerson = (text.match(/(?<![가-힣])(그는|그녀는|그가|그녀가|그의|그녀의|그를|그녀를)/g) || []).length;
  const structure = lines.filter((l) => /^(#{1,6}\s|[-*•○□■◦▶※]\s?|\d+[.)]\s|[①-⑳]|[가-하]\.\s)/.test(l)).length;
  // 문장 부호 없이 끝나는 짧은 줄 = 제목·항목·표 칸
  const labels = lines.filter((l) => l.length <= 24 && !/[.!?。"”']$/.test(l)).length;
  const digits = (text.match(/\d/g) || []).length;
  const expository = (text.match(/결론|분석|데이터|기업|시장|정책|효과|방안|전략|과제|필요하다|중요하다|따라서|그러므로|또한|첫째|둘째|%|억\s?원|조\s?원/g) || []).length;
  const reflective = (text.match(/생각|기억|마음|느낌|돌이켜|그때|요즘|어릴\s?적|문득/g) || []).length;
  const chars = Math.max(1, text.replace(/\s/g, "").length);
  const per1k = (x) => (x / chars) * 1000;

  const score = { fiction: 0, essay: 0, nonfiction: 0 };
  const why = { fiction: [], essay: [], nonfiction: [] };
  const add = (g, v, reason) => { if (v > 0) { score[g] += v; why[g].push(reason); } };

  add("fiction", dialogue / L >= 0.08 ? 3 : dialogue >= 2 ? 1.5 : 0, `대사 ${dialogue}줄`);
  // 인용부호는 기사·보도자료에도 흔하므로 과거형 서술과 함께 나올 때만 소설 근거로 본다
  add("fiction", inlineQuotes >= 3 && past / n >= 0.25 ? 1 : 0, `인용 대사 ${inlineQuotes}곳`);
  add("fiction", past / n >= 0.45 ? 2 : past / n >= 0.25 ? 1 : 0, `과거형 서술 ${Math.round((past / n) * 100)}%`);
  add("fiction", per1k(thirdPerson) >= 3 ? 2 : thirdPerson >= 2 ? 1 : 0, `3인칭 대명사 ${thirdPerson}회`);

  add("essay", per1k(firstPerson) >= 4 ? 2 : firstPerson >= 2 ? 1 : 0, `1인칭 ${firstPerson}회`);
  add("essay", per1k(reflective) >= 3 ? 1.5 : reflective >= 2 ? 0.5 : 0, `회상·감정 어휘 ${reflective}회`);
  add("essay", plain / n >= 0.5 && dialogue / L < 0.08 ? 1 : 0, "평서형 '~다' 위주, 대사 적음");

  add("nonfiction", formal / n >= 0.4 ? 3 : formal / n >= 0.2 ? 1.5 : 0, `'~습니다/~요' 종결 ${Math.round((formal / n) * 100)}%`);
  add("nonfiction", structure >= 3 ? 2 : structure >= 1 ? 1 : 0, `제목·목록 ${structure}줄`);
  add("nonfiction", per1k(expository) >= 6 ? 2 : per1k(expository) >= 3 ? 1 : 0, `설명문 어휘 ${expository}회`);
  add("nonfiction", per1k(digits) >= 15 ? 2 : per1k(digits) >= 6 ? 1 : 0, `숫자 ${digits}개`);
  add("nonfiction", labels / L >= 0.3 && L >= 5 ? 1.5 : 0, `제목·항목형 줄 ${labels}개`);

  // 소설이 1인칭이면 essay 점수가 함께 오르므로, 대사가 많으면 소설 쪽으로 기운다
  if (dialogue / L >= 0.15) score.fiction += 1;

  const order = ["fiction", "essay", "nonfiction"].sort((a, b) => score[b] - score[a]);
  let genre = order[0];
  if (score[genre] === 0) genre = "essay"; // 단서가 없으면 가장 넓은 규칙 묶음
  const total = score.fiction + score.essay + score.nonfiction;
  const confidence = total ? score[genre] / total : 0;

  return {
    genre,
    confidence: +confidence.toFixed(2),
    scores: score,
    reasons: why[genre].length ? why[genre] : ["뚜렷한 단서가 없어 에세이 기준으로 봄"],
    runnerUp: order[1] !== genre && score[order[1]] > 0 ? order[1] : null,
  };
}
