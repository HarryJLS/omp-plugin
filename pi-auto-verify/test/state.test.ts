import assert from "node:assert/strict";
import { test } from "node:test";
import { VerificationState, type Plan, type Proof } from "../src/state.ts";

const plan: Plan = {
  task: "change", surface: "cli",
  criteria: [{ id: "main", description: "实际行为正确", kind: "smoke", mode: "runtime" }],
};

function planned(rounds = 3, review = false) {
  const state = new VerificationState(rounds, false, review);
  state.setPlan(plan);
  return state;
}

function proof(revision: number): Proof {
  return { kind: "smoke", revision, criteria: ["main"], summary: "实际观察",
    evidence: [{ id: "run", tool: "bash", input: "node behavior.js", output: "assertion passed", revision, runtime: true, visual: false }] };
}

test("没有修改的普通问答不触发续跑", () => {
  const state = new VerificationState(3, false);
  assert.equal(state.settle(true), false);
  assert.equal(state.status, "idle");
});

test("缺少验证时续跑，获得当前修改的证据后才通过", () => {
  const state = planned();
  state.changed();
  assert.equal(state.settle(true), true);
  state.attempt("smoke", ["main"]);
  state.accept(proof(state.revision));
  assert.equal(state.settle(true), false);
  assert.equal(state.status, "evidence_complete");
});

test("验证期间或验证后再次修改，旧证据不能放行", () => {
  const state = planned();
  state.changed();
  const revision = state.revision;
  state.changed();
  assert.equal(state.accept(proof(revision)), false);
  assert.equal(state.settle(true), true);
});

test("E2E 一旦开始，即使 smoke 通过也不能掩盖 E2E 失败", () => {
  const state = planned();
  state.setPlan({ ...plan, criteria: [...plan.criteria, { id: "e2e", description: "完整流程", kind: "e2e", mode: "runtime" }] });
  state.changed();
  state.attempt("e2e", ["e2e"]);
  state.attempt("smoke", ["main"]);
  state.accept(proof(state.revision));
  assert.deepEqual(state.missing(), ["e2e"]);
  assert.equal(state.settle(true), true);
});

test("新的失败使同类旧成功失效", () => {
  const state = planned();
  state.attempt("smoke", ["main"]);
  state.accept(proof(state.revision));
  state.attempt("smoke", ["main"]);
  assert.equal(state.settle(true), true);
});

test("反复声称完成只能续跑限定次数，不能变成成功", () => {
  const state = planned(2);
  state.changed();
  assert.equal(state.settle(true), true);
  assert.equal(state.settle(true), true);
  assert.equal(state.settle(true), false);
  assert.equal(state.status, "unverified");
  assert.equal(state.rounds, 2);
});

test("受阻会结束循环但不算通过，新修改重新要求验证", () => {
  const state = planned();
  state.changed();
  state.finish("blocked", "缺少服务");
  assert.equal(state.settle(true), false);
  assert.equal(state.status, "blocked");
  state.changed();
  assert.equal(state.settle(true), true);
});

test("不能继续的会话不能被强行续跑；新任务有独立预算", () => {
  const state = new VerificationState(1, true);
  state.changed();
  assert.equal(state.settle(false), false);
  assert.equal(state.status, "unverified");
  const next = new VerificationState(1, true);
  next.changed();
  assert.equal(next.settle(true), true);
  assert.deepEqual(next.missing(), ["验收计划"]);
});

test("没有验收计划，任意成功命令不能登记通过", () => {
  const state = new VerificationState(3, false);
  state.changed();
  assert.throws(() => state.accept(proof(state.revision)));
  assert.deepEqual(state.missing(), ["验收计划"]);
});

test("不能删除或降级验收项，新增项必须补证据", () => {
  const state = planned();
  state.accept(proof(0));
  assert.throws(() => state.setPlan({ ...plan, criteria: [] }));
  assert.throws(() => state.setPlan({ ...plan, criteria: [{ ...plan.criteria[0], description: "只要文件存在" }] }));
  state.setPlan({ ...plan, criteria: [...plan.criteria, { id: "error", description: "错误输入", kind: "smoke", mode: "runtime" }] });
  assert.deepEqual(state.missing(), ["error"]);
});

test("Web 验收不能只有 shell 成功或只有一张图片", () => {
  const state = new VerificationState(3, false);
  assert.throws(() => state.setPlan({ ...plan, surface: "web" }));
  state.setPlan({ ...plan, surface: "web", criteria: [{ ...plan.criteria[0], mode: "visual" }] });
  assert.equal(state.accept(proof(0)), false);
  const image = proof(0);
  image.evidence[0].runtime = false;
  image.evidence[0].visual = true;
  assert.equal(state.accept(image), false);
  image.evidence.push(proof(0).evidence[0]);
  assert.equal(state.accept(image), true);
});

test("缺陷需要修复前证据或明确限制，不能修复后补造复现", () => {
  const state = new VerificationState(3, false);
  state.setPlan({ ...plan, task: "bug" });
  state.changed();
  state.accept(proof(state.revision));
  assert.equal(state.missing().length, 1);
  assert.throws(() => state.reproduce(proof(state.revision)));
  state.setPlan({ ...plan, task: "bug", baselineUnavailableReason: "进入任务前补丁已经存在，无法重建旧环境" });
  assert.deepEqual(state.missing(), []);
});

test("修复前复现跨修改保留，但不能代替修复后验证", () => {
  const state = new VerificationState(3, false);
  state.setPlan({ ...plan, task: "bug" });
  state.reproduce(proof(0));
  state.changed();
  assert.deepEqual(state.missing(), ["main"]);
  state.accept(proof(state.revision));
  assert.deepEqual(state.missing(), []);
  assert.equal(state.report().criteria[0].reproduction?.revision, 0);
});

test("独立审查通过才标 verified，新的验证或修改使审查过期", () => {
  const state = planned(3, true);
  state.accept(proof(0));
  assert.deepEqual(state.missing(), ["独立审查"]);
  state.review = { generation: state.generation, verdict: "pass", reason: "已覆盖", issues: [] };
  assert.equal(state.settle(true), false);
  assert.equal(state.status, "verified");
  state.attempt("smoke", ["main"]);
  state.accept(proof(0));
  assert.deepEqual(state.missing(), ["独立审查"]);
});
