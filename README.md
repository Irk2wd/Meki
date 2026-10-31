# Meki

面向 Windows 和 macOS 的本地 Markdown 编辑器，提供即时预览、离线公式与图表，以及本地文件工作区。项目自有代码采用 [MIT 许可证](LICENSE)。

## 安装

从 [GitHub Releases](https://github.com/Irk2wd/Meki/releases) 下载对应平台的安装器：

- Windows x64：双击 `Meki-<版本>-Setup-x64.exe`，按向导安装，可选择安装目录和用户范围。
- macOS Apple Silicon / Intel：打开 `Meki-<版本>-macOS-universal.dmg`，将 Meki 拖入 Applications，再从“应用程序”启动。

安装包的签名状态与验证范围见对应 Release。卸载时保留本地文稿和用户数据。Meki 1.0.0 的功能说明见 [版本说明](docs/releases/1.0.0.md)。

## 写作

- 视觉编辑与 Markdown 源码切换，支持表格、任务列表、脚注、目录、提示块和语法高亮。
- MathJax 公式与 Mermaid 图表随应用打包，可离线渲染。
- 简体中文与英文界面，三套主题，可设置字体、字号、正文宽度和正文 CSS。
- 多标签、独立窗口和拖动分栏；支持专注、打字机模式与大纲导航。
- 查找与替换、工作区搜索、快捷键，以及本地图片粘贴、拖放和尺寸调整。

## 文件与导出

直接编辑本地 UTF-8 Markdown 文件，可打开文件或文件夹。未编辑的文件保留原文、BOM 和换行；视觉编辑会规范化部分 Markdown 写法，具体边界见 [Markdown 兼容性](docs/markdown-compatibility.md)。

支持自动保存、未保存草稿恢复、手动与自动快照，以及文件版本历史。外部修改发生冲突时会暂停自动保存，由用户决定如何处理。快照与历史保存在本机，仍建议为重要文稿另行备份。

可导出 HTML、PDF 和 PNG；安装 Pandoc 后支持 Word 与 EPUB。编辑、预览和导出共用正文外观、公式与图表规则。导出格式的具体限制见 [应用架构](docs/architecture.md)。

图片可保存在文稿附件目录，或交由本机 PicGo 上传。支持上传前预览、单图操作和整理附件，原图保留；自动上传默认关闭。配置和限制见 [PicGo 图床](docs/image-hosting.md)。

## 更新与本地数据

通过帮助菜单或侧栏的“检查更新”查看版本说明并下载更新，下载完成后由用户选择重启。更新使用签名清单和文件摘要校验；运行时升级需要完整安装器。使用与维护说明见 [应用内更新](docs/updates.md)。

设置、恢复数据、快照和更新缓存保存在本机。应用无需账户，没有云同步或遥测。更新检查、用户插入的网络图片、主动打开的网页、PicGo 上传及启用拼写检查后的词典下载会按操作联网。

## 从源码运行

需要 Node.js 24 和 npm。在项目根目录执行：

```sh
npm ci
npm run build
npm start
```

如安装时跳过了 Electron 运行时下载，先执行 `node node_modules/electron/install.js`。

开发时先运行 `npm run dev`，再在另一个终端设置 `MOYE_DEV_URL=http://127.0.0.1:5173` 并运行 `npm start`。正式运行时不设置该变量。

## 开发与构建

```sh
npm test
npm run check:licenses
npm run check:assets
npm run test:ui
```

桌面测试使用隔离数据目录和合成文稿，不读写用户文稿。普通 push 和 PR 运行 Source CI；Desktop CI 由维护者在准备发布时手动运行，构建 Windows EXE 与 macOS 通用 DMG，并验证安装后的应用。

安装器在目标系统通过 `npm run package:installer` 构建，输出到 `release/installers/`。签名更新清单需要维护者配置 `MOYE_UPDATE_SIGN_KEY`；私钥不包含在仓库中。完整发布流程见 [更新维护](docs/updates.md)。

源码结构：

- `src/`：编辑器、工作区和界面。
- `electron/`：主进程、文件访问、存储、导出和更新。
- `shared/`：跨进程类型；`tests/`：单元与桌面测试。
- `scripts/`：构建与发布工具；`assets/`：图标和安装器资源。
- `docs/`：使用与架构说明；`licenses/`：第三方许可文本。

## 许可证

项目自有代码、文档和资源采用 [MIT](LICENSE)。第三方组件保留各自条款，完整声明见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 和 [licenses/](licenses/README.md)。Electron 与 Chromium 的许可随运行时分发。Pandoc 和 PicGo 由用户另行安装。
