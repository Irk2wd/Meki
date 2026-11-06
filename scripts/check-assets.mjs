import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export async function checkAssetProvenance(sourceRoot = root) {
  const issues = [];
  const directory = await fs.lstat(path.join(sourceRoot, 'assets')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!directory) return issues;
  if (!directory.isDirectory() || directory.isSymbolicLink()) return [{ path: 'assets', rule: 'asset-directory-invalid' }];
  let files;
  try { files = await fs.readdir(path.join(sourceRoot, 'assets')); }
  catch (error) { if (error.code === 'ENOENT') return issues; throw error; }
  if (!files.length) return issues;
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'assets/provenance.json'), 'utf8')); }
  catch { return [{ path: 'assets/provenance.json', rule: 'asset-provenance-missing' }]; }
  if (manifest.schema !== 1 || manifest.generator !== 'scripts/icons.mjs' || !Array.isArray(manifest.assets) || manifest.assets.length > 100) return [{ path: 'assets/provenance.json', rule: 'asset-provenance-invalid' }];
  const generator = await fs.readFile(path.join(sourceRoot, manifest.generator)).catch(() => null);
  if (!generator || digest(generator) !== manifest.generatorSha256) issues.push({ path: manifest.generator, rule: 'asset-generator-changed' });
  if (manifest.source?.path !== 'src/brand-mark.svg' || !/^[a-f0-9]{64}$/.test(manifest.source.sha256)) issues.push({ path: 'assets/provenance.json', rule: 'asset-provenance-invalid' });
  else {
    const file = path.join(sourceRoot, manifest.source.path), stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || digest(await fs.readFile(file)) !== manifest.source.sha256) issues.push({ path: manifest.source.path, rule: 'asset-source-changed' });
  }
  const registered = new Set();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.path !== 'string' || !/^assets\/[a-z0-9-]+\.(?:svg|png|ico|icns)$/.test(asset.path) || registered.has(asset.path) || asset.origin !== manifest.generator || asset.license !== 'MIT') { issues.push({ path: 'assets/provenance.json', rule: 'asset-provenance-invalid' }); continue; }
    registered.add(asset.path);
    const file = path.join(sourceRoot, asset.path), stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) { issues.push({ path: asset.path, rule: 'asset-file-invalid' }); continue; }
    if (digest(await fs.readFile(file)) !== asset.sha256) issues.push({ path: asset.path, rule: 'asset-content-changed' });
  }
  for (const name of files) if (name !== 'provenance.json' && !registered.has(`assets/${name}`)) issues.push({ path: `assets/${name}`, rule: 'asset-origin-unreviewed' });
  return issues;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const issues = await checkAssetProvenance();
  console.log(JSON.stringify({ issues }, null, 2));
  if (issues.length) process.exitCode = 1;
}
