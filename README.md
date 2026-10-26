# Mouse Click

[![Windows build](https://github.com/sand-web/mouse-click/actions/workflows/windows.yml/badge.svg)](https://github.com/sand-web/mouse-click/actions/workflows/windows.yml)
[![License](https://img.shields.io/github/license/sand-web/mouse-click)](./LICENSE)

跟随鼠标的阅读光圈。可以随时调节大小，并记住上次设置。

本项目基于 Harry Hou 的 [Cursor Highlight](https://github.com/Hazyzh/cursor-highlight) 修改，保留原作者历史与 MIT 许可证。

## 下载与使用

从 [Releases](https://github.com/sand-web/mouse-click/releases) 下载。Windows 版面向 Windows 10/11 的 Intel/AMD 64 位电脑；当前构建与验收状态以版本说明为准。

- **Setup.exe**：安装版，适合日常使用；按向导安装后从桌面或开始菜单启动。
- **Portable.exe**：便携版，下载后双击运行。
- macOS 已有本地验收版本；本次 Windows 发布不代表提供了新的 Mac 安装包。

应用运行后，在系统托盘菜单选择 **光圈大小…**，也可按 **Ctrl+,**（Windows）或 **⌘,**（Mac）打开设置。

1. 拖动滑块，或在“精确输入”中填写数值后按回车。
2. 半径范围为 **20–300**，数值越小，光圈越小；调整后立即生效并自动保存。
3. 点击“开启光圈”或“收起光圈”。默认使用阅读模式，鼠标可以正常滚动、点击、选中文字和拖动滚动条，光圈大小保持不变。
4. 通过托盘菜单 **Quit / 退出 Mouse Click** 完全退出。

需要绘画时，从托盘或应用菜单选择 **绘画模式**；绘画完成后选择 **阅读模式（可翻页、点击）** 返回正常阅读。大小统一在“光圈大小”窗口调整，滚轮不再是大小快捷键。

**Alt+X** 切换光圈（Mac 为 **Option+X**）；绘画模式下 **Esc** 收起光圈。阅读模式不占用底层应用的鼠标和键盘，Esc 交给正在阅读的软件。

Windows 1.0.5 同步阅读模式；旧 v1.0.4 不包含这项改动。版本的实际构建与验收状态请查看对应 Releases 说明。快捷键和窗口层级仍需在自己的 Windows 电脑上实际确认，CI 自动检查不能替代个人电脑验收。

## Windows 构建与检查

使用 Node.js 24 和 Yarn 1.22.22：

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build:windows
```

Windows 构建必须在 Windows 中执行；GitHub Actions 提供 Windows Server 2022 环境。它生成安装版、便携版和 `SHA256SUMS.txt`，并检查真实生产包及单独的运行测试包。

安装和运行验收脚本只允许在一次性 GitHub-hosted runner 中执行。它们会静默安装测试应用并清理测试启动项；个人 Windows 电脑直接安装发布版体验即可，不运行 `yarn test:windows`。

工作流另行构建独立阅读测试窗口，使用 Windows 全局系统输入检查页面滚动、点击、文字拖选、滚动条和快捷键，并同时检查光圈半径与保存文件不变。无光圈正对照和绘画模式负对照用于确认输入确实经过系统窗口路由；未收到真实页面结果或没有交互桌面均视为验证失败。`test:windows` 需要工作流先准备已核对摘要的 v1.0.4 基线文件。

正式包只包含应用文件和许可证，不包含测试入口、本机日志或开发依赖。运行检查的证据保存在 Actions 的 `windows-test-evidence` 产物中，安装包为 `mouse-click-windows-x64`。Releases 仅在检查后发布。

Electron 与 electron-builder 沿用上游锁定版本；没有为本次移植升级整套框架。Windows 使用独立应用身份，Mac 本地构建入口 `scripts/build-local.cjs` 保留。

## 源码与许可证

本仓库提供大小设置、即时同步、保存失败反馈和真实文件测试。`node_modules`、安装包、本机验收目录与个人路径不提交到仓库。

原项目作者：Harry Hou / Hazyzh。原始演示：

![Cursor Highlight 原始演示](./readmeStatic/cursor_highlight_demo.gif)

依据 [MIT LICENSE](./LICENSE) 使用、修改和分发时，请保留版权与许可证文本。
