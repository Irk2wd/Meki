# 研究项目原型

从 mekiR 源码目录运行 `npm run build && npm start`。启动时恢复上次打开的科研项目。用左上角的项目选择器可以打开另一项目的根目录，或点「创建示例项目」。示例使用虚构的渲染测量数据。点项目概览的「编辑项目描述」即可添加、修改或清空描述。

时间线以横条展示研究阶段的起止日期，用圆点显示实验发生日期。进行中的阶段置顶，同组按最近进展排序。已结束的阶段按结束日期倒序，结束日期相同时沿用项目中的顺序。可用快捷范围、输入日期、缩放按钮和横向拖动查看历史。范围从项目开始日到项目时区的今天，项目开始日未填写时从阶段和记录推断。计划阶段仍可选中编辑。

「项目全程」概览轴中的选区对应下方详细时间轴。拖动两端可以调整起止日期，拖动选区中间可以保持天数整体平移。在选区外拖拽可框选新区间，显示全部时段时可直接在概览轴上框选。聚焦手柄后可用方向键按天调整。

圆点颜色优先根据实验的 `status` 字段或导入的 `run.status` 判断。缺少可识别的状态时按阶段状态显示。同日有多条实验时，全部结束后圆点置灰。

展开时间线底部的「时间线选项」可以新建阶段。选中已有阶段后可以点「编辑阶段」。开始日期必填。结束日期留空时，阶段从开始日起显示「进行中」，横条延伸到项目时区的今天。填入实际结束日期后，阶段持续到该日结束。

在「时间线选项」中设置「每页阶段数」，也可点「全部阶段」。页数超过一页时，翻页按钮常驻时间线底部。每页数量保存在本机。

选中一个阶段后，下方展示阶段说明、目标、实验和总结。总结卡片分别标注覆盖区间与撰写日期。点击实验或总结可在右侧阅读，点「编辑正文」后使用原有的 Markdown 编辑和保存工具。返回按钮沿引用逐篇返回，关闭侧栏可直接回到原来的阶段、日期筛选和滚动位置。实验和总结行末的设置按钮可调整属性。

从左栏「研究阶段」进入后，打开报告即可在阶段名称下切换记录。切回读过的阶段时，会接着打开本次在项目中读过且符合当前筛选的那篇记录。再次点当前阶段名称，可回到该阶段的列表。

选中阶段后，先读阶段说明中的研究问题，再看「最新进展」。这里显示截至项目当地今天、符合当前筛选的最近一条有结论的实验或总结。同日优先显示有结论的总结。新写的报告若只有待验证事项，仍计入活动日期，已有结论继续显示。点结论读全文，点引用核对原图、计时表或关联记录。

当正文以记录标题开头时，顶栏先显示所属阶段等信息。向下滚过标题后，顶栏会显示记录名。点「证据与关联」可展开这条记录引用的文件和研究关系。

点实验列表中的字段，或在正文顶栏打开「字段口径」，可核对数值写入时采用的定义、单位和来源，再与当前项目规则对照。修改字段定义、改正文或重新打开记录都会保留已记录的口径。没有历史快照的旧值显示「写入时的定义未留存」。

Agent 从 `read.fieldOrigins` 或 `list.records[].fieldOrigins` 读取字段写入时的完整定义 `rule`，用 `read.currentFields` 对照当前项目定义。取值来源 `source` 为 `default` 表示创建时采用项目默认值，为 `record` 表示在记录中明确写入。

Markdown 用 `fieldRules` 引用 `.mekir/field-rules/` 中按内容摘要命名的 JSON 快照。归档或迁移时一起保留该目录。旧布局使用 `records/.field-rules/`。用 `batch` 修改字段，未改的值沿用已有口径。直接在外部改写的值若与快照不符，按未留存处理。

阅读报告时，点击原图、CSV、TSV 或 JSON 可在右栏核对证据。打开下一份文件会替换临时预览。想留着对照的文件可点「固定到右栏」，例如固定计时表后逐张打开原图。点击计时表标签可回到刚才的页码。列较多时可横向滚动，或点「展开证据预览」查看宽表。窄窗口会用阅读区显示证据。按 Esc 或关闭右栏可回到引用，结束这次预览。

拖动项目导航右侧的分隔线可调节导航宽度。并排阅读时，记录列表和正文之间也可以拖动。用 Tab 聚焦分隔线后，左右方向键可微调，按住 Shift 可加大步幅。宽度保存在本机，双击分隔线或按 Enter 可单独恢复该处的默认宽度。窗口变窄时正文会切换为浮层，放宽窗口后恢复分栏。

