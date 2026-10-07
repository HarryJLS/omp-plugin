# pi-auto-verify

版本：`0.3.0`。面向 **Pi 1.0.4 及其兼容版本**，不是 OMP 插件。

把 OMP 的“实际运行、覆盖全部验收要求、缺陷修复前后对照、必要时独立审查”的流程带到 Pi。无需用户每次输入测试命令或手写验收清单；当前代理负责从任务中提取要求并选择验证方式。

上一版只有 smoke/e2e 两个证据槽位，无法区分“测试过一个点”和“每条要求都有证据”。本版按验收条目记录，不再仅凭任意一条成功命令填满一个槽位。完整来源和差异见 [OMP 流程对照](docs/omp-mapping.md)。

## 触发条件

结束前的检查由 **todo 列表**决定，与 OMP 的 `todo.checkCompletion` 对齐，和文件修改无关。两个判断是分开的：

- **是否介入**：本任务是否用 todo 列表跟踪过（出现过含任务的 `todo` 快照）。没有用过 todo 的任务——简单问答、只改了几个文件的小任务——结束时不写报告、不提示，也不续跑，**即使修改了文件或声明过验收计划**。
- **是否强制续跑**：只有列表里仍有 `pending` / `in_progress` 时才在缺少证据时自动继续，默认最多 3 次。全部 `completed` 或被 `clear` 清空后不再续跑，但仍会登记最终结论：证据齐备记 `evidence_complete`（开启审查并通过记 `verified`），缺失记 `unverified` 并写明原因是 todo 已无未完成项。
- 每个用户任务开始时重置，同一会话里上一个任务用过 todo 不会让下一个任务被检查。

因此请把验证本身作为 todo 列表中的一项，在实际运行并记录证据之后再标记完成；不要为了早点结束而提前清空列表。用 `/auto-verify status` 可以看到本次的触发条件。

## 工作方式

1. 代理通过 `verify_plan` 声明任务类型、运行表面和 1 到 12 条具体标准。已有标准只能补充，不能删除、改写或降低。
2. 缺陷任务在修改前用 `verify_run` 的 `phase: reproduce` 记录真实失败；来不及或不能复现时必须明确写明限制。
3. 代理修改代码，自主寻找已有测试、运行真实程序或操作浏览器。
4. `verify_run` 通过原有 `bash` 工具运行；`criteria` 指明覆盖哪些验收编号。结果保存实际命令、输出摘要、工作区版本和编号，不只保存代理自述。
5. `verify_evidence` 可引用已有工具结果。视觉标准同时要求实际运行和工具真实返回的图像，只有文字不能放行。
6. `agent_before_settle` 按条目检查，新修改使旧证据失效；缺失则自动继续，默认最多 3 次。这一步只在 todo 列表仍有未完成项时执行（见上文触发条件）。
7. 开启独立审查时，通过 `verify_review` 把原始要求和实际证据交给当前模型的独立文本上下文。具体遗漏返回主代理补测；无效或失败响应不算通过。
8. 最终区分证据齐备、独立审查通过、受阻、不适用和次数耗尽，保存逐项报告。

参考 OMP 的 Verify、Delivery、`session_stop` 和可选 Advisor；没有照搬它的项目 CI、完整后台审查运行时或与验证无关的删除规则。

## 安装

这是本地包，尚未发布到 npm。进入希望启用它的项目，然后执行：

```bash
pi install -l /Users/harry/study/code/ai/omp-plugin/pi-auto-verify
```

在已经打开的 Pi 会话中执行 `/reload`，之后正常发送任务即可。项目扩展须在项目受信任后加载。

一次性试用，不修改安装配置：

```bash
pi -e /Users/harry/study/code/ai/omp-plugin/pi-auto-verify/src/index.ts
```

不要同时启用 pi-sentinel 或 pi-project-profile 的自动验证循环。

## 配置

默认无需配置。可在**运行 Pi 的项目目录**放置 `.pi/auto-verify.json`：

```json
{
  "enabled": true,
  "maxRounds": 3,
  "timeoutSeconds": 120,
  "requireE2E": false,
  "reviewer": "off"
}
```

