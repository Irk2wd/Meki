import type { SmartAnswer } from '../shared/research-ai';
import { ht, t } from '../electron/i18n.mjs';
import { escapeResearch as escape } from './research-tools';

const reasons = () => ({
  scope: t("在模型设置中选择服务和可读取的项目资料。"),
  empty: t("所选资料中没有找到与问题相关的证据。"),
  budget: t("已达到查询预算，以下为本地核对的证据。"),
  validation: t("模型给出的引用未通过核对，以下为本地查到的证据。"),
  provider: t("模型连接未完成，以下为本地查到的证据。"),
});
export function smartStatus(answer: SmartAnswer) {
  return answer.status==='complete' ? t("已核对回答中的引用") : reasons()[answer.reason as keyof ReturnType<typeof reasons>] || t("本地检索结果");
}

export function smartMarkup(answer: SmartAnswer) {
  const refButton = (ref:string,label:string,style:string,aria?:string) => {
    const source = answer.citations[ref];
    if (!source) return escape(label);
    const hint = aria || source.title;
    return '<button type="button" data-smart-ref="'+escape(ref)+'" class="'+style+'" title="'+escape(hint)+'" aria-label="'+escape(hint)+'">'+escape(label)+'</button>';
  };
  const markers = [...new Set(answer.claims.flatMap(claim=>claim.refs))];
  const reference = (ref:string) => {
    const citation=answer.citations[ref];
    if (!citation) return '';
    const loc=citation.locator;
    const place=loc.kind==='page' ? t("第 {0} 页",loc.page) : loc.kind==='trial' ? loc.trialId : loc.kind==='paragraph' ? loc.heading : '';
    return refButton(ref,'['+(markers.indexOf(ref)+1)+']','research-ai-reference',[citation.title,place].filter(Boolean).join(' · '));
  };
  const claims = answer.claims.map(claim => '<p>'+escape(claim.text)+' '+claim.refs.map(reference).join(' ')+'</p>').join('');
  const tables = answer.tables.map(table => {
    const headers = [...new Set(table.rows.flatMap(row=>row.cells.map(cell=>cell.label)))];
    const rows = table.rows.map(row=>{
      const cells = headers.map(header=>{
        const cell = row.cells.find(c=>c.label===header);
        if (!cell) return '<td>—</td>';
        return '<td>'+ (cell.verified ? refButton(cell.ref,cell.value,'research-ai-number',t("查看 {0} 的原始数据行",cell.value)) : /^[+-]?\d+(?:[.,]\d+)?(?:%|e[+-]?\d+)?$/i.test(cell.value) ? refButton(row.ref,cell.value,'research-ai-recorded',t("查看试次中记录的 {0}，尚未核对原表",cell.value)) : escape(cell.value)) +'</td>';
      }).join('');
      return '<tr data-smart-trial="'+escape(row.trialId)+'"><th scope="row">'+refButton(row.trialId ? row.ref : '',row.date || row.trialId,'research-ai-trial',row.trialId)+'</th>'+cells+'</tr>';
    }).join('');
    return '<section class="research-ai-table-section"><h3>'+escape(table.title)+'</h3><div class="research-ai-table-scroll"><table><thead><tr><th scope="col">'+ht("试次日期")+'</th>'+
      headers.map(label=>'<th scope="col">'+escape(label)+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div></section>';
  }).join('');
  const gaps = answer.gaps.length ? '<section class="research-ai-gaps"><h3>'+ht("证据仍有缺口")+'</h3><ul>'+answer.gaps.map(g=>'<li>'+escape(g)+'</li>').join('')+'</ul></section>' : '';
  return '<div class="research-ai-answer" data-answer-status="'+escape(answer.status)+'">'+
    (claims ? '<section class="research-ai-conclusion"><h3>'+ht("研究结论")+'</h3>'+claims+'</section>' : '') + tables + gaps +
    (answer.detail || answer.searches.length>1 ? '<details><summary>'+ht("查询详情")+'</summary>'+answer.searches.map(q=>'<p>'+escape(q)+'</p>').join('')+(answer.detail ? '<p>'+escape(answer.detail)+'</p>' : '')+'</details>' : '') + '</div>';
}
