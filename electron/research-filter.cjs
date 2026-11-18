'use strict';

const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase();
const categoryLabels = {
  asset_build: '资产构建 候选', quality: '质量 画质', performance: '性能 计时 帧时间',
  reconstruction_compare: '重建 对照', diagnostics: '诊断', legacy_archive: '历史 归档',
};

function researchMatcher(filter, project) {
  const categories = normalize(filter.query);
  const months = [...categories.matchAll(/(?<!\d)(0?[1-9]|1[0-2])\s*月/g)].map(match => Number(match[1]));
  const terms = (categories.replace(/(?<!\d)(0?[1-9]|1[0-2])\s*月/g, ' ').match(/"[^"]+"|[^+\s]+/g) || [])
    .map(term => term.replace(/^"|"$/g, '')).filter(Boolean);
  const fields = (filter.fields || []).map(({ field, value }) => ({ field, value: normalize(value) }));
  const phases = new Map(project.phases.map(phase => [phase.id, phase.title]));
  const types = new Map(project.recordTypes.map(type => [type.id, type.label]));
  return ({ record, body }) => {
    if (filter.month && !record.date.startsWith(`${filter.month}-`)) return false;
    if (months.some(month => Number(record.date.slice(5, 7)) !== month)) return false;
    const run = record.run;
    const category = run?.category ? `${run.category} ${Object.hasOwn(categoryLabels, run.category) ? categoryLabels[run.category] : ''}` : '';
    const status = [run?.status, run?.missing.includes('RUN.md') ? '待补报告 report pending' : ''].filter(Boolean).join(' ');
    const runFields = { ...run?.context, id: run?.id, category, status };
    if (!fields.every(({ field, value }) => {
      const source = field.startsWith('run.') ? runFields : record.fields;
      const key = field.replace(/^run\./, '');
      return Object.hasOwn(source, key) && normalize(source[key]).includes(value);
    })) return false;
    if (!terms.length) return true;
    const haystack = normalize([record.title, record.id, record.date, phases.get(record.phaseId), types.get(record.type),
      ...Object.values(record.fields), ...Object.values(runFields), run?.directory, ...(run?.missing || []),
      ...(record.relations || []).map(relation => relation.note), body].join('\n'));
    return terms.every(term => haystack.includes(term));
  };
}

module.exports = { researchMatcher };
