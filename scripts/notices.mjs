import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const overrides = JSON.parse(await fs.readFile(path.join(root, 'licenses/overrides.json'), 'utf8'));
const notices = ['Meki third-party notices\n\nProject source: MIT (see LICENSE). Third-party components retain their own licenses.\nIncludes installed application libraries and development tooling from package-lock.json.\nElectron/Chromium licenses are also included alongside the executable.\nOptional native packages vary by build platform; a development dependency is not necessarily shipped.'];
let count = 0;

async function licenseFiles(directory, prefix = '', depth = 0, excluded = new Set()) {
  const documents = [];
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (excluded.has(entry.name)) continue;
    const relative = prefix + entry.name;
    if (entry.isFile() && /^(licen[cs]e|copying|copyright|ofl|notice)([._-]|$)/i.test(entry.name)) documents.push({ name: relative, text: await fs.readFile(path.join(directory, entry.name), 'utf8') });
    else if (entry.isDirectory() && depth < 2 && !['node_modules', '.git'].includes(entry.name)) documents.push(...await licenseFiles(path.join(directory, entry.name), relative + '/', depth + 1, excluded));
  }
  return documents;
}

for (const [relative, locked] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right, 'en'))) {
  if (!relative) continue;
  const folder = path.join(root, relative);
  let pkg;
  try { pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && locked.optional) continue; throw error; }
  if (pkg.version !== locked.version) throw new Error(`Installed dependency differs from lock: ${relative}`);
  const id = `${pkg.name}@${pkg.version}`, override = overrides[id];
  const license = override?.license || pkg.license || locked.license;
  if (typeof license !== 'string' || /UNKNOWN|UNLICENSED|SEE LICENSE/i.test(license)) throw new Error(`Review the license of ${id}`);
  // The optional downloaded Electron runtime carries its own adjacent licenses;
  // it is absent in Source CI and is not part of this package's source notices.
  const docs = await licenseFiles(folder, '', 0, new Set(pkg.name === 'electron' ? ['dist'] : []));
  for (const entry of override?.files || []) {
    if (!entry.path.startsWith('licenses/upstream/') || entry.path.includes('..')) throw new Error(`Invalid license override: ${id}`);
    const bytes = await fs.readFile(path.join(root, entry.path));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`License override checksum mismatch: ${id}`);
    docs.push({ name: entry.path, text: `Preserved source: ${entry.url}\n\n${bytes.toString('utf8')}` });
  }
  if (!docs.length) throw new Error(`Missing license text for ${id}; preserve the upstream text in licenses/overrides.json.`);
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || '';
  notices.push(`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${license}\nSource: ${repository}`);
  if (pkg.name === 'elkjs') notices.push(`Corresponding upstream source: https://github.com/kieler/elkjs/tree/${pkg.version}\nThe unmodified ELK component retains EPL-2.0; the project's MIT license does not replace it.`);
  if (override?.reason) notices.push(override.reason);
  if (override?.packageSource) notices.push(`Locked package archive: ${override.packageSource}`);
  if (override?.author) notices.push(`Author metadata: ${typeof override.author === 'string' ? override.author : JSON.stringify(override.author)}`);
  for (const doc of docs) notices.push(`\n--- ${doc.name} ---\n${doc.text}`);
  count++;
}
const text = notices.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n';
const target = path.join(root, 'THIRD_PARTY_NOTICES.txt');
if (process.argv.includes('--check')) {
  const current = (await fs.readFile(target, 'utf8')).replace(/\r\n/g, '\n');
  const divider = new RegExp(`\\n${'='.repeat(72)}\\n`);
  const blocks = document => document.split(divider).map(block => block.trim());
  const expected = blocks(text), actual = blocks(current);
  const key = block => { const lines = block.split('\n'); return `${lines[0]}@${lines[1] || ''}`; };
  const declared = new Map(actual.slice(1).map(block => [key(block), block]));
  // A clean npm ci may omit optional packages present on another build host.
  // Extra notices are valid only for versions still present in this exact lock.
  const locked = new Set(Object.entries(lock.packages).filter(([name]) => name).map(([name, pkg]) => `${name.split('node_modules/').pop()} ${pkg.version}@License: ${overrides[`${name.split('node_modules/').pop()}@${pkg.version}`]?.license || pkg.license}`));
  if (actual[0] !== expected[0] || expected.slice(1).some(block => declared.get(key(block)) !== block) || actual.slice(1).some(block => !locked.has(key(block)))) throw new Error('Third-party notices are stale. Run node scripts/notices.mjs and review the diff.');
  console.log(`Third-party notices verified for ${count} installed packages.`);
} else { await fs.writeFile(target, text); console.log(`Generated third-party notices for ${count} installed packages.`); }