- `enabled`：默认开启；配置每个新用户任务重新读取。
- `maxRounds`：结束前最多自动续跑次数，1 到 10；不是整个模型任务的工具调用上限。
- `timeoutSeconds`：每个 `verify_run` 命令的超时，1 到 1800 秒。
- `requireE2E`：有修改的任务是否同时需要 smoke 和 E2E；默认由代理根据变化选择必要的 E2E。
- `reviewer`：`off` 默认不增加独立模型调用；`current` 用当前会话模型的独立上下文审查最终证据。使用相同模型和提供商，不自动选择其他模型。
- `/auto-verify status`：查看当前状态、逐项结果和当前的触发条件（todo 未完成项数）；`on`、`off`：当前会话开关，`on` 从下一任务生效。

配置错误会明确提示并停止启用，不会猜测或执行默认测试命令。扩展没有运行时第三方依赖；Pi 提供宿主 API 和类型库。

独立审查每次最多 2048 输出 token、120 秒（同时受 `timeoutSeconds` 限制），每任务最多 `maxRounds + 1` 次。同一证据代次缓存审查结论，避免重复请求；新增验证或工作区变化使结论过期。额外模型用量通过工具结果计入 Pi。原始要求超过 8000 字符时不截断后放行，而是明确报告无法完整审查。证据摘要输入上限 24000 字符，省略部分标为未知。

开启独立审查仍是概率性的模型评估，不是数学证明，也不等同于 OMP Advisor 可自行调用调查工具的完整能力。

## 工具协议

这些工具由代理自动调用，用户无需手工编排。

| 工具 | 关键字段 | 含义 |
|---|---|---|
| `verify_plan` | `task`、`surface`、`criteria` | `task` 为 change/bug/investigation/docs；`surface` 为 cli/api/web/native/library |
| 验收条目 | `id`、`description`、`kind`、`mode` | id 唯一；kind 为 smoke/e2e；mode 为 runtime/visual；Web/native 必须含 visual |
| `verify_run` | `kind`、`criteria`、`command`、`purpose` | `criteria` 是验收 id 数组；命令应含实际行为检查，不是无关打印 |
| 修复前复现 | `phase: reproduce`、`expectedFailure` | 必须在第一次修改前，真实非零退出且输出含指定诊断；126 及以上退出码不充当缺陷复现 |
| `verify_evidence` | `kind`、`criteria`、`toolCallIds`、`summary` | 引用当前任务真实成功工具结果；过期或不存在的编号会被拒绝 |
| `verify_review` | 无 | 证据齐备后执行可选独立文本审查；审查员没有工具权限 |
| `verify_finish` | `status`、`reason` | blocked 或 not_applicable，均不算通过 |

同一个 bug 任务的修复前证据跨修改保留，修复后证据每次改动都失效。未复现时用计划字段 `baselineUnavailableReason` 写明具体原因，不可在修复后补造“修复前失败”。

## 示例与范围

正常告诉 Pi：“修复这个 CLI 对空文件的处理，验证后再结束。”代理应选择相关命令，通过 `verify_run` 运行，失败后修复并重试。无需用户自己调用验证工具。

Web 任务应操作真实页面和关键交互，并检查结果。已有浏览器、Playwright、computer 等工具返回的成功结果会附带证据编号，可由代理引用。命令生成截图时，还需用 `read` 打开图像并引用该结果；只有截图路径不够。**本扩展不附带浏览器，也不会自动安装 Playwright 或 Docker。** 没有工具或服务时应报告受阻。

若用它开发 Pi 源码，应遵守该仓库 AGENTS.md：不默认执行 `npm test`、构建或真实提供商接口；优先针对性测试，完整常规测试使用仓库的 `./test.sh`。扩展不硬编码全量测试。

## 限制

