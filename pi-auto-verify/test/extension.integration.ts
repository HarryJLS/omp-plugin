import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import { fauxAssistantMessage, fauxToolCall, Type, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHarness, type Harness } from "@pi-test/harness";
import { createTestExtensionsResult, createTestResourceLoader } from "@pi-test/utilities";
import { loadExtensions } from "@pi-test/loader";
import autoVerify from "../src/index.ts";

type TodoTask = { id: number; subject: string; status: "pending" | "in_progress" | "completed" | "deleted" };

const harnesses: Harness[] = [];

/** 可见的 todo 列表状态；stub 每次返回与 rpiv-todo 相同的 details 形状。 */
const todoState: { tasks: TodoTask[] } = { tasks: [] };

function openTodo(subject = "完成改动并实际验证", id = 1): TodoTask {
  return { id, subject, status: "in_progress" };
}

function todoStub(pi: ExtensionAPI) {
  pi.registerTool({
    name: "todo", label: "Todo", description: "集成测试用的 todo 工具，details 形状与 rpiv-todo 一致",
    parameters: Type.Object({ action: Type.Optional(Type.String({ description: "测试用参数" })) }),
    async execute() {
      const tasks = todoState.tasks.map((task) => ({ ...task }));
      return {
        content: [{
          type: "text" as const,
          text: tasks.length ? tasks.map((task) => `[${task.status}] #${task.id} ${task.subject}`).join("\n") : "No todos",
        }],
        details: { action: "list", params: {}, tasks, nextId: tasks.length + 1 },
      };
    },
  });
}

async function setup(tasks: TodoTask[] = [openTodo()]) {
  todoState.tasks = tasks;
  const harness = await createHarness({ extensionFactories: [autoVerify, todoStub] });
  harnesses.push(harness);
  await harness.session.bindExtensions({ shutdownHandler: () => {} });
  return harness;
}

function call(name: string, args: JsonObject) {
  const input = name === "verify_run" || name === "verify_evidence"
    ? { criteria: [args.kind === "e2e" ? "flow" : "main"], ...args } : args;
  return fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" });
}

const mainCriterion = { id: "main", description: "实际答案符合要求", kind: "smoke", mode: "runtime" };

/**
 * 与 verify_plan 同一轮发出 `todo` 调用：本扩展只在任务使用 todo 列表跟踪时才在结束前
 * 检查验收（与 OMP 的 todo 收尾检查一致），所以启用触发的用例必须先产生一次成功快照。
 * 需要"没有 todo 列表"的用例用 `setup([])` 并省略这一步。
 */
function plan(overrides: JsonObject = {}) {
  return fauxAssistantMessage([
    fauxToolCall("todo", { action: "list" }),
    fauxToolCall("verify_plan", { task: "change", surface: "cli", criteria: [mainCriterion], ...overrides }),
  ], { stopReason: "toolUse" });
}

function reports(h: Harness) {
  return h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "auto-verify/report")
    .map((e) => e.type === "custom" ? e.data as { status: string; rounds: number } : undefined);
}

function reportData(h: Harness) {
  return h.sessionManager.getEntries().flatMap((e) =>
    e.type === "custom" && e.customType === "auto-verify/report" ? [e.data] : []);
}

/** 扩展注入的可见提示（续跑说明与最终结论）。 */
function notes(h: Harness) {
  return h.sessionManager.getEntries().flatMap((e) =>
    e.type === "custom_message" && e.customType === "auto-verify" && typeof e.content === "string" ? [e.content] : []);
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

test("真实会话：代理提前结束会自动续跑，实际 shell 断言通过后才 settled", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("修改完成"),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "确认文件值为 42" }),
    fauxAssistantMessage("实际验证通过"),
  ]);
  await h.session.prompt("写入答案并验证");
  expect(await readFile(join(h.tempDir, "answer.txt"), "utf8")).toBe("42");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
  expect(h.eventsOfType("agent_settled")).toHaveLength(1);
  const result = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "verify_run");
  expect(result?.role === "toolResult" && result.isError).toBe(false);
});

test("失败不是通过：真实断言失败后自动修复并重测", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "wrong" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "校验答案" }),
    fauxAssistantMessage("完成"),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "修复后校验" }),
    fauxAssistantMessage("已修复并验证"),
  ]);
  await h.session.prompt("写入并验证答案");
  const results = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_run");
  expect(results.map((m) => m.role === "toolResult" && m.isError)).toEqual([true, false]);
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
});

