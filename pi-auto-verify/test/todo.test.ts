import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_TODO_SNAPSHOT, isTaskDetails, mergeTodoSnapshot, type TodoSnapshot, type TodoStatus,
} from "../src/todo.ts";

const task = (id: number, status: TodoStatus, subject = `任务 ${id}`) => ({ id, subject, status });

const details = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  action: "list", params: {}, tasks, nextId: tasks.length + 1, ...extra,
});

/** 按工具结果顺序累积，等价于扩展在 `tool_result` 里的处理。 */
function track(results: unknown[]): TodoSnapshot {
  let snapshot: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  for (const value of results) {
    if (isTaskDetails(value)) snapshot = mergeTodoSnapshot(snapshot, value);
  }
  return snapshot;
}

test("没有 todo 结果时按未使用 todo 处理", () => {
  assert.deepEqual(track([]), { used: false, open: 0, openSummaries: [] });
  assert.deepEqual(track([undefined, "text", [], { tasks: [] }]), { used: false, open: 0, openSummaries: [] });
});

test("只调用过空的 todo 列表不算使用过 todo", () => {
  assert.deepEqual(track([details([])]), { used: false, open: 0, openSummaries: [] });
});

test("pending 与 in_progress 计入未完成，completed 与 deleted 墓碑不计入", () => {
  const snapshot = track([details([
    task(1, "pending"), task(2, "in_progress"), task(3, "completed"), task(4, "deleted"),
  ])]);
  assert.equal(snapshot.used, true);
  assert.equal(snapshot.open, 2);
  assert.deepEqual(snapshot.openSummaries, ["#1 任务 1", "#2 任务 2"]);
});

test("已使用过的记录不会因为后续清空而丢失，但未完成项随之归零", () => {
  const snapshot = track([details([task(1, "pending"), task(2, "pending")]), details([])]);
  assert.equal(snapshot.used, true);
  assert.equal(snapshot.open, 0);
  assert.deepEqual(snapshot.openSummaries, []);
});

test("最后一个快照决定未完成项，不会被更早的快照覆盖", () => {
  const snapshot = track([details([task(1, "pending"), task(2, "pending")]), details([task(1, "completed")])]);
  assert.equal(snapshot.open, 0);
  assert.equal(track([details([task(1, "completed")]), details([task(1, "pending")])]).open, 1);
});

test("形状不合法的 details 被跳过，不会当成快照", () => {
  for (const broken of [undefined, null, "text", [], { tasks: [] }, { tasks: {}, nextId: 1 }, { tasks: [], nextId: "1" }]) {
    assert.equal(isTaskDetails(broken), false);
    assert.deepEqual(track([broken]), { used: false, open: 0, openSummaries: [] });
  }
  assert.equal(track([{ tasks: [], nextId: "1" }, details([task(1, "pending")])]).open, 1);
});

test("真实 rpiv-todo 形状（含 description/activeForm/blockedBy/owner）可以解析", () => {
  const snapshot = track([details([
    { id: 1, subject: "实现触发条件", description: "对齐 checkCompletion", activeForm: "实现中", status: "in_progress", owner: "agent" },
    { id: 2, subject: "验证并记录证据", status: "pending", blockedBy: [1] },
    { id: 3, subject: "更新文档", status: "completed" },
  ], { action: "list", nextId: 4, error: undefined })]);
  assert.equal(snapshot.used, true);
  assert.equal(snapshot.open, 2);
  assert.deepEqual(snapshot.openSummaries, ["#1 实现触发条件", "#2 验证并记录证据"]);
});
