# omp-option-chords

版本：`0.1.0`（见 `package.json`）

在把 `Option+键` 组合成字符的终端里，恢复 omp 的 Alt 组合键。

## 问题

Warp、macOS 的 Terminal.app，以及关闭了 "Option as Meta" 的 iTerm2，都不会发送 `Alt+P` 的转义序列：终端先套用 macOS 键盘布局的 Option 层，所以 `Option+P` 到达程序时是单个字符 `π`，`Option+M` 是 `µ`，依此类推。omp 把 `alt+p` / `alt+m` / `alt+shift+p` 等绑定为编辑器动作组合键，这些被组合出来的字符因此落到普通文本输入里，快捷键看起来"被吞了"。

## 做法

扩展监听原始终端输入——TUI 会在焦点编辑器之前把它派发给扩展——并把组合字符改写回终端在开启 Meta 时会发送的转义序列（`alt+p` → `ESC p`，`alt+shift+p` → `ESC P`）。编辑器随后通过正常的 keybinding 路径匹配组合键，因此用户自定义重映射依然生效。

改写是有条件的：

- 只有当该组合键当前仍绑定到某个应用动作时才改写；未绑定的组合键继续输入原字符。
- 只处理单字符按键；粘贴和转义序列以含控制字节的块到达，永不改写。
- 每个会话开始时重新解析一次 keybindings，因此对 `keybindings.yml` 的修改从下一个会话生效。

当前映射表（前为 Option 层输出，后为对应组合键）：`π` → `alt+p`、`∏` → `alt+shift+p`、`µ` → `alt+m`、`¬` → `alt+l`、`Ò` → `alt+shift+l`、`ç` → `alt+c`、`Ç` → `alt+shift+c`、`å` → `alt+a`、`®` → `alt+r`、`√` → `alt+v`、`◊` → `alt+shift+v`。映射按 macOS 美式布局，与 omp 默认的 Alt 绑定一致。

## 安装

```bash
cd omp-option-chords
./install.sh
```

`install.sh` 会把插件打包成真实副本安装到 `~/.omp/plugins/node_modules/omp-option-chords`，并写入 omp 的 `package.json` 依赖与 `omp-plugins.lock.json`，不留下指回本仓库的符号链接。这样做的原因：omp 自带的安装途径都无法从本地目录产生副本——`omp plugin install <dir>` 总是建符号链接，而 `omp plugin install <tarball>` 会因为前导 `/` 或 `file:` 被判定为包名而拒绝（"Invalid package name"）。

注意：

- 安装副本在打包时被冻结，**修改 `src/` 后必须重跑 `install.sh`**。
- 打包用 `tar` 解包而不是 `bun install`：bun 以路径为键缓存 `file:` 依赖，同版本号重新打包会静默复用旧解压结果。
- 安装目录可用 `OMP_PLUGINS_DIR` 覆盖，默认 `~/.omp/plugins`。
- 脚本末尾会执行 `omp plugin doctor` 做一次自检。

## 配置

无需配置项，也不读取环境变量。映射表按代码中的 `COMPOSED_CHORDS` 与当前 keybindings 的交集决定；改映射需要改 `src/index.ts`。

## 限制

- 只覆盖映射表中列出的按键，且要求对应组合键已被绑定。新增绑定需要同时补映射表。
- 只适用于因 Option 组合而产生单字符的终端；已经发送 `ESC` 前缀的终端不受影响，也不需要此插件。
- 映射表按 macOS 美式布局硬编码，其他键盘布局的 Option 层输出不匹配。
- 依赖 TUI 将原始输入先派发给扩展的行为（`ctx.ui.onTerminalInput`），并要求会话有 UI（`ctx.hasUI`）。

## 卸载

```bash
rm -rf ~/.omp/plugins/node_modules/omp-option-chords
```

并从 `~/.omp/plugins/package.json` 的 `dependencies` 和 `~/.omp/plugins/omp-plugins.lock.json` 的 `plugins` 中删除 `omp-option-chords` 条目，同时删除 `~/.omp/plugins/bun.lock`。

## 变更记录

见 [`CHANGELOG.md`](./CHANGELOG.md)。
