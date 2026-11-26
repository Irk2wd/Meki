'use strict';

const { readRows } = require('./research-delimited.mjs');
const { researchLinkId } = require('./research-links.mjs');
const { markdownPassages } = require('./research-search-passages.cjs');
const numerals = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const names = ['median','mean','min','max','value'];
const markdownCells = line => line.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));
const display = text => text.replace(/!?\[([^\]]*)\]\([^)]+\)/g,'$1').replace(/[\x60*]/g,'').trim();

function trialRows(body) {
  const lines = body.split(/\r?\n/);
  return markdownPassages(body).filter(p=>p.locator.kind === 'trial').map(({locator}) => {
    let header = locator.line - 2;
    while (header > 0 && !/^\s*\|?\s*:?-+:?\s*\|/.test(lines[header])) header--;
    const columns = markdownCells(lines[Math.max(0,header-1)]), raw = markdownCells(lines[locator.line-1]);
    const links = Array.from(raw.join(' ').matchAll(/\]\((mekir:[^)]+)\)/gi), match=>researchLinkId(match[1])).filter(Boolean);
    return { locator, columns, values:raw.map(display), links:[...new Set(links)] };
  });
}

// Row numbers count logical data records after the header, including CSV fields with embedded newlines.
function parseTable(file) {
  const separator = file.kind === 'tsv' ? '\t' : ',';
  const rows = readRows(file.content,separator,0,0,50002,0,512);
  if (rows.length > 50001 || !rows.length) return null;
  return { header: rows.shift(), rows, revision:file.revision };
}

function measure(table, rule, recorded) {
  if (!table || !names.includes(rule.statistic) || !numerals.test(recorded)) return;
  const column = table.header.indexOf(rule.column);
  if (column < 0 || table.header.lastIndexOf(rule.column) !== column) return;
  const filters = Object.entries(rule.where || {}).map(([key,value])=>[table.header.indexOf(key),String(value)]);
  if (filters.some(([col])=> col < 0 || table.header.lastIndexOf(table.header[col]) !== col)) return;
  const selected = [], values = [];
  for (const [i,row] of table.rows.entries()) {
    if (!filters.every(([col,value])=>row[col]?.trim()===value)) continue;
    const raw = row[column]?.trim();
    if (!raw || !numerals.test(raw)) return;
    selected.push(i+1); values.push(Number(raw));
  }
  if (!selected.length || selected.length > 5000 || values.some(n=>!Number.isFinite(n))) return;
  values.sort((a,b)=>a-b);
  const middle = Math.floor(values.length/2);
  const aggregate = { median:()=>values.length%2 ? values[middle] : (values[middle-1]+values[middle])/2,
    mean:()=>values.reduce((a,b)=>a+b,0)/values.length,min:()=>values[0],max:()=>values.at(-1),
    value:()=>values.length===1 ? values[0] : NaN };
  const value = aggregate[rule.statistic]();
  const decimals = (recorded.match(/\.(\d+)/)?.[1].length || 0) - Number(recorded.match(/e([+-]?\d+)$/i)?.[1] || 0);
  if (!Number.isFinite(value) || Math.abs(value-Number(recorded)) > Math.max(Number.EPSILON*Math.abs(value)*4, .50000001*10**-decimals)) return;
  return { kind:'cells', rows:selected, column:column+1, revision:table.revision };
}
module.exports = { trialRows, parseTable, measure, statistics:names, numerals };