在「项目设置」的「时间线设置」中，可分别选择页面和对比弹窗的宽度。宽度保存在本机，阶段目标的隐藏、列表或勾选模式保存在项目里。

「新建研究记录」会带入当前阶段和所选日期。「插入阶段总结」会带入所选阶段的覆盖区间。Agent 也可更新记录和视图，项目界面会同步显示。普通 Markdown 编辑器可从左栏「文稿编辑器」打开，也可用 `npm start -- --editor` 直接进入。

项目的 `.mekir/project.json` 定义阶段、记录类型、字段规则、创建模板、视图和 agent 指引。普通实验写入 `records/r-<id>.md`，新建的阶段总结写入 `.mekir/summaries/r-<id>.md`。两者都包含 JSON 文档头和可编辑的 Markdown 正文。日期使用 `YYYY-MM-DD`，所有时段包含首尾两日。

## 时间线事件与图像对比

展开「时间线选项」后，「事件类型」提供 16 个图标，可为图像对比指定图标，也可创建组会汇报、审阅、里程碑等新类型。「添加事件」会保存日期、所属阶段和正文。同阶段同日的事件合并展示，点图标组可按标题选择。相邻日期的图标在空间不足时合并，放大时间轴后会分开。

汇报事件可引用通过「资料」登记的 PPTX 或 PDF。点时间线图标并选择汇报后，可在应用里按原顺序翻页。预览提供「查看事件正文」和「定位原文件」，关闭后回到时间线原来的位置。两种格式都在本地渲染，单个预览文件上限为 64 MiB。

选中阶段后点「新建可视化展示」。填写标题和日期，给行和列命名，通过证据 ID 选择在「资料」中登记的原图。展示和 Markdown 图注作为独立记录保存，可从该阶段重新打开。

同一行放同机位、相同宽高比的原图，列名记录方法或实验轮次。每行有两个不同的证据 ID 即可使用「滑动对比」，拖分界线或用方向键比较，点击任一侧查看该原图。实验记录或总结在 `sources` 中引用可视化展示的记录 ID 后，侧览会把对比图排在报告的开头标题和首段正文下方。多个展示可切换，图片继续从已绑定的只读来源读取。

同一行的图片同步响应滚轮缩放和拖动平移。点「1:1 原像素」按屏幕像素检查细节。每格的「打开原图」进入只读证据预览，点「返回对比」继续查看。

Agent 从 `describe.format.comparison` 读取记录类型和网格格式，再用 `batch` 写入 `phaseId`、`comparison.columns`、`comparison.rows` 和 Markdown `body`。每行的 `images` 按列填写已登记的证据 ID，未填的单元格用 `null`。首次创建可能登记默认记录类型，后续写入使用返回的 `projectRevision`。

## 跨项目总结

新建或编辑阶段总结时，可以在「关联项目」勾选多个最近打开的科研项目。每个关联项目的「阶段总结」页都会列出该文稿，点击后可在侧栏阅读或编辑。正文和引用保存在原项目，改动会反映到各关联项目。在原项目的记录属性中可增减关联。

`relatedProjects` 保存其他项目的 ID，由其 `describe` 输出提供。参与关联的项目需有各自的 ID，并可在本机的最近项目中打开。重新打开原项目可恢复对它的总结的访问。

## 引用项目内的文档

实验与阶段总结自动以记录 ID 加入文档索引。用 CLI 给已有 Markdown 或文本文件登记 ID，然后在阶段总结里勾选它作为来源。

```sh
node electron/research-cli.cjs index /path/to/project capture-notes --path notes/capture.md
node electron/research-cli.cjs resolve /path/to/project capture-notes
```

`list` 返回 `documents`，可查询每条来源的 ID 和相对路径。总结将来源 ID 保存在 `sources`，模板可生成 `[抓帧说明](mekir:capture-notes)`。在阅读侧栏点击链接即可切换来源文档，编辑时可按住 Ctrl 或 Command 点击。「资料」页可浏览项目索引中的普通文档。用文件侧栏移动或重命名普通文档时，mekiR 会更新 `.mekir/index.json`。在系统文件管理器中移位后，用同一个 ID 和新路径再运行一次 `index`。

## 只读证据

在「资料」登记论文仓库和实验归档，分别使用固定的来源 ID。登记原图、逐轮计时表或论文版本后，可在正文写 `[树冠原图](mekir:forest-canopy)`，也可在记录属性填写证据 ID。图片、CSV、JSON 和常用文本在 mekiR 中只读预览。其他文件可定位到来源目录。使用预览的返回箭头可回到正文。

