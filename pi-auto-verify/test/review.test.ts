import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReview, excerpt } from "../src/review.ts";

test("审查只接受协议内的明确结论，模糊或自相矛盾的输出不能放行", () => {
  for (const text of ['looks good', '{}', '{"verdict":"pass","reason":"ok","issues":["还缺测试"]}',
    '{"verdict":"concern","reason":"不确定","issues":[]}']) {
    assert.throws(() => parseReview(text, 1));
  }
  assert.equal(parseReview('{"verdict":"pass","reason":"实际断言已覆盖","issues":[]}', 3).generation, 3);
  assert.equal(parseReview('{"verdict":"concern","reason":"只有 echo","issues":["运行真实入口"]}', 3).verdict, "concern");
});

test("长输出保留开头和最终诊断，并显式标记未知片段", () => {
  const text = excerpt(`start:${"x".repeat(1000)}:failure`, 100);
  assert.ok(text.startsWith("start:"));
  assert.ok(text.endsWith(":failure"));
  assert.match(text, /截断/);
  assert.ok(text.length < 200);
});