test("已通过后又改代码，自动要求重新验证", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test -f answer.txt", purpose: "检查文件" }),
    call("write", { path: "answer.txt", content: "43" }),
    fauxAssistantMessage("完成"),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 43", purpose: "再次确认答案" }),
    fauxAssistantMessage("再次验证通过"),
  ]);
  await h.session.prompt("修改答案");
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
});

test("伪造证据被拒绝；环境受阻明确结束但不算通过", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_evidence", { kind: "smoke", toolCallIds: ["made-up"], summary: "相信我" }),
    call("verify_finish", { status: "blocked", reason: "没有所需服务" }),
    fauxAssistantMessage("环境受阻，尚未验证"),
  ]);
  await h.session.prompt("修改答案");
  const result = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "verify_evidence");
  expect(result?.role === "toolResult" && result.isError).toBe(true);
  expect(reports(h).at(-1)?.status).toBe("blocked");
});

test("权限扩展可以阻止验证命令，verify_run 不绕过它", async () => {
  // 该用例直接构造 harness，必须显式让触发条件（todo 列表有未完成项）成立。
  todoState.tasks = [openTodo()];
  const h = await createHarness({
    extensionFactories: [autoVerify, todoStub, (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "bash") return { block: true, reason: "测试权限禁止执行" };
      });
    }],
  });
  harnesses.push(h);
  await h.session.bindExtensions({ shutdownHandler: () => {} });
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "touch forbidden.txt", purpose: "应被阻止" }),
    call("verify_finish", { status: "blocked", reason: "需要用户授权" }),
    fauxAssistantMessage("等待授权"),
  ]);
  await h.session.prompt("验证");
  await expect(readFile(join(h.tempDir, "forbidden.txt"))).rejects.toThrow();
  expect(reports(h).at(-1)?.status).toBe("blocked");
});

test("真实进程超时不算通过，自动循环存在上限", async () => {
  const h = await setup();
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"maxRounds":1,"timeoutSeconds":1}');
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "sleep 10", purpose: "测试超时" }),
    fauxAssistantMessage("完成"),
    fauxAssistantMessage("仍然没有验证"),
  ]);
  await h.session.prompt("修改并验证");
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "unverified"]);
  expect(h.getPendingResponseCount()).toBe(0);
});

test("简单问答不会进入验证循环", async () => {
  const h = await setup();
  h.setResponses([fauxAssistantMessage("你好")]);
  await h.session.prompt("你好");
  expect(reports(h)).toEqual([]);
  expect(h.eventsOfType("agent_settled")).toHaveLength(1);
});

test("没有 todo 列表时，改了文件也不进入验证循环", async () => {
  const h = await setup([]);
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("修改完成"),
  ]);
  await h.session.prompt("写入答案");
  expect(await readFile(join(h.tempDir, "answer.txt"), "utf8")).toBe("42");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(reports(h)).toEqual([]);
  expect(notes(h)).toEqual([]);
  expect(h.eventsOfType("agent_settled")).toHaveLength(1);
});

test("todo 全部完成或已被清空时不再强制续跑，但仍登记未通过结论", async () => {
  const h = await setup([{ id: 1, subject: "完成改动", status: "completed" }]);
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("全部完成"),
  ]);
  await h.session.prompt("写入答案并收尾");
  expect(await readFile(join(h.tempDir, "answer.txt"), "utf8")).toBe("42");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(h.eventsOfType("agent_settled")).toHaveLength(1);
  expect(reports(h).map((r) => r?.status)).toEqual(["unverified"]);
  expect(reportData(h).at(-1)).toMatchObject({ rounds: 0, reason: "todo 列表已无未完成项，不再自动续跑。" });
  expect(notes(h)).toEqual(["自动验证结束，但未通过验收：unverified。todo 列表已无未完成项，不再自动续跑。"]);
});

test("todo 关闭后仍登记最终结论：证据齐备也算通过", async () => {
  const h = await setup([openTodo("完成改动并实际验证", 2)]);
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "确认文件值为 42" }),
    // 验证通过后把 todo 收尾，再结束：此时不应再被要求继续，但结论必须留下。
    () => {
      todoState.tasks = [{ id: 2, subject: "完成改动并实际验证", status: "completed" }];
      return call("todo", { action: "list" });
    },
    fauxAssistantMessage("验证通过并已收尾"),
  ]);
  await h.session.prompt("写入答案并验证");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(h.eventsOfType("agent_settled")).toHaveLength(1);
  expect(reports(h).map((r) => r?.status)).toEqual(["evidence_complete"]);
  expect(notes(h).at(-1)).toContain("执行证据齐备（未独立审查）：main: 实际答案符合要求");
});