CSV 和 TSV 以表格显示。对于没有表头的数据，取消「首行作为列名」即可把第一行作为数据查看。长表按行翻页，宽表可以切换列组。

新建示例项目后，在「复测与验证」阶段打开「树林轨迹复测」。其中的计时 CSV、两页观察报告 PDF 和三页组会幻灯片 PPTX 来自同一组合成林地渲染。可从正文或关联证据打开，关闭预览后继续阅读记录。

项目在 `.mekir/project.json` 保存来源 ID，在 `.mekir/index.json` 保存证据 ID、来源 ID 和相对路径。本机目录绑定存放在 `~/.mekir/sources/`。盘符或挂载点变化时，在「资料」对原来源执行「重新绑定目录」。目录内相对路径变化时，用原证据 ID 重新登记文件。

```sh
node electron/research-cli.cjs bind-source /path/to/project archive --label '实验归档' --path /path/to/03_experiment_results
node electron/research-cli.cjs index /path/to/project forest-canopy --source archive --path performance/20261117_forest/figures/canopy.png --label '树冠原图'
node electron/research-cli.cjs resolve /path/to/project forest-canopy --local
```

## 重复导入实验归档

在归档来源点「预览导入归档」，核对新增、变化、缺件和待确认条目，再确认导入。CLI 的 `import-archive <项目目录> <来源 ID>` 返回预览及 `token`，追加 `--confirm <token>` 才写入项目。归档或项目在确认前变化时，重新预览。

导入从 `RUN.md`、`run_manifest.json`（也接受 `manifest.json`）和归档目录名识别 run ID 与日期。已有 run ID 更新原记录。导入的正文可直接阅读和搜索，正文里能解析的文件链接会改用证据 ID。再次导入会刷新未编辑的正文，保留人工修改和关系。缺少 RUN.md 且能确定日期时生成「待补报告」记录，补齐报告后再次导入即可更新。缺少可信日期或存在重复 run ID 时在预览中列为「待确认」。

## 筛选与论文追溯

「研究筛选」组合关键词、实验月份和多个字段条件。`Electric Dreams + 性能 + 11 月` 可作为关键词，另加相机或模型范围条件。填写名称并点「保存并应用」后，可在时间线、实验和总结中复用。Agent 可以用 `list --query`、`--month`、重复的 `--field 字段=值` 或 `--filter ID` 应用等价筛选。`describe` 列出可筛选的归档字段。

在记录属性里添加「复测」「替代」「候选对照」「论文采用」或「论文版本」关系。目标可为记录 ID 或索引证据 ID，可附上采用理由。在阅读侧栏点关系跳转，或从被引用记录查看关联它的决定。导入的运行信息保存报告或 manifest 中能读取的研究问题、模型范围、相机与评测口径。

```json
{
  "evidence": ["forest-canopy"],
  "relations": [
    {"kind": "paper-adopted", "target": "forest-final30000", "note": "相同模型与四个固定视角逐轮复测。"},
    {"kind": "compares", "target": "forest-final3000"},
    {"kind": "paper-version", "target": "paper-v3"}
  ]
}
```

## Agent 批量写入

从 mekiR 源码目录运行下列命令。每批写入前先运行 `describe`，并阅读项目根目录的 `AGENTS.md`（如有）。

```sh
node electron/research-cli.cjs describe /path/to/project
node electron/research-cli.cjs list /path/to/project --from 2026-11-12 --to 2026-11-18 --phase validation
node electron/research-cli.cjs read /path/to/project forest-validation
node electron/research-cli.cjs batch /path/to/project --input batch.json
```

`describe.phaseContext` 列出每个阶段的说明、最近一份阶段总结和最近三条实验，日期以项目时区为准。按本轮要回答的问题选择阶段。同一判断下的调参、换机位和补基线各记一条实验，沿用阶段 ID。进入新的研究决定时，在新阶段说明中写明要判断什么。普通实验暂时无法归类时可以省略 `phaseId`。

从 `describe.project.recordTypes` 按 ID 选择 `record.type`。`fields` 以所选类型的字段 ID 为键。按每个字段的说明、单位、类型、取值范围和枚举从实际产物提取值。`project.instructions` 说明本项目的记录口径。各项目可以定义自己的类型、字段和正文模板。例如，渲染实验记录场景和帧时间，论文分析记录章节和稿件版本。

