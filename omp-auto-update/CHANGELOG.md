# 变更记录

遵循语义化版本。日期为 `YYYY-MM-DD`。

## [0.1.0] - 2026-09-26

初始版本：

- 复用 omp 自身的启动版本检测：`startup.checkUpdate`、`update.channel`、`getLatestRelease()` 与 `Bun.semver.order` 判断，只有 omp 会提示新版本时才动作。
- 判定有新版本后派生分离的交互式 zsh（`/bin/zsh -ic`），依次执行 `proxyon` 与 `omp update`，复用用户 shell 中的代理 alias。
- 更新进程独立会话、不继承文件描述符，输出自行重定向到日志：会话内无任何输出，也不等待其结束。
- 代理按阶梯解析：`proxyon` → 环境现有代理变量（`PI_PROXY` / `http_proxy` / `https_proxy` / `all_proxy`）→ 仅告警并照常执行，不再因缺 `proxyon` 以 127 退出。
- 检测失败（超时、registry 异常）时回退到代理 shell 内的 `omp update`，由其自行复核，无新版本即无操作。
- 仅在主会话执行；`session_start` 后延迟 1.5 秒，避免拖慢首帧。
- 用 `~/.omp/cache/omp-auto-update/last-attempt` 记录最近尝试时间，更新尝试最多每 24 小时一次；失败同样计入，避免每次启动反复重试。
- 用 `~/.omp/cache/omp-auto-update/run.lock` 的目录锁避免多个 omp 会话并发更新，持有者进程已消失时自动回收。
- 后台输出写入 `~/.omp/logs/auto-update.log`；每次会话记录一行检测结果（含 `up to date`），可作为扩展是否加载的判据；已是最新版本时不写任何缓存状态。
- 新增 `install.sh`：把固定副本安装到 `~/.omp/plugins/node_modules/omp-auto-update`，不依赖本仓库路径。
