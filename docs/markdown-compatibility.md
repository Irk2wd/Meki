# Markdown 兼容性与验证

编辑器和 HTML 导出共用 `remark-parse`、GFM、math 及 Moye 扩展。新增语法在 micromark 的 token 层解析，不对全文做替换；代码、公式、链接地址和转义标记不会被误当成扩展。编辑器使用对应的 ProseMirror 节点或标记，保存时再序列化为 Markdown。

| 功能 | 源码与行为 |
| --- | --- |
| 目录 | 独占一段的 `[TOC]`，大小写均可。根据当前标题生成目录，重复标题分配唯一锚点；编辑后保留原目录标记。 |
| 提示块 | GitHub 的 `> [!NOTE]`、`TIP`、`IMPORTANT`、`WARNING`、`CAUTION`。支持块内格式和列表。 |
| 上下标 | `H~2~O`、`x^2^`，内容为不含空白的单行 span；`~~删除线~~` 保持独立语义。 |
| 高亮 | `==高亮 **粗体**==`，可含普通行内格式与代码。 |
| Emoji | 约 25 个常用别名，如 `:smile:`、`:rocket:`、`:heart:`、`:thumbsup:`。未知别名保留为文字。 |
| 脚注 | `[^标识]` 和定义。编辑器引用可跳转，HTML 导出提供编号、引用及返回链接。 |
| 原始 HTML | 除下方严格限定的独立单图片标签外，块级 HTML 显示为原始源码；行内 HTML 同样作为可见文本保留。在源码模式编辑，均不执行。 |
| 图片 | 未缩放图片使用标准 Markdown；缩放图片使用单个 `<img>` 的 width/height 属性。保存原始 alt 描述及 title；导出嵌入获准读取的本地图片，保留尺寸。远程图片仍依赖其地址。 |
| Mermaid | `mermaid` 代码围栏保留源码；离线渲染 SVG，点击可编辑，跟随主题。HTML 与 PDF 包含视口外图表。配置指令、网络资源和交互回调不受支持，错误显示原文和原因。 |
| 数学 | 公式源码交由离线 MathJax 文档渲染，预览和 HTML 导出共用顺序、编号与引用语义。 |

未编辑文稿时，现有原文快照保持 BOM、CRLF、YAML 和原始字节。视觉编辑会重新序列化正文，因此仍可能改变列表缩进、空白和等价的定界符写法；YAML 前缀独立保存。

图片尺寸语法只接受独占一段的单个 `<img>`，属性限于 `src`、`alt`、`title`、`width`、`height`；前三个属性须带引号，尺寸是 1–10,000 的整数像素。支持安全的相对地址、已获准的本地文件、HTTP(S) 和图片 data URL，地址不授予额外文件权限。常用实体和数值实体可用于属性值；未知实体、未知或重复属性、百分比、style、srcset、事件、危险协议与混合标签均保留为可见源码。代码和行内 HTML 中的图片标签不启用该特例。拖动缩放、还原尺寸均可单步撤销，尺寸不写入 alt 或 title。

`tests/markdown-extensions.test.cjs` 检查解析和序列化结构、代码/数学/转义隔离、重复目录锚点、脚注、HTML 安全、公式顺序与 CRLF 提示块。`tests/extensions-smoke.mjs` 使用独立 `MOYE_TEST` profile，在真实 Electron 中执行模式切换、保存、重新打开、目录/脚注跳转、行内公式编辑及独立 HTML 打开验证。测试文稿仅存于 `test-results/`。

`tests/image-syntax.test.cjs`、`tests/image-sizing.test.cjs` 验证严格属性解析、地址重写、AST 隔离和尺寸属性。`tests/image-sizing-smoke.mjs` 覆盖实际拖动、立即保存、撤销／重做、还原、标题编辑、源码切换、重开及 HTML／打印尺寸；测试使用生成的图片与独立 profile。

HTML 导出通过同一 AST 渲染普通文稿，再由 DOMPurify 清理。MathJax 的受控 SVG 在清理后进入专用公式占位节点；其字形轮廓内嵌，不请求网络脚本或字体。Mermaid 使用独立占位节点，图表经过 SVG 和样式清理后嵌入；二者均不会把任意文稿 HTML 当作可执行页面。CSS 使用与编辑器相同的排版设置，受限图片由验证后的属性生成，其他原始 HTML 显示为转义源码。
