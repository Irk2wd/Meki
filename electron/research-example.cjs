'use strict';

const exampleProject = {
  version: 1,
  id: 'render-benchmark',
  title: '实时渲染性能研究',
  description: '研究遮挡剔除对 GPU 帧时间的影响。以下记录与数值为示例数据。',
  timezone: 'Asia/Shanghai',
  instructions: [
    '每个完成的运行写一条实验记录。以运行的实际日期和固定 ID 登记，记录场景、显卡和分辨率。',
    'GPU 帧时间使用毫秒。缺少有效测量时在正文解释原因，保留原始配置、日志或报告的相对链接。',
    '阶段总结写明确切的覆盖区间，引用作出判断所用的文档 ID。',
  ],
  phases: [
    { id: 'baseline', title: '基线测量', start: '2026-11-02', end: '2026-11-06' },
    { id: 'exploration', title: '方案探索', start: '2026-11-05', end: '2026-11-13' },
    { id: 'validation', title: '复测与验证', start: '2026-11-12', end: '2026-11-18' },
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
      template: '# {{title}}\n\n## 目的\n\n## 设置与变更\n\n- 场景：{{field.scene}}\n- 显卡：{{field.gpu}}\n- 分辨率：{{field.resolution}}\n\n## 观察与结果\n\n## 结论与下一步\n',
    },
    {
      id: 'stage-summary', label: '阶段总结', kind: 'summary', description: '汇总一段时间内的研究进展，引用支持判断的记录。',
      fields: [],
      template: '# {{title}}\n\n## 结论\n\n## 依据\n\n{{sources}}\n\n## 下一步\n',
    },
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
    body: '# 城市街区基线\n\n固定相机轨迹和画质，用 600 帧建立无剔除基线。去预热后 GPU 帧时间中位数为 **12.8 ms**。后续尝试沿用这一轨迹，并比对相同帧的可见性。\n',
  },
  {
    id: 'tile-culling', type: 'experiment', title: '测试分块遮挡剔除', date: '2026-11-07', phaseId: 'exploration',
    fields: { scene: 'City Block', gpu_ms: 10.2, outcome: '有效' },
    body: '# 测试分块遮挡剔除\n\n沿用基线的相机轨迹。分块剔除将 GPU 帧时间降至 **10.2 ms**。遮挡边缘需要逐帧复核。\n',
  },
  {
    id: 'conservative-depth', type: 'experiment', title: '验证保守深度阈值', date: '2026-11-11', phaseId: 'exploration',
    fields: { scene: 'City Block', gpu_ms: 10.7, outcome: '有效' },
    body: '# 验证保守深度阈值\n\n提高可见性阈值后，边缘闪烁在本次轨迹上消失。GPU 帧时间为 **10.7 ms**。继续检验不同镜头速度下的稳定性。\n',
  },
  {
    id: 'forest-validation', type: 'experiment', title: '树林轨迹复测', date: '2026-11-13', phaseId: 'validation',
    fields: { scene: 'Forest Path', gpu_ms: 11.4, outcome: '需复测' },
    body: '# 树林轨迹复测\n\n新的轨迹覆盖较密集的植被遮挡。测得 **11.4 ms**，还需要补采同视角的基线。\n',
  },
  {
    id: 'exploration-review', type: 'stage-summary', title: '方案探索阶段总结', date: '2026-11-16', phaseId: 'exploration',
    coverage: { start: '2026-11-05', end: '2026-11-13' }, sources: ['tile-culling', 'conservative-depth'],
    body: '# 方案探索阶段总结\n\n## 结论\n\n保守阈值稳定了遮挡边缘，适合进入复测。\n\n## 依据\n\n- [测试分块遮挡剔除](mekir:tile-culling)\n- [验证保守深度阈值](mekir:conservative-depth)\n\n## 下一步\n\n补采树林场景基线，确认加速在不同场景下的稳定性。\n',
  },
];

module.exports = { exampleProject, exampleRecords };
