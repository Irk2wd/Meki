'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ResearchStore, comparisonTableGuide } = require('./research-store.cjs');

const pendingSection = '## 待验证\n\n<!-- 在这里写尚未证实的解释、缺少的对照及验证方法。没有待验证事项时删去本节。 -->\n';

function forestValidationReport(evidence = []) {
  const sections = [
    '# 树林轨迹复测', '## 结论',
    '开启遮挡剔除后，树林轨迹的 GPU 帧时间中位数为 **11.4 ms**。这条轨迹覆盖了更密集的植被。',
  ];
  if (evidence.length) sections.push('## 四视角合成场景',
    '11 月 20 日补充。固定四个机位比较树冠几何，下列计时包含单次 CPU 绘制与 PNG 编码。',
    evidence.map(file => `- [${file.title}](mekir:${file.id})`).join('\n'));
  sections.push('## 待验证', '沿同一轨迹关闭遮挡剔除再测一次，比较两种设置的 GPU 帧时间。');
  return sections.join('\n\n') + '\n';
}

const exampleProject = {
  version: 1,
  id: 'render-benchmark',
  title: '实时渲染性能研究',
  description: '研究遮挡剔除对 GPU 帧时间的影响。以下记录与数值为示例数据。',
  timezone: 'Asia/Shanghai',
  start: '2026-11-01',
  instructions: [
    '每个完成的运行写一条实验记录。以运行的实际日期和固定 ID 登记，记录场景、显卡和分辨率。',
    'GPU 帧时间使用毫秒。缺少有效测量时在正文解释原因，保留原始配置、日志或报告的相对链接。',
    '阶段总结写明确切的覆盖区间，引用作出判断所用的文档 ID。',
  ],
  phases: [
    { id: 'baseline', title: '基线测量', start: '2026-11-02', end: '2026-11-06',
      description: '确定后续遮挡剔除实验可以沿用哪条相机轨迹和哪种计时口径。' },
    { id: 'exploration', title: '方案探索', start: '2026-11-05', end: '2026-11-13',
      description: '在城市街区比较候选阈值，选出值得到树林场景复测的遮挡剔除方案。' },
    { id: 'validation', title: '复测与验证', start: '2026-11-12', end: '2026-11-18',
      description: '判断选出的遮挡剔除方案在树林中能否稳定降低 GPU 帧时间。每个机位都与同轨迹的无剔除基线比较。',
      goals: [{ text: '补采同视角基线' }, { text: '复核逐轮计时' }] },
  ],
  recordTypes: [
    {
      id: 'experiment', label: '实验', kind: 'entry', description: '一条记录对应一次完整的渲染运行或一组共同测量。',
      fields: [
        { id: 'scene', label: '场景', type: 'text', required: true, description: '使用报告中的场景名。' },
        { id: 'gpu', label: '显卡', type: 'text', required: true, default: 'RTX 4080' },
        { id: 'resolution', label: '分辨率', type: 'choice', required: true, options: ['1920×1080', '2560×1440', '3840×2160'], default: '2560×1440' },
        { id: 'gpu_ms', label: 'GPU 帧时间', type: 'number', min: 0, unit: 'ms', description: '去掉预热帧后的 GPU 帧时间中位数。' },
        { id: 'outcome', label: '结果状态', type: 'choice', required: true, options: ['有效', '需复测', '无效'], default: '需复测' },
      ],
      template: `# {{title}}

## 结论

<!-- 同一问题的调参、换机位和补基线沿用原阶段。先写证据支持的发现和适用条件。缺少对照时写本轮实测值。 -->

## 对照与依据

<!-- ${comparisonTableGuide} -->

{{sources}}

## 实验设置

- 场景：{{field.scene}}
- 显卡：{{field.gpu}}
- 分辨率：{{field.resolution}}

${pendingSection}`,
    },
    {
      id: 'stage-summary', label: '阶段总结', kind: 'summary', description: '汇总一段时间内的研究进展，引用支持判断的记录。',
      fields: [],
      template: `# {{title}}

## 结论

<!-- 先回答阶段研究问题，再按重要性写出实验已经支持的其他结论，注明适用范围。 -->

## 依据

<!-- ${comparisonTableGuide} -->

{{sources}}

${pendingSection}`,
    },
    { id: 'group-meeting', label: '组会汇报', kind: 'event', icon: 'presentation', fields: [], template: '# {{title}}\n\n## 汇报要点\n\n## 后续事项\n' },
  ],
  views: [
    { id: 'timeline', label: '时间线', layout: 'timeline', order: 'oldest', fieldIds: ['scene', 'gpu_ms', 'outcome'] },
    { id: 'journal', label: '按日期', layout: 'journal', order: 'newest' },
    { id: 'summaries', label: '阶段总结', layout: 'journal', order: 'newest', typeIds: ['stage-summary'] },
  ],
  defaultView: 'timeline',
};

