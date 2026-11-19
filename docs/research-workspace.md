# 研究项目原型

从 mekiR 源码目录运行 `npm run build && npm start`。启动时恢复上次打开的科研项目。用左上角的项目选择器可以打开另一项目的根目录，或点「创建示例项目」。示例使用虚构的渲染测量数据。点项目概览的「编辑项目描述」即可添加、修改或清空描述。

时间线以横条展示研究阶段的起止日期，用圆点显示实验发生日期。进行中的阶段置顶，同组按最近进展排序。已结束的阶段按结束日期倒序，结束日期相同时沿用项目中的顺序。快捷范围按项目时区查看最近 7 天、14 天、1 个月或 3 个月，也可拖动刻度或输入起止日期。下方的实验列表同步筛选。

圆点颜色优先根据实验的 `status` 字段或导入的 `run.status` 判断。缺少可识别的状态时按阶段状态显示。同日有多条实验时，全部结束后圆点置灰。

点「新建阶段」，或选中阶段后点「编辑阶段」。开始日期必填。结束日期留空时，阶段从开始日起显示「进行中」，横条延伸到项目时区的今天。填入实际结束日期后，阶段持续到该日结束。

在研究阶段区域设置「每页阶段数」，按排序逐页查看，也可点「全部阶段」。每页数量保存在本机。

选中一个阶段后，下方展示这个阶段的实验和总结。总结卡片分别标注覆盖区间与撰写日期。点击实验或总结可在右侧阅读，点「编辑正文」后使用原有的 Markdown 编辑和保存工具。返回按钮沿引用逐篇返回，关闭侧栏可直接回到原来的阶段、日期筛选和滚动位置。实验和总结行末的设置按钮可调整属性。

「新建研究记录」会带入当前阶段和所选日期。「插入阶段总结」会带入所选阶段的覆盖区间。Agent 也可更新记录和视图，项目界面会同步显示。普通 Markdown 编辑器可从左栏「文稿编辑器」打开，也可用 `npm start -- --editor` 直接进入。

项目的 `.mekir/project.json` 定义阶段、记录类型、字段规则、创建模板、视图和 agent 指引。普通实验写入 `records/r-<id>.md`，新建的阶段总结写入 `.mekir/summaries/r-<id>.md`。两者都包含 JSON 文档头和可编辑的 Markdown 正文。日期使用 `YYYY-MM-DD`，所有时段包含首尾两日。

## 阶段内的图像对比

选中阶段后点「新建可视化展示」。填写标题和日期，给行和列命名，通过证据 ID 选择在「资料」中登记的原图。展示和 Markdown 图注作为独立记录保存，可从该阶段重新打开。

时间线在展示日期标记图片图标，同一阶段的同日展示合并为一个图标。点开单条展示进入对比视图，同日有多条时可以按标题选择。

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

从 `describe.project.recordTypes` 按 ID 选择 `record.type`。`fields` 以所选类型的字段 ID 为键。按每个字段的说明、单位、类型、取值范围和枚举从实际产物提取值。`project.instructions` 说明本项目的记录口径。各项目可以定义自己的类型、字段和正文模板。例如，渲染实验记录场景和帧时间，论文分析记录章节和稿件版本。

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

保存配置后重新 `describe`，再用新修订写记录。查看 `list` 返回的 `issues` 可找到待补的必填项和不再匹配的历史值。已有正文和字段仍可阅读，可在有依据时用 `batch` 补录。

从一份配置创建新项目时可用 `init <新目录> --input <配置文件>`，从自带示例创建可用 `init-demo <新目录>`。用 `node electron/research-cli.cjs --help` 查看完整命令。验证界面和 CLI 联动可运行 `npm run test:research`。

## 归档

归档或用 Git 跟踪项目时，保留整个项目目录，包括 `.mekir/`、实验记录、索引引用的文档和附件。`.mekir/` 在应用的普通文件树中隐藏，从「研究项目」打开阶段总结。根目录包含 `meki-project.json` 的旧版项目仍可按原布局读写。
