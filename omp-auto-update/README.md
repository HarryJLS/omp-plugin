# omp-auto-update

后台自动更新 omp，省掉每次看到 “Update Available — run: omp update” 提示后手动执行 `proxyon` + `omp update` 的步骤。

## 触发方式

复用 omp 自己启动时的版本检测，不引入额外的轮询策略：

| 决策依据 | 来源 |
| --- | --- |
| 是否启用启动检查 | 设置 `startup.checkUpdate`（用户关掉则本扩展也不检查） |
| 发布通道 | 设置 `update.channel`（`stable` / `canary`） |
| 最新版本 | `getLatestRelease()` —— omp 启动检查调用的同一个函数 |
| 是否需要更新 | `Bun.semver.order(latest, VERSION) > 0`，与 omp 启动检查同一判断 |

即：只有 omp 会弹出 “Update Available” 的那种情况下才会动手。判定为新版本后，扩展派生一个分离的交互式 zsh，在其中执行：

```zsh
proxyon
omp update
```

`proxyon` 是交互式 shell 里的 alias，因此后台进程用 `/bin/zsh -ic` 启动。代理按阶梯解析，任一档可用即可，不会因为缺 `proxyon` 直接失败：

1. 存在 `proxyon` → 执行它（用户自己的 alias 最权威）。
2. 不存在但环境里已有代理（`PI_PROXY` / `http_proxy` / `https_proxy` / `all_proxy`，大小写皆可）→ 直接用现成的。
3. 两者都没有 → 记一条告警日志，仍然执行 `omp update`（可能超时，但不会静默跳过）。

## 行为细节

- 只在主会话执行（子代理会话跳过）；`session_start` 后延迟约 1.5 秒再开始，不拖慢首帧。
- 检测在 omp 进程内完成（5 秒超时），走的是 omp 自己的网络路径。检测失败（超时、registry 异常、代理缺失）时不放弃：改为在代理 shell 里执行 `omp update`，由它自己复核，没有新版本就什么都不做。
- 更新进程完全脱离：独立会话（`setsid`）、不继承任何文件描述符，脚本自己把输出重定向到 `~/.omp/logs/auto-update.log`。会话里不打印任何内容，也不会等待它结束。
- 实际更新在分离进程中运行，因此本次会话不受影响：新版本从下次启动生效。
- 目录锁 `run.lock` 保证多个 omp 会话不会并发更新；锁持有者 PID 已消失时自动回收。
- 尝试时间戳 `last-attempt` 让失败的安装在 24 小时内只重试一次，而不是每次启动都重试。
- 每次会话在 `~/.omp/logs/auto-update.log` 记一行检测结果（`session started …` + `up to date …` / `new release …` / `version check failed …`），日志本身就是「扩展是否被加载」的证据；已是最新版本时不写任何缓存状态。

## 前提

- `proxyon` 与 `omp update` 不需要交互输入。
- 建议存在 `proxyon`（或环境里已有代理变量）；缺失时按上面的阶梯降级，而不是报错退出。
- omp 进程能访问 registry（omp 自身的启动检查也是同一条件）。

## 安装

```bash
cd omp-auto-update
./install.sh
```

安装脚本把固定副本解包到 `~/.omp/plugins/node_modules/omp-auto-update` 并写入 omp 的插件清单，不依赖此仓库路径。修改源码后需重新执行。

## 状态与排错

- 后台输出：`~/.omp/logs/auto-update.log`
- 最近一次尝试时间：`~/.omp/cache/omp-auto-update/last-attempt`
- 并发锁：`~/.omp/cache/omp-auto-update/run.lock`

想立刻重试：删除 `last-attempt` 后重启 omp。日志里出现 `proxyon is not defined in the interactive zsh environment` 说明 rc 文件里的 `proxyon` 在非交互模式下不可见（例如写进了 `.zshrc` 之前的守卫分支）。