test("同一会话的下一个任务不会继承上一个任务的 todo 状态", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "确认文件值为 42" }),
    fauxAssistantMessage("第一个任务完成"),
  ]);
  await h.session.prompt("第一个任务");
  expect(reports(h).map((r) => r?.status)).toEqual(["evidence_complete"]);

  // 第二个任务不碰 todo：分支里还留着上个任务的 todo 快照，但不能再触发检查。
  h.setResponses([
    call("write", { path: "second.txt", content: "43" }),
    fauxAssistantMessage("第二个任务完成"),
  ]);
  await h.session.prompt("第二个任务");
  expect(await readFile(join(h.tempDir, "second.txt"), "utf8")).toBe("43");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(reports(h).map((r) => r?.status)).toEqual(["evidence_complete"]);
  expect(notes(h)).toHaveLength(1);
});

test("存在未完成 todo 时续跑，并在提示中列出未完成项", async () => {
  const h = await setup([{ id: 1, subject: "实现触发器", status: "completed" }, openTodo("验证并记录证据", 2)]);
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("先结束看看"),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "确认文件值为 42" }),
    fauxAssistantMessage("验证完成"),
  ]);
  await h.session.prompt("写入答案并验证");
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
  const injected = notes(h);
  expect(injected).toHaveLength(2);
  expect(injected[0]).toContain("todo 列表中仍有 1 项未完成");
  expect(injected[0]).toContain("#2 验证并记录证据");
  expect(injected[0]).toContain("自动验证 1/3");
});

test("/auto-verify status 会说明当前触发条件", async () => {
  const h = await setup([openTodo("验证并记录证据", 2)]);
  h.setResponses([
    call("todo", { action: "list" }),
    fauxAssistantMessage("已登记待办"),
  ]);
  await h.session.prompt("登记待办");
  // 有未完成 todo 但没有改动、也没有验收计划：条件成立但无事可查，不应产生报告或续跑。
  expect(reports(h)).toEqual([]);
  await h.session.prompt("/auto-verify status");
  expect(notes(h).at(-1)).toContain("触发条件：todo 仍有 1 项未完成：#2 验证并记录证据");
});

test("注入的验证提示词说明触发条件依赖 todo 列表", async () => {
  const h = await setup();
  h.setResponses([
    (context) => {
      const system = JSON.stringify(context.messages);
      expect(system).toContain("只对**用 todo 列表跟踪过的任务**启动");
      expect(system).toContain("把验证本身作为 todo 列表中的一项");
      return call("todo", { action: "list" });
    },
    fauxAssistantMessage("收到"),
  ]);
  await h.session.prompt("随便问一句");
  expect(h.getPendingResponseCount()).toBe(0);
  // 只有 todo 快照而没有改动：条件成立但无事可查，不产生报告也不续跑。
  expect(reports(h)).toEqual([]);
});

test("真实文件加载：Pi 加载器可以加载本地包，执行验证并读取随包提示词", async () => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([entry], process.cwd());
  expect(loaded.errors).toEqual([]);
  // harness 优先使用 resourceLoader，所以 todo 快照工具也必须并进真实加载器这一侧的结果。
  todoState.tasks = [openTodo()];
  const stub = await createTestExtensionsResult([todoStub]);
  const extensionsResult = { ...loaded, extensions: [...loaded.extensions, ...stub.extensions] };
  const h = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
  harnesses.push(h);
  await h.session.bindExtensions({ shutdownHandler: () => {} });
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("完成"),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "检查实际答案" }),
    fauxAssistantMessage("已验证"),
  ]);
  await h.session.prompt("修改并验证答案");
  expect(reports(h).at(-1)?.status).toBe("evidence_complete");
});

