// 외부 챗봇(Claude, ChatGPT 등)에 붙여 넣을 검수 프롬프트.
// 데모 페이지는 서버·API 키 없이 동작하므로 LLM 호출 대신 프롬프트를 복사해 준다.
// 6장 "LLM로 판정/고침을 돌릴 때 프롬프트에 꼭 넣을 것"을 그대로 담는다.

import { RULES, READ_ONLY, SWAPS } from "./rules.js";
import { GENRES } from "./rules.js";

export function buildPrompt(result) {
  const { text, genre, findings } = result;
  const found = findings.length
    ? findings.map((f) => `- ${f.id} ${f.name} (${f.count}회, S${f.sev}): ${f.spans.slice(0, 3).map((s) => `"${s.text}"`).join(", ")}`).join("\n")
    : "- (스캔으로 잡힌 후보 없음)";
  const signalList = [...RULES.filter((r) => !r.genres || r.genres.includes(genre)), ...READ_ONLY]
    .map((r) => `${r.id} ${r.name}`).join(" / ");
  const swaps = SWAPS.map((s) => `- ${s.note}`).join("\n");

  return `너는 한국어 ${GENRES[genre]} 문체 검수자다. 아래 글에서 'AI가 쓴 것처럼 느껴지는 버릇'을 찾아 피드백하고, 고친 안을 제시해라.

핵심 기준: AI 티는 '틀린 문장'이 아니라 '사람이 안 하는 버릇'이다.

[반드시 지킬 것]
1. 판정은 읽어서 한다. 점수를 맞추려고 고치지 마라.
2. 단일 1회 출현은 지적하지 마라. 반복·밀집을 잡아라.
3. 고친 안은 대사·사건·사실을 바꾸지 말고 서술만 고쳐라.
4. 고친 안이 아래 '버릇 바꿔치기'를 새로 만들지 않는지 스스로 검수하라.
5. "이 글은 AI다/사람이다"라고 판결하지 마라. 신호를 보여 주고 판단은 작가에게 남겨라.
6. 리듬의 기준은 길이가 아니라 섞임이다. 짧게만 끊어도, 길게만 이어도 둘 다 AI 티다.

[참고 신호 목록]
${signalList}

[버릇 바꿔치기 — 고친 뒤 생기기 쉬운 것]
${swaps}

[규칙 스캐너가 먼저 잡은 후보 — 확정이 아니라 읽을 자리]
${found}

[출력 형식]
1. 전체 판정 한 줄 (AI 티가 꽤 보입니다 / 부분적으로 / 거의 사람 글입니다)
2. 가장 많이 나온 버릇 3개와 줄이는 방향 한 줄씩
3. 문제 문장별: 원문 인용 → 신호 번호 → 왜 → 고친 안 (전·후 나란히)
4. 스캐너가 놓친, 읽어야 잡히는 신호 (A9 경구, C3 콜백 짚기, E0 정보 없는 꾸밈, I 비틀어 말하기 등)
5. 고친 안을 적용했을 때 새로 생길 수 있는 버릇 점검

[글]
${text}`;
}