- 默认 `evidence_complete` 只表示逐项执行证据齐备，不等于独立审查通过；开启审查并通过才标记 `verified`。退出码、图像存在和结构化清单仍不能证明测试充分。默认模式不能在语义上排除“把 echo 标为某条标准的验证”；可选审查专门质疑此类情况，但不能保证识别全部伪验证。
- 清单、任务类型、表面和复现限制由主代理从要求中提取，不是编译器推导的事实。审查员会对照原始要求，但它只有文本证据，不独立读取完整源码或查看截图。
- `blocked`、`not_applicable`、次数耗尽都会明确显示未通过，而不是永久锁死用户。用户始终可以取消或关闭扩展。
- 触发条件按**本任务**判断，不看文件修改：是否介入取决于本任务有没有用 todo 列表跟踪过（出现过含任务的快照），是否强制续跑取决于是否仍有 `pending`/`in_progress`。状态在每个用户任务开始时重置，同一会话里上一个任务的 todo 不会影响下一个任务。只调用过空列表不算用过 todo；判定沿用 rpiv-todo 的状态与 `details.tasks` + `nextId` 快照形状，`completed` 与 `deleted` 墓碑不计入，其它 todo 实现、子代理或自定义工具的写入不会被识别。`not_applicable` 只允许已知修改限于 Markdown/RST/AsciiDoc 的 docs 任务，代码、配置及未知 shell 修改不能这样跳过。
- Git 仓库比较未提交内容（包含已有脏文件内容变化及未跟踪文件），不只比较文件名。忽略文件不在快照范围；未跟踪文件上限 2000 个/16 MiB，超限报告受阻。
- 非 Git 目录依赖编辑工具事件，普通 shell 操作保守地认为可能修改文件；外部进程或自定义工具的隐蔽写入无法完整追踪。
- 验证期间修改源码会使本次证据失效。临时产物应放临时目录或已忽略目录。无法防止并发进程在快照间写入并恢复相同内容。
- 检查配置只在新任务读取；工具必须在当前 Pi 会话可用。当前任务内证据不跨重载、会话切换或新用户任务复用。
- 结构化报告记录在 Pi 会话的 `auto-verify/report` 条目中，包含逐项状态、输入输出摘要、复现和审查结论；不额外导出完整轨迹。每份输出摘要最多 6000 字符，正文截断有标记。

## 开发验证

状态机、配置和真实 Git 工作区测试：

```bash
cd /Users/harry/study/code/ai/omp-plugin/pi-auto-verify
npm test
```

真实 Pi 会话集成测试使用本地 Pi 源码的官方测试 harness 和 faux provider，不需要真实模型、API 密钥或付费调用：

```bash
PI_SOURCE_DIR=/Users/harry/study/code/ai/pi npm run test:integration
PI_SOURCE_DIR=/Users/harry/study/code/ai/pi npm run check
```

需要该 Pi 源码已安装开发依赖；不自动安装依赖、不修改 Pi 源码。

测试包含状态/配置/Git/审查协议，以及真实 Pi 会话集成：加载本地扩展、真实 shell 断言失败后修复、缺陷前后对照、本地 HTTP E2E、逐项遗漏、禁止缩小清单、可选审查退回及重审、用量归属、超时、权限拦截和用户取消。触发条件有专门用例：没有 todo 列表时改文件不介入、todo 全部完成时不再续跑但仍登记结论、关闭 todo 后证据齐备仍记通过、仍有未完成项时续跑并列出条目、同一会话的下一个任务不继承上一个任务的 todo 状态；`src/todo.ts` 另有与 rpiv-todo 形状判定一致的解析单元测试。视觉测试覆盖工具的 image 证据协议，不冒充真实浏览器 E2E。模型响应使用 faux provider，未调用付费模型；不能据此保证真实模型的测试选择或审查质量。

0.3.0 已在本机 macOS、Node 26.10.0、Pi 1.0.4 源码上通过 27 项单元/工作区测试、28 项真实会话集成测试、类型检查和静态检查。

## 卸载

在启用它的项目执行：

```bash
pi remove -l /Users/harry/study/code/ai/omp-plugin/pi-auto-verify
```

然后 `/reload`。如手动创建过 `.pi/auto-verify.json`，可单独删除；扩展不删除项目文件。