实验报告和阶段总结先写本轮最重要的已确认结论。比较方案、轮次或条件时，优先把实测值放进 Markdown 表格，在表头标明指标和单位。正文解释差异怎样影响判断，避免逐项复述数字。单个独立读数可直接写在正文中。缺少对照时先报告实际测到的结果，把待补测量和推测放在文末「待验证」。没有遗留问题时可省略这一节。

实验标题下的摘要与 `list` 的 `excerpt` 一致。先取类型指定的文本字段 `conclusionField`，再取「结论」或「已确认的结论」小节的首句，最后取普通正文首句。「待验证」及其子标题里的内容留在正文中。当报告只有待验证事项时，标题下会留空。

新记录使用同一轮实验的稳定 ID，并在 `date` 写项目时区的实际发生日期。总结用 `date` 写撰写日期，用 `coverage` 写覆盖区间。下例使用渲染研究样例的类型和字段。执行前将 `ifProjectRevision` 替换为 `describe` 返回的 `revision`。

```json
{
  "ifProjectRevision": "<describe.revision>",
  "records": [
    {
      "id": "forest-repeat",
      "ifRevision": null,
      "type": "experiment",
      "title": "树林同视角复测",
      "date": "2026-11-18",
      "phaseId": "validation",
      "fields": { "scene": "Forest Path", "gpu_ms": 10.9, "outcome": "有效" },
      "body": "# 树林同视角复测\n\n使用同一轨迹补齐基线，测得 GPU 帧时间 10.9 ms。"
    },
    {
      "id": "validation-review",
      "ifRevision": null,
      "type": "stage-summary",
      "title": "复测阶段总结",
      "date": "2026-11-18",
      "phaseId": "validation",
      "coverage": { "start": "2026-11-12", "end": "2026-11-18" },
      "sources": ["forest-validation", "forest-repeat"]
    }
  ]
}
```

同一批次的新来源记录写在引用它的总结前面。更新已有记录时，用 `read` 返回的 `revision` 作为 `ifRevision`，只提交要修改的属性。省略字段或正文会保留已有内容。用 `fields` 中的 `null` 清除可选字段。

新建时可以省略有默认值的字段，省略 `body` 会套用所选类型的模板。缺失数据和原因可写入正文，必填项需要有效值或项目配置的默认值。相同批次可重试。收到 `RESEARCH_CONFLICT` 后，重新 `describe` 并读取相关记录，再合并修改。

## 调整项目方案

复制 `describe` 返回的 `project`，连同该次读取的 `revision` 提交 `{"ifRevision":"…","project":{…}}`，再运行 `node electron/research-cli.cjs configure /path/to/project --input configuration.json`。项目级记录口径写在 `instructions`，协作流程写在项目根目录的 `AGENTS.md`。

改显示名称时沿用原 ID。字段的含义或单位变化时使用新 ID。增减字段时同步修改模板里的 `{{field.<ID>}}` 和视图的 `fieldIds`。视图还可以设置显示的记录类型、阶段、布局和排序。

结束日期未定时，在 `phases` 中省略 `end` 或设为 `null`。`start` 仍需填写 `YYYY-MM-DD` 日期，已确定的 `end` 包含当天。

用 `project.start` 指定时间线起点。在 `phases` 内可写 `description` 和 `goals: [{ "text": "目标", "done": false }]`。`phaseGoals` 决定阶段目标的显示方式，可选 `hidden`、`list`（默认）与 `checklist`。改显示方式会保留已有目标和勾选状态。

事件的记录类型使用 `kind: "event"`，图像对比沿用 `kind: "comparison"`。两种类型都可设置 `icon`，取值见 `describe.format.timeline.events.icons`。用 `batch` 写事件时填写类型 ID、`phaseId`、实际发生日期、字段和正文。更新图标时沿用原类型 ID。

保存配置后重新 `describe`，再用新修订写记录。查看 `list` 返回的 `issues` 可找到待补的必填项和不再匹配的历史值。已有正文和字段仍可阅读，可在有依据时用 `batch` 补录。

从一份配置创建新项目时可用 `init <新目录> --input <配置文件>`，从自带示例创建可用 `init-demo <新目录>`。用 `node electron/research-cli.cjs --help` 查看完整命令。验证界面和 CLI 联动可运行 `npm run test:research`。

## 归档

归档或用 Git 跟踪项目时，保留整个项目目录，包括 `.mekir/`、实验记录、索引引用的文档和附件。`.mekir/` 在应用的普通文件树中隐藏，从「研究项目」打开阶段总结。根目录包含 `meki-project.json` 的旧版项目仍可按原布局读写。
