# 研究项目原型

从 mekiR 源码目录运行 `npm run build && npm start`。点击左侧「研究项目」，可以创建渲染研究示例，或打开已有项目的根目录。示例使用虚构测量数据。

在项目里按日期筛选，再点「新建研究记录」，表单会带入该日期。提交后用 mekiR 编辑并保存正文。点「插入阶段总结」可分别填写撰写日期、覆盖开始与结束、关联阶段和来源记录。时间线用横条表示阶段和总结覆盖时段，用圆点表示记录日期。点击阶段横条筛选记录，点击总结打开正文。记录行末的设置按钮可调整属性。

项目的 `.mekir/project.json` 定义阶段、记录类型、字段规则、创建模板、视图和 agent 指引。普通实验写入 `records/r-<id>.md`，新建的阶段总结写入 `.mekir/summaries/r-<id>.md`。两者都包含 JSON 文档头和可编辑的 Markdown 正文。时间线读取阶段区间、总结覆盖区间和记录日期生成。日期使用 `YYYY-MM-DD`，所有时段包含首尾两日。

## 引用项目内的文档

实验与阶段总结自动以记录 ID 加入文档索引。用 CLI 给已有 Markdown 或文本文件登记 ID，然后在阶段总结里勾选它作为来源。

```sh
node electron/research-cli.cjs index /path/to/project capture-notes --path notes/capture.md
node electron/research-cli.cjs resolve /path/to/project capture-notes
```

`list` 返回 `documents`，可查询每条来源的 ID 和相对路径。总结将来源 ID 保存在 `sources`，模板可生成 `[抓帧说明](mekir:capture-notes)`。在项目内按住 Ctrl 或 Command 点击正文链接，可跳到索引中的文档。用文件侧栏移动或重命名普通文档时，mekiR 会更新 `.mekir/index.json`。在系统文件管理器中移位后，用同一个 ID 和新路径再运行一次 `index`。

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
