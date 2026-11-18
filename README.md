<p align="center">
  <img src="assets/icon.svg" width="80" height="80" alt="mekiR 图标">
</p>

# mekiR

Meki 的 `research` 分支，面向科研项目的本地工作区。按日期记录实验、编写带来源的阶段总结，在时间线上查看阶段和总结的覆盖时段。记录正文沿用 Meki 的 Markdown 编辑器、离线公式和图表、附件与导出。

## 从源码启动

使用 Node.js 24 和 npm 11，或 Node.js 22.12+ 配合 npm 11。

```sh
npm ci
node node_modules/electron/install.js
npm run build
npm start
```

在左侧选择「研究项目」，可以创建渲染研究示例，或打开包含 `meki-project.json` 的项目目录。mekiR 使用自己的应用配置目录。这个分支从源码更新。

项目字段、模板、视图与阶段都可通过本地 CLI 调整。用 `npm --silent run research -- --help` 查看命令，或阅读[研究项目使用说明](docs/research-workspace.md)。

项目自有代码、文档和资源采用 [MIT 许可证](LICENSE)。第三方组件见[组件声明](THIRD_PARTY_NOTICES.txt)。