test("真实 HTTP E2E：冒烟之后仍需验证运行中服务的响应", async () => {
  const h = await setup();
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"requireE2E":true}');
  const server = createServer(async (_request, response) => {
    try {
      response.setHeader("content-type", "application/json");
      response.end(await readFile(join(h.tempDir, "answer.json"), "utf8"));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("未能启动本地服务");
  const command = `node --input-type=module -e 'import assert from "node:assert/strict"; const r = await fetch("http://127.0.0.1:${address.port}/answer"); assert.equal(r.status, 200); assert.deepEqual(await r.json(), {answer:42});'`;
  try {
    h.setResponses([
      plan({ surface: "api", criteria: [mainCriterion, { id: "flow", description: "HTTP 响应内容正确", kind: "e2e", mode: "runtime" }] }),
      call("write", { path: "answer.json", content: '{"answer":42}' }),
      call("verify_run", { kind: "smoke", command: "test -f answer.json", purpose: "数据文件存在" }),
      fauxAssistantMessage("冒烟成功，准备结束"),
      call("verify_run", { kind: "e2e", command, purpose: "客户端实际请求服务并断言 HTTP 状态及 JSON 内容" }),
      fauxAssistantMessage("接口 E2E 通过"),
    ]);
    await h.session.prompt("写入接口数据并验证");
    expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
    expect(h.getPendingResponseCount()).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("已通过的普通 shell 验证可以引用，无需重复执行", async () => {
  const h = await setup();
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("bash", { command: "test \"$(cat answer.txt)\" = 42" }),
    (context) => {
      const observed = context.messages.findLast((m) => m.role === "toolResult" && m.toolName === "bash");
      if (!observed || observed.role !== "toolResult") throw new Error("缺少真实工具结果");
      return call("verify_evidence", { kind: "smoke", toolCallIds: [observed.toolCallId], summary: "shell 已断言实际答案" });
    },
    fauxAssistantMessage("验证完成"),
  ]);
  await h.session.prompt("修改并验证");
  expect(reports(h).map((r) => r?.status)).toEqual(["evidence_complete"]);
});

test("未信任项目不会自动运行检查", async () => {
  const h = await setup();
  h.settingsManager.setProjectTrusted(false);
  h.setResponses([
    call("write", { path: "answer.txt", content: "42" }),
    fauxAssistantMessage("结束"),
  ]);
  await h.session.prompt("修改");
  expect(reports(h)).toEqual([]);
});

test("用户取消时不重新启动验证循环", async () => {
  const h = await setup();
  let cancelled = false;
  h.session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "bash") {
      cancelled = true;
      void h.session.abort();
    }
  });
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "sleep 10", purpose: "取消中的验证" }),
    fauxAssistantMessage("不应继续运行"),
  ]);
  await h.session.prompt("修改");
  expect(cancelled).toBe(true);
  expect(reports(h).some((r) => r?.status === "verified" || r?.status === "pending")).toBe(false);
  expect(h.eventsOfType("agent_start")).toHaveLength(1);
  const result = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "verify_run");
  expect(result?.role === "toolResult" && result.isError).toBe(true);
});

test("缺少计划时不会执行任意验证命令，续跑后先对齐验收", async () => {
  const h = await setup();
  h.setResponses([
    // 先产生一次 todo 快照，使结束前的检查条件成立；此时刻意还没有 verify_plan。
    call("todo", { action: "list" }),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "touch bypass.txt", purpose: "未声明计划" }),
    fauxAssistantMessage("完成"),
    plan(),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "实际检查" }),
    fauxAssistantMessage("已验证"),
  ]);
  await h.session.prompt("写入并验证答案为 42");
  await expect(readFile(join(h.tempDir, "bypass.txt"))).rejects.toThrow();
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
});

test("真实缺陷复现：先观察失败断言，修复后同一行为通过", async () => {
  const h = await setup();
  await writeFile(join(h.tempDir, "parse.mjs"), 'export const parse = (text) => Number(text);\n');
  const command = `node --input-type=module -e 'import assert from "node:assert/strict"; import {parse} from "./parse.mjs"; assert.throws(() => parse(""), /empty/); assert.equal(parse("42"),42);'`;
  h.setResponses([
    plan({ task: "bug", surface: "library" }),
    call("verify_run", { kind: "smoke", command, purpose: "空输入必须拒绝，合法输入正确解析", phase: "reproduce", expectedFailure: "Missing expected exception" }),
    call("write", { path: "parse.mjs", content: 'export function parse(text) { if (!text.trim()) throw new Error("empty"); return Number(text); }\n' }),
    call("verify_run", { kind: "smoke", command, purpose: "重新执行原复现断言和正常输入断言" }),
    fauxAssistantMessage("复现后已修复并验证"),
  ]);
  await h.session.prompt("修复空字符串被错误当成 0 的问题，同时保持合法数字解析");
  expect(reportData(h).at(-1)).toMatchObject({
    status: "evidence_complete",
    criteria: [{ id: "main", reproduction: { revision: 0 }, proof: { summary: "重新执行原复现断言和正常输入断言" } }],
  });
  const runs = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_run");
  expect(runs.map((m) => m.role === "toolResult" && m.isError)).toEqual([false, false]);
});

