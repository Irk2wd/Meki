'use strict';

const { assert } = require('./research-model.cjs');
const { validId } = require('./research-preview-model.cjs');

const accountName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,127}$/.test(value);
const directoryName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value);
const title = value => typeof value === 'string' && value.trim() && value.length <= 240;
const item = value => value && validId(value.id) && title(value.title);
const unique = list => new Set(list).size === list.length;

function validateCatalog(value) {
  const invalid = '无效的订阅组清单。';
  assert(value?.format === 'mekir-subscriptions/1' && item(value.library) &&
    Array.isArray(value.projects) && Array.isArray(value.groups), invalid);
  const projects = value.projects.map(p => {
    assert(item(p) && directoryName(p.directory), invalid);
    return { id:p.id, title:p.title, directory:p.directory };
  });
  const ids = new Set(projects.map(p => p.id));
  assert(ids.size === projects.length && unique(projects.map(p => p.directory)), invalid);
  const included = new Set();
  const groups = value.groups.map(g => {
    assert(item(g) && Array.isArray(g.projects) && unique(g.projects) && g.projects.every(id => ids.has(id)), invalid);
    g.projects.forEach(id => included.add(id));
    return { id:g.id, title:g.title, projects:g.projects };
  });
  assert(unique(groups.map(g => g.id)) && included.size === projects.length, invalid);
  return { format:value.format, library:{id:value.library.id,title:value.library.title}, groups, projects };
}

async function readCatalog(dav, username) {
  assert(accountName(username), '请输入有效的订阅账号。');
  const resource = await dav.read('_mekir/accounts/' + encodeURIComponent(username) + '.json', 2 * 1024 * 1024);
  return validateCatalog(JSON.parse(resource.bytes));
}

module.exports = { readCatalog, validateCatalog, accountName };
