# OMP 流程对照

核对对象：本地 `oh-my-pi` 源码，2026-10-06。此扩展针对 Pi，不移植 OMP 的整个运行时。

| OMP 来源 | 已核实的实际行为 | 本扩展对应 |
|---|---|---|
| `packages/coding-agent/src/prompts/system/system-prompt.md`，Workflow/Verify | 主代理在非简单任务交付前实际运行、覆盖改变的路径；UI 验证真实界面；缺陷尽量修复前复现、修复后确认 | `verify_plan` 声明任务类型、运行表面和逐项验收；`verify_run` 运行命令；复现结果与最终结果分开保存 |
| 同文件，Delivery/completeness | 完成意味着指定的端到端行为和每个验收标准，不是能编译或缩小范围后的子集 | 每条标准必须有当前修改版本的证据；标准只能补充，不能删除或降级 |
| 同文件，Hand-off | 主代理在子代理落地后统一验证，不默认让每个子代理重复运行 | 提示词要求主代理汇总；本扩展不自动创建子代理、隔离目录或并行测试进程 |
| 同文件，yielding/evidence-and-output | 报告实际验证与阻碍；一次失败不等于不可解决 | 有限修复续跑，逐项结果；受阻和不适用不算通过 |
| `packages/coding-agent/src/session/agent-session.ts`，`#emitSessionStopEvent` | 停止钩子可附加上下文并请求继续；检查取消、会话代次；普通续跑有次数限制，子代理不走同一停止钩子 | 使用 Pi 的 `agent_before_settle`；带上下文续跑，保留其他扩展条目，取消不自动唤醒 |
| `packages/coding-agent/src/prompts/advisor/system.md` | 可选审查员针对薄弱验证、提前完成和明确遗漏提出具体意见 | 可选 `reviewer: current`，独立文本上下文审查原始要求和执行证据 |
| `docs/advisor-watchdog.md` | Advisor 需启用；额外模型用量；按最终边界审查；不重复反馈，不因自己产生的续跑无限互相触发 | 默认关闭；同一证据代次缓存审查结果；每任务最多 maxRounds+1 次审查；结果作为工具用量计入 Pi |

## 没有照搬的部分

- OMP 的默认冒烟要求来自系统提示词；未发现一个对任何项目都硬编码执行 `npm test`/E2E 的统一默认任务流水线。
- OMP 自身的 CI、安装包 smoke tests 和 `pi-iso` 不等同于用户任务交付前验证。这里没有把 OMP 项目的构建命令强加给其他项目。
- 此处的审查员只阅读证据，不具有 OMP Advisor 的独立工具会话、WATCHDOG 发现、并行队列和后台调查。它使用当前会话模型，独立请求，不执行工具。
- 结构化验收清单是针对上一版“任意成功命令即可填满 smoke 槽位”的补强，不是声称 OMP 使用相同的数据结构。
- 默认只可判定“证据齐备”；开启独立审查并通过后才标记“审查通过”。两者都不能保证测试覆盖完备或程序不存在缺陷。
