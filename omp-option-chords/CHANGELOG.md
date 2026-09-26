# 变更记录

遵循语义化版本。日期为 `YYYY-MM-DD`。

## [0.1.0] - 2026-09-26

初始版本：

- 在 `session_start` / `session_switch` 时注册终端输入改写，在 `session_shutdown` 时注销。
- 按 macOS 美式布局的 Option 层输出映射回 `ESC` + 键的转义序列，覆盖 `alt`、`alt+shift` 单键组合键。
- 只改写当前 keybindings 实际绑定了动作的组合键；未绑定的组合键继续输入原字符。
- 拒绝改写任何含控制字节的输入块，粘贴和转义序列不受影响。
- 新增 `install.sh`：把插件打包成 `~/.omp/plugins/node_modules/omp-option-chords` 下的固定副本，并同步 omp 的 `package.json` 依赖与 `omp-plugins.lock.json`。
