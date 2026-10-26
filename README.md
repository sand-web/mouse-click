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
3. 点击“开启光圈”或“收起光圈”。在光圈上滚动鼠标滚轮也能调整大小。
4. 通过托盘菜单 **Quit / 退出 Mouse Click** 完全退出。

上游保留的操作还有 **Alt+X** 切换光圈、**Esc** 收起光圈，以及鼠标左键绘画。快捷键和窗口层级仍需在自己的 Windows 电脑上实际确认，CI 自动检查不能替代个人电脑验收。

## Windows 构建与检查

使用 Node.js 24 和 Yarn 1.22.22：

```sh
yarn install --frozen-lockfile
yarn typecheck
yarn test
yarn build:windows
yarn test:windows
```

Windows 构建必须在 Windows 中执行；GitHub Actions 提供 Windows Server 2022 环境。它生成安装版、便携版和 `SHA256SUMS.txt`，并检查真实生产包及单独的运行测试包。

正式包只包含应用文件和许可证，不包含测试入口、本机日志或开发依赖。运行检查的证据保存在 Actions 的 `windows-test-evidence` 产物中，安装包为 `mouse-click-windows-x64`。Releases 仅在检查后发布。

Electron 与 electron-builder 沿用上游锁定版本；没有为本次移植升级整套框架。Windows 使用独立应用身份，Mac 本地构建入口 `scripts/build-local.cjs` 保留。

## 源码与许可证

本仓库提供大小设置、即时同步、保存失败反馈和真实文件测试。`node_modules`、安装包、本机验收目录与个人路径不提交到仓库。

原项目作者：Harry Hou / Hazyzh。原始演示：

![Cursor Highlight 原始演示](./readmeStatic/cursor_highlight_demo.gif)

依据 [MIT LICENSE](./LICENSE) 使用、修改和分发时，请保留版权与许可证文本。
