# 第三方许可文本

项目自有源码使用根目录的 MIT 许可证。第三方组件仍按各自许可证授权，不能将它们统一改标为 MIT。

`scripts/notices.mjs` 按锁文件枚举本机已安装的依赖，收集许可证、NOTICE 和嵌套的许可文件，生成 `THIRD_PARTY_NOTICES.txt`。`npm run check:licenses` 检查声明是否与锁定依赖一致；生成过程不访问网络，也不读取锁文件以外的包。

部分 npm 包没有随包提供许可正文。`overrides.json` 按精确的包名和版本关联 `upstream/` 中保留的许可文本、来源与 SHA-256；缺少声明或正文、版本或摘要不符时停止生成，不能静默跳过。Khroma 2.1.0 没有 `license` 元数据字段，但随包 `license` 文件是 MIT，因此只补元数据判定。

少数构建工具连上游仓库也没有单独的许可文件。相应 override 明确标注“按包元数据声明补充标准许可正文”，并保留原 npm 归档地址和已有作者信息，不把标准模板冒称为上游原始版权文件，也不编造版权姓名或年份。这类包升级时需要重新复核元数据和源码中的声明。

MathJax 的两个字体数据包声明 Apache-2.0，却没有附带许可文件。这里保留同版本 `@mathjax/src` 随包提供的 Apache-2.0 正文，并明确标注这一来源，不声称它来自未公开的字体源码仓库。

ELK/elkjs 的 EPL-2.0 声明及对应版本源码地址随组件声明提供。Sharp/libvips 的 LGPL 组件、Lightning CSS 的 MPL 组件主要用于构建工具，应用 staging 不包含 `node_modules`；不能仅凭 `devDependencies` 分类认定组件没有进入发行包。发布前仍需检查实际构建内容及 Electron/Chromium 的运行时许可文件。Pandoc 和 PicGo 由用户另行安装，项目不随安装器分发它们。

依赖升级后应重新检查版权人、许可证和源码提供要求，更新精确版本的 override，再生成声明。上游作者的版权姓名和联系地址属于许可正文，应原样保留。
