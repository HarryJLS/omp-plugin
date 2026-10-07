# omp-plugin

本仓库存放与 [oh-my-pi](https://github.com/can1357/oh-my-pi)（`omp`）及 [Pi](https://github.com/earendil-works/pi) 配套的扩展（extension）、插件（plugin）和工具。两者的扩展接口不同，安装前请确认组件的适用范围。

每个子目录是一个独立组件，各自维护自己的 `README.md`、版本号和变更记录。新增、修改、提交时必须遵守 [`AGENT.md`](./AGENT.md)。

## 组件索引

| 目录 | 类型 | 版本 | 用途 |
|---|---|---|---|
| [`omp-option-chords/`](./omp-option-chords/README.md) | omp 插件 | 0.1.0 | 在把 Option+键组合成字符的终端（Warp、Terminal.app 等）里恢复 omp 的 Alt 组合键 |
| [`omp-auto-update/`](./omp-auto-update/README.md) | omp 插件 | 0.1.0 | 启动后在后台通过 `proxyon` 静默执行 `omp update`，最多每 24 小时检查一次 |
| [`omp-safe-edit/`](./omp-safe-edit/README.md) | omp 扩展 | 0.1.0 | 用内容锚定工具替换内置 `edit`：`ctx_patch` 对齐 Codex 补丁行为；`str_replace` 保留唯一匹配与 `write` 覆盖保护 |
| [`pi-auto-verify/`](./pi-auto-verify/README.md) | Pi 扩展 | 0.3.0 | OMP 风格的逐项验收、修复前后对照、实际冒烟/E2E 与可选独立审查；结束前的检查由 todo 列表触发 |
| [`oh-my-pi-vscode/`](./oh-my-pi-vscode/README.md) | VS Code 扩展 | 1.3.0 | 在 VS Code 侧边栏里嵌入运行 `omp` 的终端面板（预打包 `.vsix`） |

## 通用约定

- 每个组件目录必须有自己的 `README.md`，说明用途、安装、配置、限制和卸载方式。
- 每个组件必须维护版本号（优先语义化版本），并保留该版本的变更摘要。
- 每次提交同步更新受影响的 `README.md`、版本号和变更记录；本项目结构或组件列表变化时同时更新本文件。
- 不提交临时文件、依赖目录、日志和未说明用途的构建产物（忽略规则见 `.gitignore`）。

## 组件差异速查

- `omp-option-chords`、`omp-auto-update` 通过 `install.sh` 安装成 `~/.omp/plugins/node_modules/<name>` 下的固定副本，改源码后必须重跑安装脚本。
- `omp-safe-edit` 是直接拷贝到 `~/.omp/agent/extensions/`（或项目内 `.omp/extensions/`）的独立扩展文件；两个工具二选一安装。
- `pi-auto-verify` 通过 `pi install -l <本地目录>` 安装到 Pi 项目，不使用 OMP 的插件目录。
- `oh-my-pi-vscode` 以已构建的 `.vsix` 形式存放，仓库内不含其源码（上游：<https://github.com/shohihul/oh-my-pi-vscode>）。
