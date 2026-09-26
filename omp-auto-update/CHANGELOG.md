# 变更记录

遵循语义化版本。日期为 `YYYY-MM-DD`。

## [0.2.0] - 2026-09-26

按新设计重写：扩展不再镜像 omp 的启动版本检查，版本判断完全交给 `omp update` 自身。`session_start` 只负责派生分离的代理 shell 运行 `omp update`（无新版本时它自行 no-op），目录锁、24 小时频控、代理阶梯、日志重定向全部保留。

- 移除全部 omp 内部运行时依赖：不再导入 `VERSION` / `getLatestRelease` / `settings` / `modes/settings`，`ExtensionAPI` 改为 type-only import（编译期擦除）。此前三次跨版本崩溃（0.1.0 的描述符 import 在 18.3.0 桥接层未注册、0.1.1 的 `settings.get()` 在 18.3.2 被移除、settings API 三代形态切换）全部源于这些内部导入，此设计下不可能重演。
- 代价（有意为之）：新版本的自动安装最多延迟 24 小时被发现（`omp update` 每天最多真跑一次）；不再跟随 `startup.checkUpdate` 开关（`omp update` 本身不受该开关约束）。
- 0.1.2 曾实现的分层设置读取（描述符 → 字符串路径 → schema 默认值）整体删除，不再需要。

## [0.1.2] - 2026-09-26

修复 omp 18.3.2 下的 `settings.get is not a function` 崩溃。完整根因是 omp 的 settings API 跨版本换了形态：18.3.2 把字符串路径的 `settings.get("...")` 换成了 `modes/settings` 里的类型化设置描述符（`cfgStartupCheckUpdate.get(settings)`），而 0.1.0 的原始代码用的正是描述符 API——它只在 18.3.0 下因桥接层未注册该子路径而失败。0.1.1 把它"修"成了 18.3.0 的字符串路径 API，结果扩展自动把 omp 升到 18.3.2 后再次崩掉。两台机器一好一坏也是同一原因：直接装 18.3.2 的机器跑原始描述符代码正常，本机装的是 18.3.0。

本版本按代分层读取，任何一层失败只降级不崩溃：

1. 当前 omp：动态导入 `modes/settings`，`cfgStartupCheckUpdate.get(settings)` / `cfgUpdateChannel.get(settings)`（动态是为了避免旧版本静态导入直接把扩展加载打死）。
2. 18.3.0 及更早：字符串路径 `settings.get(...)`。
3. 都不可达：schema 默认值（`startup.checkUpdate=true`、`update.channel=stable`）并记一条日志。

`session_start` 回调对 `checkAndUpdate` 补充兜底 catch，任何未知异常只进 `~/.omp/logs/auto-update.log`，不再以 unhandled rejection 打进会话终端。

## [0.1.1] - 2026-09-26

修复安装后扩展无法加载的问题：`@oh-my-pi/pi-coding-agent/modes/settings` 子路径并不存在（`cfgStartupCheckUpdate` / `cfgUpdateChannel` 两个导出在任何版本中都找不到），导致 omp 18.3.0 编译二进制里的 legacy-pi 兼容层解析失败，报 `Cannot find package '@oh-my-pi/pi-coding-agent'`。改为与 omp 自身启动检查（`main.ts`）完全一致的 `settings.get("startup.checkUpdate")` 与 `settings.get("update.channel")`（`config/settings` 子路径已验证可解析）。

同一轮修复：`ExtensionContext` 没有 `agent` 字段，原 `ctx.agent.kind !== "main"` 守卫在 `session_start` 处理器里必然抛 TypeError，导致后续日志与检测全部不执行。已删除该守卫——子代理会话本就不加载用户扩展，模块级 `scheduled` 标志已保证每进程只检测一次。

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
