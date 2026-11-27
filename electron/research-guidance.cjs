'use strict';

const localSearchGuide = '查过去如何验证一个问题，用 `search <项目目录> --query "研究问题" --mode concept`。已知术语或运行编号时用 `--mode keyword`。用 `--format pptx` 或 `--format pdf` 查汇报和报告，用 `--phase`、`--from`、`--to` 限定实验时段。结果的 ID、正文段落或页码可用于核对原文。';
const modelAccessGuide = '用 `smart-config <项目目录>` 查看本机选定的模型。智能检索可读取当前项目的全部研究记录和已登记资料，提交查询时会将问题和相关证据片段发送给所选模型。';
const smartSearchGuide = '要跨试次核对基线、复测与报告时，用 `smart-search <项目目录> --query "研究问题"`。' + modelAccessGuide + '用 `claims[].refs` 和表格单元格的 `ref` 查 `citations`，按文档 ID、页码或原表行号核对原文。`partial` 与 `local` 返回本轮可用的本地证据，缺项保留为待补。';

const phaseFilingGuide = '用 describe.phaseContext 找到本次研究决定所属的阶段。一个阶段可以容纳多个具体问题。只有研究要作的决定改变时才建阶段。';
const recordFilingGuide = '先判断这次工作提供了什么研究证据。用已确认的数据更新论文全文、重绘已有图表、排版或按既定流程做例行检查，默认跳过实验归档。若作者作出新的采用决定，可在依据记录上关联论文版本并说明原因。项目明确要求跟踪写作时，使用该项目指定的记录类型。';
const continuationGuide = '写入前用 list --phase 查已有记录，再用 read 读最相关的正文和「待验证」。调参、换机位、重复测量或补基线仍在回答同一个具体问题时，沿用记录 ID，在原文的试次表追加日期、改变的条件、观察结果和证据链接，再更新开头的结论。相同试次 ID 重试时更新原行。换会话、跨日期和新 run 目录都可以继续同一条记录。只有出现可以独立判断的新问题，才在原阶段新建记录。无效、持平和反例同样是研究证据。';
const titleGuide = '标题写清正在检验的变量或比较，例如“换机位后，简化树冠还能缩短出图时间吗？”。场景、机位和模型通常放在项目字段或试次表里。当比较场景差异本身就是问题时，在标题中点明。结论放在正文首段。';
const trialGuide = '需要标记多天的实验时，在正文增加二级标题“实验试次”或“Trials”。表格前两列写“试次 ID”和“实验日期”（英文为“Trial ID”和“Date”），其余列按项目安排。每行填稳定的试次 ID 和项目时区的实际日期 YYYY-MM-DD。同一试次重新归档时更新原行，保留 record.date 的首次实验日期。read 和 list 返回从表中读取的 trials。';
const trialTable = '## 实验试次\n\n| 试次 ID | 实验日期 | 改变的条件 | 观察结果 | 原始证据 |\n| --- | --- | --- | --- | --- |';
const exampleInstruction = '按研究问题归档。先查已有实验和待验证事项，相同问题的补测沿用记录 ID。场景、显卡和分辨率写入项目字段或试次表。';
const experimentDescription = '一条实验记录回答一个具体问题，可包含多次测量和对照。';
const experimentPrompt = '<!-- 标题写要判断的问题，先写证据支持的结论和适用条件。缺少对照时写本轮观察，把要补的试次放在文末。 -->';

const previousPhaseGuide = '归档前先看 describe.phaseContext，按本轮要回答的问题选择已有阶段。调参、换机位、补基线或重跑仍服务于同一项判断时，沿用阶段 ID，为每轮实验单独记一条。研究要作的决定改变时再建阶段，在阶段说明中写明这次要判断什么。普通实验暂时找不到归属时，可先按日期记录，留待归类。';
const previousInstruction = '每个完成的运行写一条实验记录。以运行的实际日期和固定 ID 登记，记录场景、显卡和分辨率。';
const previousDescription = '一条记录对应一次完整的渲染运行或一组共同测量。';
const previousPrompt = '<!-- 同一问题的调参、换机位和补基线沿用原阶段。先写证据支持的发现和适用条件。缺少对照时写本轮实测值。 -->';
const filingSection = [phaseFilingGuide, recordFilingGuide, continuationGuide, trialGuide, titleGuide].join('\n\n');

function upgradeGuideText(text) {
  if (!text.replace(/^\uFEFF/, '').startsWith('# mekiR 研究项目的 Agent 指引')) return text;
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const section = filingSection.replaceAll('\n', newline);
  const oldSmartGuide = smartSearchGuide.replace(modelAccessGuide,'通过 `smart-config <项目目录>` 读取本机选定的模型和资料范围。');
  text = text.replace(oldSmartGuide,smartSearchGuide);
  if (!text.includes('smart-search <项目目录>')) text = text.replace(localSearchGuide,localSearchGuide+newline.repeat(2)+smartSearchGuide);
  const oldLookup = '查找同一轮运行，复用稳定记录 ID。';
  if (!text.includes(previousPhaseGuide) && !text.includes(phaseFilingGuide) && text.includes(oldLookup)) {
    text = text.replace('## 写入记录', '## 这次工作是否归档，写进哪份实验' + newline.repeat(2) + section + newline.repeat(2) + '## 写入记录');
  }
  text = text.replace(previousPhaseGuide, section).replace(oldLookup, '查找已有问题和试次，复用稳定记录 ID。');
  return text.includes(trialGuide) ? text : text.replace(continuationGuide, continuationGuide + newline.repeat(2) + trialGuide);
}

function upgradeProjectRules(project) {
  const updated = { ...project };
  if (project.instructions?.includes(previousInstruction)) {
    updated.instructions = project.instructions.map(line => line === previousInstruction ? exampleInstruction : line);
  }
  updated.recordTypes = project.recordTypes.map(type => {
    if (type.kind !== 'entry') return type;
    const description = type.description === previousDescription ? experimentDescription : type.description;
    const insert = /^## (?:实验试次|Trials)\s*$/im.test(type.template) ? experimentPrompt : experimentPrompt + '\n\n' + trialTable;
    const template = type.template.replace(previousPrompt, insert);
    return description === type.description && template === type.template ? type : { ...type, ...(description && { description }), template };
  });
  return updated.instructions === project.instructions && updated.recordTypes.every((type, i) => type === project.recordTypes[i]) ? project : updated;
}

module.exports = { localSearchGuide, smartSearchGuide, phaseFilingGuide, recordFilingGuide, continuationGuide, titleGuide, trialGuide, filingSection, trialTable,
  exampleInstruction, experimentDescription, experimentPrompt, upgradeGuideText, upgradeProjectRules };
