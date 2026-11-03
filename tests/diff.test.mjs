import { test } from "node:test";
import assert from "node:assert/strict";
import { diffWords } from "../js/diff.js";

const join = (ops, keep) => ops.filter((o) => keep.includes(o.type)).map((o) => o.text).join("");

test("단어 diff: 원문과 수정본이 그대로 복원되고 바뀐 부분만 표시된다", () => {
  const a = "그녀는 어느새 머리를 짧게 자르고 있었다. 그게 다였다.";
  const b = "그녀는 머리를 짧게 잘랐다.";
  const ops = diffWords(a, b);
  assert.equal(join(ops, ["eq", "del"]), a);
  assert.equal(join(ops, ["eq", "ins"]), b);
  assert.ok(ops.some((o) => o.type === "del" && o.text.includes("어느새")));
});

test("단어 diff: 같으면 한 덩어리, 빈 글 처리", () => {
  assert.deepEqual(diffWords("같은 글", "같은 글"), [{ type: "eq", text: "같은 글" }]);
  assert.deepEqual(diffWords("", "새 글"), [{ type: "ins", text: "새 글" }]);
  assert.deepEqual(diffWords("옛 글", ""), [{ type: "del", text: "옛 글" }]);
});