test("一条标准通过不能掩盖另一条未测标准，清单不可被缩小", async () => {
  const h = await setup();
  const full = { criteria: [mainCriterion, { id: "second", description: "另一份答案也正确", kind: "smoke", mode: "runtime" }] };
  h.setResponses([
    plan(full),
    call("write", { path: "answer.txt", content: "42" }),
    call("write", { path: "second.txt", content: "43" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "第一条通过" }),
    plan(),
    fauxAssistantMessage("完成"),
    call("verify_run", { kind: "smoke", criteria: ["second"], command: "test \"$(cat second.txt)\" = 43", purpose: "补第二条实际断言" }),
    fauxAssistantMessage("全部验收齐备"),
  ]);
  await h.session.prompt("两份答案分别为 42 和 43，逐一确认");
  const plans = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_plan");
  expect(plans.map((m) => m.role === "toolResult" && m.isError)).toEqual([false, true]);
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
  expect(reportData(h).at(-1)).toMatchObject({ criteria: [{ id: "main" }, { id: "second" }] });
});

test("独立审查能退回薄弱验证，修复证据后重审；额外用量进入工具结果", async () => {
  const h = await setup();
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"reviewer":"current"}');
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "printf not-42", purpose: "主代理自称全部通过" }),
    fauxAssistantMessage("完成"),
    call("verify_review", {}),
    (context) => {
      const payload = JSON.stringify(context.messages);
      expect(payload).toContain("printf not-42");
      expect(payload).toContain("主代理自称全部通过");
      expect(payload).toContain("文件里的值为 42");
      expect(context.messages.flatMap((m) => m.role === "system" ? m.toolsAdded ?? [] : [])).toHaveLength(0);
      return fauxAssistantMessage('{"verdict":"concern","reason":"只打印了文字，没有读取被测文件","issues":["main: 实际读取文件并断言值"]}');
    },
    fauxAssistantMessage("仍想结束"),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "真正断言文件内容" }),
    call("verify_review", {}),
    fauxAssistantMessage('{"verdict":"pass","reason":"实际读取并断言了文件内容","issues":[]}'),
    fauxAssistantMessage("完成且通过审查"),
  ]);
  await h.session.prompt("确保文件里的值为 42，并实际验证");
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "pending", "verified"]);
  expect(reportData(h).at(-1)).toMatchObject({ reviewCalls: 2, review: { verdict: "pass" } });
  const reviews = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_review");
  expect(reviews.map((m) => m.role === "toolResult" && m.isError)).toEqual([true, false]);
  expect(reviews[0].role === "toolResult" && reviews[0].usage?.totalTokens).toBeGreaterThan(0);
});

test("无效审查不放行，也不会重复调用同一份证据的审查", async () => {
  const h = await setup();
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"reviewer":"current"}');
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "检查内容" }),
    call("verify_review", {}),
    fauxAssistantMessage("大概没问题"),
    call("verify_review", {}),
    call("verify_finish", { status: "blocked", reason: "独立审查没有返回有效结论" }),
    fauxAssistantMessage("未能完成独立审查"),
  ]);
  await h.session.prompt("验证文件");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(reportData(h).at(-1)).toMatchObject({ status: "blocked", reviewCalls: 1, review: { verdict: "unavailable" } });
});

test("代码变更不能以文档不适用跳过验收", async () => {
  const h = await setup();
  h.setResponses([
    plan({ task: "docs" }),
    call("write", { path: "logic.ts", content: "export const answer = 42;" }),
    call("verify_finish", { status: "not_applicable", reason: "想跳过" }),
    call("verify_finish", { status: "blocked", reason: "尚未提供运行环境" }),
    fauxAssistantMessage("没有验收通过"),
  ]);
  await h.session.prompt("修改代码");
  const results = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_finish");
  expect(results.map((m) => m.role === "toolResult" && m.isError)).toEqual([true, false]);
  expect(reports(h).at(-1)?.status).toBe("blocked");
});

