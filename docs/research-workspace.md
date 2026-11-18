# 研究项目原型

从 mekiR 源码目录运行 `npm run build && npm start`。点击左侧「研究项目」，可以创建渲染研究示例，或打开已有项目的根目录。示例使用虚构测量数据。

在项目里按日期筛选，再点「新建研究记录」，表单会带入该日期。提交后用 mekiR 编辑并保存正文。点「插入阶段总结」可分别填写撰写日期、覆盖开始与结束、关联阶段和来源记录。时间线用横条表示阶段和总结覆盖时段，用圆点表示记录日期。点击阶段横条筛选记录，点击总结打开正文。记录行末的设置按钮可调整属性。

项目的 `meki-project.json` 定义阶段、记录类型、字段规则、创建模板、视图和 agent 指引。每条记录保存在 `records/r-<id>.md`，包含 JSON 格式的文档头和 Markdown 正文。日期使用 `YYYY-MM-DD`，所有时段包含首尾两日。引用使用记录 ID，模板在创建时展开，之后可像普通 Markdown 一样编辑。

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

## 项目数据的存储方向

建议让一份研究项目对应一个可独立复制的普通目录，可放在源码工作区之外。实验和总结继续存为 `records/r-<id>.md`。发生日期、阶段 ID、覆盖区间和来源 ID 随 Markdown 文件保存，移动一条记录时正文和元数据能一起带走，也方便用 Git 查看同一次修改。

项目级配置目前只有一个 `meki-project.json`，放在根目录便于打开和检查。如果后续有多份模板和视图定义，可把阶段、字段规则、共享模板和视图集中在项目内的 `.mekir/`，应用和 CLI 读取同一份有版本号的配置。在 Git 中应保留这些配置。参考 [Obsidian 的文件、配置与缓存分层](https://obsidian.md/help/Files%2Band%2Bfolders/How%2BObsidian%2Bstores%2Bdata)。

最近打开的位置、窗口布局、草稿和可重建索引适合保存在本机应用数据目录。项目归档包含正文、项目规则和实际纳入的附件。附件优先用相对路径引用，大体积结果留在既有存储时可在归档清单里标明外部依赖。
