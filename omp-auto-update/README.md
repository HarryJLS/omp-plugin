# omp-auto-update

后台自动更新 omp，省掉每次看到 “Update Available — run: omp update” 提示后手动执行 `proxyon` + `omp update` 的步骤。

## 触发方式

版本判断完全交给 omp 自己：`session_start` 后派生一个分离的交互式 zsh，在其中执行 `omp update`。`omp update` 内部就是 omp 自身的版本检查与更新（同一 registry、同一 `update.channel` 设置）——有新版本才执行更新，没有新版本就什么都不做。扩展不读任何 omp 内部设置、不调用任何检查 API，运行时对 omp 内部模块零依赖（`ExtensionAPI` 是 type-only import，编译期擦除），omp 内部 API 换形态不会影响本扩展：

```zsh
proxyon
omp update
```

`proxyon` 是交互式 shell 里的 alias，因此后台进程用 `/bin/zsh -ic` 启动。代理按阶梯解析，任一档可用即可，不会因为缺 `proxyon` 直接失败：

1. 存在 `proxyon` → 执行它（用户自己的 alias 最权威）。
2. 不存在但环境里已有代理（`PI_PROXY` / `http_proxy` / `https_proxy` / `all_proxy`，大小写皆可）→ 直接用现成的。
3. 两者都没有 → 记一条告警日志，仍然执行 `omp update`（可能超时，但不会静默跳过）。

## 行为细节

- 每进程只派生一次（子代理会话不加载用户扩展，模块级 `scheduled` 标志防重入）；`session_start` 后延迟约 1.5 秒，不拖慢首帧。
- `omp update` 每天最多真正运行一次（`last-attempt` 时间戳频控），因此新版本的自动安装最多延迟 24 小时被发现；其余会话里 shell 只写一行 skipped 后退出。
- 是否更新、走哪个发布通道，全部由 `omp update` 自行判定；无新版本时它什么都不做，不碰 Homebrew。
- 更新进程完全脱离：独立会话（`setsid`）、不继承任何文件描述符，脚本自己把输出重定向到 `~/.omp/logs/auto-update.log`。会话里不打印任何内容，也不会等待它结束。
- 实际更新在分离进程中运行，因此本次会话不受影响：新版本从下次启动生效。
- 目录锁 `run.lock` 保证多个 omp 会话不会并发更新；锁持有者 PID 已消失时自动回收。
- 尝试时间戳 `last-attempt` 让失败的安装在 24 小时内只重试一次，而不是每次启动都重试。
- 每次会话在 `~/.omp/logs/auto-update.log` 记一行 `session started …`（扩展是否被加载的证据），其后是 shell 自身输出：`omp update` 的完整 stdout/stderr（`Current version …` / brew 更新过程或 no-op 结果）与频控 `skipped` 行。

## 前提

- `proxyon` 与 `omp update` 不需要交互输入。
- 建议存在 `proxyon`（或环境里已有代理变量）；缺失时按上面的阶梯降级，而不是报错退出。
- 后台 shell 能访问 registry（`omp update` 自身的检查也是同一条件）。

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
