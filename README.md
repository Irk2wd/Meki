<p align="center">
  <img src="assets/icon.svg" width="80" height="80" alt="mekiR 图标">
</p>

# mekiR

Meki 的 `meki-research-dev` 分支，面向科研项目的本地工作区。按日期记录实验、编写带来源的阶段总结，在时间线上查看阶段和总结的覆盖时段。记录正文沿用 Meki 的 Markdown 编辑器、离线公式和图表、附件与导出。

在版本发布页选择以 `mekiR-` 开头的 Windows x64 或 macOS 通用安装包。研究版有独立的应用和数据目录。[版本列表](https://github.com/Irk2wd/Meki/releases) · [mekiR 1.2.1](https://github.com/Irk2wd/Meki/releases/tag/v1.2.1)

## 从源码启动

使用 Node.js 24 和 npm 11，或 Node.js 22.12+ 配合 npm 11。

```sh
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

启动后进入科研项目，左上角可以切换项目，或点「创建示例项目」。时间线按阶段组织实验，实验和总结在右侧阅读和编辑。左栏的「文稿编辑器」可打开普通 Markdown 编辑界面。

项目字段、模板、视图与阶段都可通过本地 CLI 调整。用 `npm --silent run research -- --help` 查看命令，或阅读[研究项目使用说明](docs/research-workspace.md)。

项目自有代码、文档和资源采用 [MIT 许可证](LICENSE)。第三方组件见[组件声明](THIRD_PARTY_NOTICES.txt)。
