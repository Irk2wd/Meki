'use strict';

const $ = selector => document.querySelector(selector);
const names = {group:'订阅组', project:'项目', account:'账号'};
const addLabels = {group:'新建订阅组', project:'登记项目', account:'创建账号'};
const state = {view:'group', selected:{}, query:'', data:null, draft:null, busy:false};
const esc = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
function items(kind) {
  const {groups, projects, accounts} = state.data;
  if (kind === 'group') return groups;
  if (kind === 'project') return projects;
  return accounts.map(id => ({id,title:id}));
}
const groupsFor = (field,id) => state.data.groups.filter(g => g[field].includes(id));
function note(message, error=false) {
  $('#status').textContent = message;
  $('#status').classList.toggle('error',error);
}
async function request(body) {
  const response = await fetch('/api', {method:body ? 'POST' : 'GET',credentials:'same-origin',cache:'no-store',
    headers:body ? {'Content-Type':'application/json','X-MekiR-Request':'admin'} : {},body: body && JSON.stringify(body)});
  if (!(response.headers.get('content-type') || '').includes('application/json')) throw Error('管理服务未返回清单，请检查管理账号的登录状态。');
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || '读取清单失败。'), {status:response.status});
  return result;
}
async function refresh() {
  if (state.busy) return;
  state.busy = true;
  $('#refresh').disabled = true;
  try {
    state.data = await request();
    render();
    note('');
  } catch (error) { note(error.message,true); }
  finally { state.busy = false; $('#refresh').disabled = false; }
}
function summary(kind,item) {
  if (kind === 'group') return `${item.members.length} 位成员 · ${item.projects.length} 个项目`;
  if (kind === 'project') return item.directory + '/';
  return `${groupsFor('members',item.id).length} 个订阅组`;
}
function links(title,kind,entries,empty) {
  return `<h3>${esc(title)}<span>${entries.length}</span></h3>${entries.length ? `<ul class="entries">${entries.map(e =>
    `<li><button type="button" data-jump="${kind}" data-id="${esc(e.id)}"><span>${esc(e.title)}</span><small>${esc(e.info || '')}</small></button></li>`).join('')}</ul>` : `<p class="empty">${esc(empty)}</p>`}`;
}
function renderDetail(item) {
  const kind = state.view;
  if (!item) { $('#detail').innerHTML = `<p class="empty">请选择${names[kind]}查看详情。</p>`; return; }
  let detail = `<div class="detail-head"><div><h2>${esc(item.title)}</h2>${kind === 'account' ? '' : `<small>${esc(item.id)}</small>`}</div><button type="button" id="edit">编辑</button></div>`;
  if (kind === 'group') {
    detail += links('组内项目','project',state.data.projects.filter(p => item.projects.includes(p.id)),'尚未分配项目。');
    detail += links('成员','account',item.members.map(id => ({id,title:id})),'尚未添加成员。');
  } else if (kind === 'project') {
    const url = new URL(item.directory + '/',state.data.projectOrigin + '/').href;
    detail += `<h3>WebDAV 发布地址</h3><div class="address"><code>${esc(url)}</code><button type="button" id="copy" aria-label="复制发布地址">复制</button></div>`;
    detail += links('所属订阅组','group',groupsFor('projects',item.id),'尚未分配到订阅组。');
    detail += links('可发布账号','account',item.publishers.map(id => ({id,title:id})),'尚未指定发布账号。');
  } else {
    const groups = groupsFor('members',item.id);
    detail += links('加入的订阅组','group',groups,'尚未加入订阅组。');
    const allowed = new Set(groups.flatMap(g => g.projects));
    detail += links('可访问项目','project',state.data.projects.filter(p => allowed.has(p.id) || p.publishers.includes(item.id))
      .map(p => ({...p,info:p.publishers.includes(item.id) ? '可发布' : '只读'})),'当前账号还没有项目权限。');
  }
  $('#detail').innerHTML = detail;
  $('#edit').onclick = () => form(item);
  const copy = $('#copy');
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText($('#detail code').textContent); note('已复制发布地址。'); }
    catch { note('请选中发布地址后复制。'); }
  };
}
function render() {
  if (!state.data) return;
  const kind = state.view;
  $('#library').textContent = state.data.library.title;
  $('#operator').textContent = '管理员 · ' + state.data.operator;
  $('#heading').textContent = names[kind];
  $('#create').textContent = addLabels[kind]; $('#create').disabled = false;
  for (const tab of document.querySelectorAll('[data-view]')) {
    tab.querySelector('span').textContent = items(tab.dataset.view).length;
    if (tab.dataset.view === kind) tab.setAttribute('aria-current','page'); else tab.removeAttribute('aria-current');
  }
  const query = state.query.trim().toLocaleLowerCase();
  const list = items(kind).filter(e => [e.title,e.id,e.directory || ''].some(v => v.toLocaleLowerCase().includes(query)));
  const active = list.find(i => i.id === state.selected[kind]) || list[0];
  state.selected[kind] = active?.id;
  $('#items').innerHTML = list.length ? list.map(e => `<button class="row" type="button" data-row="${esc(e.id)}" aria-pressed="${e.id === active.id}">
    <strong>${esc(e.title)}</strong><small>${esc(summary(kind,e))}</small></button>`).join('') : `<p class="empty">${query ? '没有匹配的条目。' : '清单为空。'}</p>`;
  renderDetail(active);
}
function navigate(kind,id) {
  state.view = kind; state.query = $('#filter').value = '';
  if (id) state.selected[kind] = id;
  note(''); render();
}
function field(label,name,value,options={}) {
  return `<label class="field">${esc(label)}<input name="${name}" type="${options.type || 'text'}" value="${esc(value || '')}" ${options.required ? 'required' : ''}
    ${options.readonly ? 'readonly' : ''} ${options.type === 'password' ? 'autocomplete="new-password" minlength="12"' : 'autocomplete="off"'}
    ${options.max ? `maxlength="${options.max}"` : ''}>${options.hint ? `<small>${esc(options.hint)}</small>` : ''}</label>`;
}
function choices(title,name,entries,selected) {
  const picked = new Set(selected || []);
  return `<fieldset><legend>${esc(title)}</legend><div class="choices">${entries.length ? entries.map(e =>
    `<label><input type="checkbox" name="${name}" value="${esc(e.id)}" ${picked.has(e.id) ? 'checked' : ''}>${esc(e.title)}</label>`
  ).join('') : '<small>暂无可选条目。</small>'}</div></fieldset>`;
}
function form(item) {
  const kind = state.view, creating = !item;
  state.draft = {kind,id:item?.id,creating,revision:state.data.revision};
  $('#edit-title').textContent = creating ? addLabels[kind] : '编辑' + names[kind];
  $('#error').textContent = '';
  $('#remove').hidden = creating;
  $('#remove').textContent = kind === 'project' ? '取消项目登记' : '移除' + names[kind];
  let fields = '';
  if (kind === 'account') {
    fields += field('用户名','id',item?.id,{required:true,readonly:!creating,max:128,hint:creating ? '使用英文字母、数字或 . _ @ -，以字母或数字开头。' : ''});
    fields += field(creating ? '登录密码' : '新密码（留空沿用原密码）','password','',{type:'password',required:creating,
      hint:'至少 12 个字符。生成的密码会在本次表单中显示，便于交给账号使用者。'});
    fields += '<button type="button" id="generate">生成密码</button>';
    fields += choices('加入订阅组','groups',items('group'),item ? groupsFor('members',item.id).map(g => g.id) : []);
  } else {
    fields += field('名称','title',item?.title,{required:true,max:240});
    if (kind === 'group') {
      fields += choices('组内项目','projects',items('project'),item?.projects);
      fields += choices('成员','members',items('account'),item?.members);
    } else {
      fields += field('项目 ID','id',item?.id,{required:true,readonly:!creating,max:64,hint:'与发布端的项目 ID 一致，登记后保持固定。'});
      fields += field('发布目录','directory',item?.directory,{required:true,readonly:!creating,max:96,hint:'使用单层目录名，可含英文字母、数字、短横线和下划线。'});
      fields += choices('所属订阅组','groups',items('group'),item ? groupsFor('projects',item.id).map(g => g.id) : []);
      fields += choices('可发布账号','publishers',items('account'),item?.publishers);
    }
  }
  $('#fields').innerHTML = fields;
  if ($('#generate')) $('#generate').onclick = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const input = $('#fields [name=password]');
    input.type = 'text'; input.value = Array.from(bytes,n => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[n & 63]).join('');
    input.focus(); input.select();
  };
  $('#editor').showModal();
  $('#fields input:not([readonly])')?.focus();
}
function setSaving(on) {
  state.busy = on;
  for (const control of document.querySelectorAll('#edit-form button, #edit-form input, #confirm-form button')) control.disabled = on;
}
async function save(removing) {
  if (state.busy || !state.draft) return;
  const {id,kind,creating,revision} = state.draft;
  const data = {id};
  if (!removing) {
    const values = new FormData($('#edit-form'));
    for (const name of ['id','title','directory','password']) if (values.has(name)) data[name] = values.get(name);
    for (const name of ['groups','members','projects','publishers']) data[name] = values.getAll(name);
  }
  setSaving(true); $('#error').textContent = '';
  try {
    const result = await request({revision,action:kind+'.'+(removing ? 'remove' : creating ? 'create' : 'update'),data});
    if ($('#confirm').open) $('#confirm').close();
    $('#editor').close(); state.data = result;
    navigate(kind,removing ? undefined : result.changedId);
    note(removing ? '已移除，权限已更新。' : '已保存，权限已生效。');
  } catch (error) {
    if ($('#confirm').open) $('#confirm').close();
    $('#error').textContent = error.message;
  } finally { setSaving(false); }
}
$('nav').onclick = e => { const tab = e.target.closest('[data-view]'); if (tab && state.data) navigate(tab.dataset.view); };
$('#items').onclick = e => { const row = e.target.closest('[data-row]'); if (row) { state.selected[state.view] = row.dataset.row; render(); } };
$('#detail').onclick = e => { const link = e.target.closest('[data-jump]'); if (link) navigate(link.dataset.jump,link.dataset.id); };
$('#filter').oninput = e => { state.query = e.target.value; render(); };
$('#refresh').onclick = refresh;
$('#create').onclick = () => form();
$('#edit-form').onsubmit = e => { e.preventDefault(); void save(false); };
$('#confirm-form').onsubmit = e => { e.preventDefault(); void save(true); };
$('#remove').onclick = () => {
  const {kind,id} = state.draft;
  const name = items(kind).find(i => i.id === id).title;
  const extra = {group:'成员将失去通过这个组获得的项目权限。其他组授予的权限继续有效。',
    project:'项目会从所有组中移除。服务器保留快照和图片，可用相同项目 ID 和目录重新登记。',
    account:'该账号将无法登录，组成员关系和项目发布权限会一并移除。'};
  $('#consequence').textContent = '移除「'+name+'」？'+extra[kind];
  $('#confirm').showModal();
};
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $('#editor').close());
$('[data-cancel]').onclick = () => $('#confirm').close();
for (const d of document.querySelectorAll('dialog')) d.oncancel = e => { if (state.busy) e.preventDefault(); };
$('#editor').onclose = () => { state.draft = null; $('#fields').replaceChildren(); $('#error').textContent = ''; };
void refresh();
