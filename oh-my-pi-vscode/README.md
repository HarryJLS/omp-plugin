# oh-my-pi-vscode

版本：`1.3.0`（以仓库内的 `oh-my-pi-vscode-1.3.0.vsix` 为准）

在 VS Code 侧边栏嵌入一个运行 `omp` 的终端面板。它不是 VS Code 内置终端：面板自己用 xterm.js + WebGL 在 webview 里渲染，通过 `@lydell/node-pty` 连接一个真实伪终端来运行 `omp`。

- 上游项目：<https://github.com/shohihul/oh-my-pi-vscode>（publisher `shohihulmaksud`，MIT）
- 本仓库只存放**已构建的 `.vsix`**，不含其源码；需要改功能请到上游，改完重新打包替换此处的 `.vsix` 并更新版本号和本文件。

## 安装

```bash
code --install-extension oh-my-pi-vscode-1.3.0.vsix
```

要求：VS Code 1.85+ 桌面版（macOS / Linux / Windows）；`omp` 已安装并可用，或在设置里指定路径。不支持 VS Code for the Web。

## 使用

打开面板：点击活动栏的 **Oh My Pi** 图标、命令面板运行 **Oh My Pi for VS Code: Open Terminal**，或按 `Cmd+Shift+Alt+I`（macOS）/ `Ctrl+Shift+Alt+I`（Windows/Linux）。编辑器内无选中内容时按 `Control+L` 也可切换侧边栏。

面板打开即启动 `omp`；手动重启用工具栏按钮或命令面板的 **Restart Terminal**。`omp` 自行退出后按任意键重新拉起。终端内 `Cmd/Ctrl+F` 打开查找栏（支持大小写、全词、正则和实时计数），`Shift+Enter` 在 `omp` 输入框内换行；URL 在外部浏览器打开，带可选 `:line` / `:line:col` 的文件路径直接在编辑器打开。

从编辑器发送代码（右键菜单或命令面板）：

| 命令 | 发送内容 |
|---|---|
| **Send Line(s) to omp** | 相对工作区的行引用，如 `path/to/file.ts:20` 或 `path/to/file.ts:20-25`，随后回车 |
| **Send Selection to omp** | 选中的原文；无选中时发送当前行 |
| **Send File Path to omp** | 相对工作区的文件路径，随后回车 |

## 配置

| 设置项 | 默认 | 说明 |
|---|---|---|
| `ohMyPi.executablePath` | `omp` | 要运行的命令。`omp` 不在 VS Code 的 PATH 上时写完整路径，支持带参数（如 `omp --flag`） |
| `ohMyPi.profile` | 空 | 以 `OMP_PROFILE` 环境变量传给 `omp`，可按工作区在 `.vscode/settings.json` 中固定；`executablePath` 里显式的 `--profile` 优先 |
| `ohMyPi.autoStart` | `false` | VS Code 启动时自动打开面板 |
| `ohMyPi.workingDirectory` | 工作区/主目录 | 传给 `omp` 的工作目录，无效路径回退到主目录 |
| `ohMyPi.panelLocation` | `primary` | 面板所在区域，供 `Control+L` 关闭：`primary`（左侧栏）、`secondary`（右侧栏）、`panel`（底部） |

`ohMyPi.panelLocation` 必须与实际布局一致：VS Code 没有查询视图位置的 API，而每个关闭命令只针对一个固定区域。

macOS 上，嵌入终端跟随 `terminal.integrated.macOptionIsMeta`（默认 `false`）。启用后 `Option+键` 作为 Meta 发送 `ESC` 前缀；若该终端把 Option 层组合成字符且 omp 的 Alt 组合键因此失效，见同仓库的 [`omp-option-chords`](../omp-option-chords/README.md)。字号、字体和配色分别跟随 `terminal.integrated.fontSize`、`terminal.integrated.fontFamily` 和当前主题的 `--vscode-terminal-*` 变量。

修改 `executablePath`、`profile` 或 `workingDirectory` 会自动重启终端。

## 限制

- 仅桌面版可用（`extensionKind: ui`），不支持 Web 版 VS Code。
- 本仓库不含源码与构建脚本，无法在此目录内重新构建；升级只能替换上游产出的 `.vsix`。
- `.vsix` 内置了 xterm 资源（`node_modules/@xterm/`），文件体积约 2.7 MB。

## 卸载

```bash
code --uninstall-extension shohihulmaksud.oh-my-pi-vscode
```

## 变更记录

见 [`CHANGELOG.md`](./CHANGELOG.md)。