const exampleRecords = [
  {
    id: 'baseline-city', type: 'experiment', title: '城市街区基线', date: '2026-11-04', phaseId: 'baseline',
    fields: { scene: 'City Block', gpu_ms: 12.8, outcome: '有效' },
    body: '# 城市街区基线\n\n城市街区这条轨迹的无剔除基线为 **12.8 ms**。固定画质采集 600 帧，按去预热后的 GPU 帧时间中位数比较后续方案。\n',
  },
  {
    id: 'tile-culling', type: 'experiment', title: '测试分块遮挡剔除', date: '2026-11-07', phaseId: 'exploration',
    fields: { scene: 'City Block', gpu_ms: 10.2, outcome: '有效' },
    body: `# 测试分块遮挡剔除

在城市街区的同一条相机轨迹上，开启分块遮挡剔除后，GPU 帧时间缩短了。两组计时均已去掉预热帧。

| 剔除设置 | GPU 帧时间中位数（ms） |
| --- | ---: |
| 关闭（基线） | 12.8 |
| 分块遮挡剔除 | 10.2 |

[城市街区基线](mekir:baseline-city)

## 待验证

逐帧核对遮挡边缘，检查是否出现闪烁。
`,
  },
  {
    id: 'conservative-depth', type: 'experiment', title: '验证保守深度阈值', date: '2026-11-11', phaseId: 'exploration',
    fields: { scene: 'City Block', gpu_ms: 10.7, outcome: '有效' },
    body: '# 验证保守深度阈值\n\n提高可见性阈值后，边缘闪烁在本次轨迹上消失。GPU 帧时间为 **10.7 ms**。\n\n## 待验证\n\n改变镜头速度重走同一轨迹，检查遮挡边缘是否仍然稳定。\n',
  },
  {
    id: 'forest-validation', type: 'experiment', title: '树林轨迹复测', date: '2026-11-13', phaseId: 'validation',
    fields: { scene: 'Forest Path', gpu_ms: 11.4, outcome: '需复测' },
    body: forestValidationReport(),
  },
  {
    id: 'exploration-review', type: 'stage-summary', title: '方案探索阶段总结', date: '2026-11-16', phaseId: 'exploration',
    coverage: { start: '2026-11-05', end: '2026-11-13' }, sources: ['tile-culling', 'conservative-depth'],
    body: `# 方案探索阶段总结

## 结论

在城市街区的同一条轨迹上，采用保守阈值后，GPU 帧时间低于无剔除基线，遮挡边缘也未见闪烁。据此选用保守阈值进入树林复测。

## 依据

| 剔除设置 | GPU 帧时间中位数（ms） | 实验记录 |
| --- | ---: | --- |
| 关闭（基线） | 12.8 | [城市街区基线](mekir:baseline-city) |
| 分块遮挡剔除 | 10.2 | [测试分块遮挡剔除](mekir:tile-culling) |
| 保守深度阈值 | 10.7 | [验证保守深度阈值](mekir:conservative-depth) |

## 待验证

在树林场景沿同一轨迹分别测量无剔除基线和保守阈值方案，检查加速能否复现。
`,
  },
];

const exampleEvidence = [
  { id: 'forest-timings', relativePath: 'timings.csv', title: '逐视角 CPU 计时表 · CSV' },
  { id: 'forest-observations', relativePath: 'forest-observations.pdf', title: '森林四视角观察报告 · PDF' },
  { id: 'forest-slides', relativePath: 'forest-briefing.pptx', title: '森林复测组会 · PPTX' },
  { id: 'forest-manifest', relativePath: 'run_manifest.json', title: '相机与绘制配置 · JSON' },
];

function newExampleProject() {
  return { ...exampleProject, id: `${exampleProject.id}-${randomUUID()}` };
}

async function createExampleProject(root) {
  const files = path.join(__dirname, 'research-example');
  const contents = await Promise.all(exampleEvidence.map(file => fs.readFile(path.join(files, file.relativePath))));
  const store = await ResearchStore.initialize(root, newExampleProject(), exampleRecords);
  const directory = path.join(store.root, '示例证据');
  await fs.mkdir(directory);
  await Promise.all(exampleEvidence.map((file, i) => fs.writeFile(path.join(directory, file.relativePath), contents[i], { flag: 'wx' })));
  const sourceId = 'forest-samples';
  await store.bindEvidenceSource(sourceId, directory, '林地渲染样例');
  for (const { id, relativePath, title } of exampleEvidence) await store.indexEvidence(id, { sourceId, relativePath, title });
  const record = await store.read('forest-validation');
  await store.writeBatch({ records: [{
    id: record.record.id, ifRevision: record.revision, evidence: exampleEvidence.map(file => file.id),
    body: forestValidationReport(exampleEvidence),
  }] });
  return store;
}

module.exports = { exampleProject, exampleRecords, newExampleProject, createExampleProject };