test("视觉证据协议：纯文字不得放行，真实 image 内容与运行记录可绑定", async () => {
  // 该用例直接构造 harness，必须显式让触发条件（todo 列表有未完成项）成立。
  todoState.tasks = [openTodo()];
  // 此处只测试工具协议，不把脚本化截图工具声称为真实浏览器 E2E。
  const h = await createHarness({ extensionFactories: [autoVerify, todoStub, (pi) => {
    pi.registerTool({
      name: "browser_capture", label: "Capture", description: "测试视觉结果协议",
      parameters: Type.Object({}),
      async execute() {
        return { content: [
          { type: "text", text: "已执行测试工具，返回图像" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5fUAAAAASUVORK5CYII=" },
        ], details: undefined };
      },
    });
  }] });
  harnesses.push(h);
  await h.session.bindExtensions({ shutdownHandler: () => {} });
  h.setResponses([
    plan({ surface: "web", criteria: [{ ...mainCriterion, mode: "visual" }] }),
    call("write", { path: "page.html", content: "<button>Save</button>" }),
    call("verify_run", { kind: "smoke", command: "test -f page.html", purpose: "只有文字证明" }),
    fauxAssistantMessage("完成"),
    call("browser_capture", {}),
    (context) => {
      const captured = context.messages.findLast((m) => m.role === "toolResult" && m.toolName === "browser_capture");
      if (!captured || captured.role !== "toolResult") throw new Error("缺少图像结果");
      return call("verify_evidence", { kind: "smoke", toolCallIds: [captured.toolCallId], summary: "执行并检查返回图像" });
    },
    fauxAssistantMessage("视觉证据已记录"),
  ]);
  await h.session.prompt("修改页面并检查实际界面");
  expect(reports(h).map((r) => r?.status)).toEqual(["pending", "evidence_complete"]);
  const run = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "verify_run");
  expect(run?.role === "toolResult" && run.isError).toBe(true);
});

test("独立审查期间工作区被修改，迟到的 pass 不得生效", async () => {
  const h = await setup();
  execFileSync("git", ["init", "-q"], { cwd: h.tempDir });
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"reviewer":"current"}');
  h.setResponses([
    plan(),
    call("write", { path: "answer.txt", content: "42" }),
    call("verify_run", { kind: "smoke", command: "test \"$(cat answer.txt)\" = 42", purpose: "检查当前值" }),
    call("verify_review", {}),
    async () => {
      await writeFile(join(h.tempDir, "answer.txt"), "43");
      return fauxAssistantMessage('{"verdict":"pass","reason":"旧结果曾为42","issues":[]}');
    },
    call("verify_finish", { status: "blocked", reason: "审查期间有并发修改，需要重新核对" }),
    fauxAssistantMessage("旧结果作废"),
  ]);
  await h.session.prompt("答案应为 42");
  expect(reports(h).at(-1)?.status).toBe("blocked");
  const review = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "verify_review");
  expect(review?.role === "toolResult" && review.isError).toBe(true);
  expect(reportData(h).at(-1)).toMatchObject({ criteria: [{ id: "main", status: "missing" }] });
});

test("即使反复生成新证据，每任务独立审查调用仍有上限", async () => {
  const h = await setup();
  await mkdir(join(h.tempDir, ".pi"));
  await writeFile(join(h.tempDir, ".pi/auto-verify.json"), '{"reviewer":"current","maxRounds":1}');
  const run = () => call("verify_run", { kind: "smoke", command: "printf placeholder", purpose: "仍然缺乏实际断言" });
  const concern = () => fauxAssistantMessage('{"verdict":"concern","reason":"仍然只有打印","issues":["main: 需要真实断言"]}');
  h.setResponses([
    plan(), run(), call("verify_review", {}), concern(),
    run(), call("verify_review", {}), concern(),
    run(), call("verify_review", {}),
    call("verify_finish", { status: "blocked", reason: "审查预算已耗尽，尚未完成验收" }),
    fauxAssistantMessage("未通过"),
  ]);
  await h.session.prompt("实际检查程序");
  expect(h.getPendingResponseCount()).toBe(0);
  expect(reportData(h).at(-1)).toMatchObject({ status: "blocked", reviewCalls: 2 });
  const reviews = h.session.messages.filter((m) => m.role === "toolResult" && m.toolName === "verify_review");
  expect(reviews.map((m) => m.role === "toolResult" && m.isError)).toEqual([true, true, true]);
});
