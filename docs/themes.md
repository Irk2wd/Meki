# Meki 与 mekiR 主题

在「设置 → 外观与排版」选择主题。手稿纸带浅色纸纹和双线标题，牛皮纸用棕色纤维纹理配深色墨迹，方格笔记带淡蓝网格和虚线分隔，赛博带深色网格、等宽标题和高亮代码。

主题纹理出现在文稿页两侧和研究卡片周围。文字区域使用主题的纯色底。

点「导入主题」，选择 UTF-8 编码的 `.meki-theme.json` 文件。导入后立即应用，并在重启后保留。重新导入同一 `id` 会更新本机主题。选中导入项时，可点「移除当前主题」回到它所继承的内置主题。

[薄雾主题示例](mist.meki-theme.json)可直接导入。两款应用共用主题格式，各自在本机保存主题库。「自定义正文 CSS」作为最后一层微调。HTML、PDF 和 PNG 导出选择「沿用编辑器」时会带上当前主题。

## 编写主题

单个文件上限为 256 KiB。主题库最多保存 24 个导入项，所有导入项合计最多约 1.5 MiB。

| 字段 | 写法 |
| --- | --- |
| `version` | 必填，当前为数字 `1`。 |
| `id` | 必填，2–48 字符，以小写英文字母开头，后续可用小写字母、数字和连字符。内置 ID 为 `paper`、`linen`、`night`、`manuscript`、`kraft`、`graph`、`cyber`。 |
| `name` | 必填，主题列表显示名，最多 64 字符。 |
| `base` | 必填，从 `paper`、`linen`、`night` 继承未填写的颜色、代码高亮和图表明暗。 |
| `palette` | 可选。按下表覆盖颜色，每个值为 `#RRGGBB`。 |
| `background` | 可选，提供 `image`，并可填写 `size`、`position`、`repeat`，用法同 CSS 背景属性。 |
| `styles` | 可选。以正文角色为键，每个角色写一组 CSS 属性和值。 |

### 配色与纹理

| 配色键 | 用途 |
| --- | --- |
| `bg`、`side`、`surface` | 阅读画布、侧栏或代码底色、浮层或卡片。 |
| `text`、`soft`、`muted` | 正文、次要文字、弱提示。 |
| `accent`、`accent-soft`、`hover`、`selection`、`border`、`logo-ink` | 强调、浅强调底色、悬停、局部选区、边线、标志前景。 |

`background.image` 支持一层或多层 CSS 线性、径向或锥形渐变，包括重复渐变。也可填一张 `data:image/png;base64,…` 静态 PNG，最大 1024 × 1024 像素、128 KiB。默认以原尺寸、左上角起始重复铺放。渐变和正文声明可通过 `var(--accent)` 等引用上表的配色键。

### 正文排版

`styles` 支持以下角色。

| 内容 | 角色 |
| --- | --- |
| 文档与标题 | `document`、`heading`（所有标题）、`h1` 至 `h6` |
| 行文 | `paragraph`、`link`、`emphasis`、`strong` |
| 引用和列表 | `quote`、`quoteText`、`list`、`listItem` |
| 代码和表格 | `code`（行内）、`codeBlock`、`table`、`tableHead`、`tableCell` |
| 其他 | `image`、`rule`（分隔线） |

属性用 CSS 的连字符写法，值用字符串。例如 `"h2": { "border-bottom": "1px dashed var(--border)", "padding-bottom": ".25em" }`。支持字体、行高、字距、颜色、边框、圆角、阴影、间距和列表样式，完整属性表见 [格式校验](../electron/theme-format.mjs)。`document` 可设置颜色、背景色、行高、字距、词距和对齐。正文的字体、字号和宽度可在应用里调整。

导入时会校验字段和声明。主题是自包含的数据文件，外部网址、本机文件路径、脚本和任意 CSS 选择器不属于此格式。
