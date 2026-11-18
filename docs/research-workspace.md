# 研究项目原型

从 mekiR 源码目录运行 `npm run build && npm start`。启动时恢复上次打开的科研项目。用左上角的项目选择器可以打开另一项目的根目录，或点「创建示例项目」。示例使用虚构的渲染测量数据。

时间线以横条展示研究阶段的起止日期，用圆点显示实验发生日期。进行中的阶段排在前面，各组按最近的实验或阶段总结日期排列。拖动时间刻度可缩放到指定时段，也可点「选择时间范围」输入起止日期。下方的实验列表同步筛选。

选中一个阶段后，下方展示这个阶段的实验和总结。总结卡片分别标注覆盖区间与撰写日期。点击实验或总结可在右侧阅读，点「编辑正文」后使用原有的 Markdown 编辑和保存工具。返回按钮沿引用逐篇返回，关闭侧栏可直接回到原来的阶段、日期筛选和滚动位置。实验和总结行末的设置按钮可调整属性。

「新建研究记录」会带入当前阶段和所选日期。「插入阶段总结」会带入所选阶段的覆盖区间。Agent 也可更新记录和视图，项目界面会同步显示。普通 Markdown 编辑器可从左栏「文稿编辑器」打开，也可用 `npm start -- --editor` 直接进入。

项目的 `.mekir/project.json` 定义阶段、记录类型、字段规则、创建模板、视图和 agent 指引。普通实验写入 `records/r-<id>.md`，新建的阶段总结写入 `.mekir/summaries/r-<id>.md`。两者都包含 JSON 文档头和可编辑的 Markdown 正文。日期使用 `YYYY-MM-DD`，所有时段包含首尾两日。

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

从 mekiR 源码目录运行以下命令。项目初始化时生成的 `AGENTS.md` 也说明了这一流程。

```sh
node electron/research-cli.cjs describe /path/to/project
node electron/research-cli.cjs list /path/to/project --from 2026-11-12 --to 2026-11-18 --phase validation
node electron/research-cli.cjs read /path/to/project forest-validation
node electron/research-cli.cjs batch /path/to/project --input batch.json
```

`describe` 返回当前项目的字段类型、必填项、枚举、数值限制、默认值和模板。Agent 完成一批实验后，应读取最新规则，从实际产物提取字段，再提交如下结构。示例值只适用于自带的渲染研究项目。

```json
{
  "records": [
    {
      "id": "forest-repeat",
      "type": "experiment",
      "title": "树林同视角复测",
      "date": "2026-11-18",
      "phaseId": "validation",
      "fields": { "scene": "Forest Path", "gpu_ms": 10.9, "outcome": "有效" },
      "body": "# 树林同视角复测\n\n使用同一轨迹补齐基线，测得 GPU 帧时间 10.9 ms。"
    },
    {
      "id": "validation-review",
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

同一批次的新来源记录写在引用它的总结前面。可以把 `describe` 返回的 `revision` 作为 `ifProjectRevision` 提交，确保使用读到的规则。更新已有记录时提交 `read` 返回的 `revision` 作为 `ifRevision`，以及需要修改的字段。省略正文会保留已有正文，新建时会应用模板。相同批次可重试。若其他进程先更新了同一份文件，重新读取后合并修改。

## 调整项目方案

从 `describe` 的 `project` 开始编辑，将结果连同其 `revision` 保存成 `{"ifRevision":"…","project":{…}}`，再运行 `node electron/research-cli.cjs configure /path/to/project --input configuration.json`。可增减字段、修改模板、设置按日期或时间线显示的视图，也可调整视图过滤的记录类型和阶段、展示字段、排序和默认视图。项目页会在打开时刷新变更。新增必填字段时，旧记录仍可阅读，项目页会提示哪些字段待补。

从一份配置创建新项目时可用 `init <新目录> --input <配置文件>`，从自带示例创建可用 `init-demo <新目录>`。用 `node electron/research-cli.cjs --help` 查看完整命令。验证界面和 CLI 联动可运行 `npm run test:research`。

## 归档

归档或用 Git 跟踪项目时，保留整个项目目录，包括 `.mekir/`、实验记录、索引引用的文档和附件。`.mekir/` 在应用的普通文件树中隐藏，从「研究项目」打开阶段总结。根目录包含 `meki-project.json` 的旧版项目仍可按原布局读写。
