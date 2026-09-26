# 变更记录

版本号跟随上游项目的发布版本，本仓库以 `.vsix` 文件名中的版本为准。日期为 `YYYY-MM-DD`。

## [1.3.0] - 2026-09-26

纳入本仓库的版本（上游 <https://github.com/shohihul/oh-my-pi-vscode>）：

- 在活动栏提供 **Oh My Pi** 面板，用 xterm.js + WebGL 在 webview 内渲染终端，通过 `@lydell/node-pty` 连接真实伪终端运行 `omp`；
- 命令 `ohMyPi.open` / `ohMyPi.restart` / `ohMyPi.search` / `ohMyPi.sendLines` / `ohMyPi.sendSelection` / `ohMyPi.sendFile` 与 `ohMyPi.sendSelectedLinesOrToggle`；
- 配置项 `ohMyPi.executablePath`、`ohMyPi.profile`、`ohMyPi.autoStart`、`ohMyPi.workingDirectory`、`ohMyPi.panelLocation`；
- 查找栏支持大小写、全词、正则与实时计数，URL 与文件路径（含 `:line` / `:line:col`）可点击；
- 终端配色跟随 VS Code 主题的 `--vscode-terminal-*` 变量，macOS 上跟随 `terminal.integrated.macOptionIsMeta`。
