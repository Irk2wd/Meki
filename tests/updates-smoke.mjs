import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { keys, fixture, server } = require('./update-fixture.cjs');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const parts = pkg.version.split('.').map(Number), updateVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`, installerVersion = `${parts[0]}.${parts[1]}.${parts[2] + 2}`;
const pair = keys(), run = await fs.mkdtemp(path.join(root, 'test-results', 'updates-'));
const profile = path.join(run, 'profile'), documentPath = path.join(run, '更新期间的文稿.md');
const publicPath = path.join(run, 'verification.pem'), original = '\uFEFF# 更新检查\r\n\r\n保存我的文字。\r\n';
await fs.writeFile(documentPath, original); await fs.writeFile(publicPath, pair.publicKey);
const source = path.join(run, 'synthetic-payload'); await fs.mkdir(path.join(source, 'electron'), { recursive: true });
const main = process.env.MOYE_EXECUTABLE
  ? path.join(path.dirname(process.env.MOYE_EXECUTABLE), ...(process.platform === 'darwin' ? ['..', 'Resources'] : ['resources']), 'app.asar', 'electron', 'main.cjs')
  : path.join(root, 'electron', 'main.cjs');
await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'moye', version: updateVersion }));
await fs.writeFile(path.join(source, 'electron', 'main.cjs'), `require('node:fs').writeFileSync(require('node:path').join(require('electron').app.getPath('userData'),'updated-code-loaded.txt'),${JSON.stringify(updateVersion)});require(${JSON.stringify(main)});`);
const archive = path.join(run, 'synthetic.asar'); await require('@electron/asar').createPackage(source, archive);
const update = fixture(pair, { version: updateVersion, electron: pkg.devDependencies.electron, payload: await fs.readFile(archive) }), remote = await server(update);
const env = { ...process.env, MOYE_TEST: '1', MOYE_USER_DATA: profile, MOYE_TEST_OPEN_PATH: documentPath, MOYE_TEST_SAVE_PATH: documentPath,
  MOYE_TEST_DISCARD: 'cancel', MOYE_TEST_UPDATE_KEY: publicPath, MOYE_TEST_UPDATE_SERVER: remote.origin, MOYE_TEST_UPDATE_TOKEN: 'moye-test-token' };
delete env.ELECTRON_RUN_AS_NODE;
let app, page; const results = [], errors = [], modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const pass = name => { results.push(name); console.log(`PASS ${name}`); };
const action = name => page.locator(`[data-update="${name}"]`).click();
async function launch() {
  app = await electron.launch({ executablePath: process.env.MOYE_EXECUTABLE || require('electron'), args: process.env.MOYE_EXECUTABLE ? ['--open', documentPath] : [root, '--open', documentPath], env, timeout: 30000 });
  page = await app.firstWindow(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.show(); window.focus(); });
  await page.waitForSelector('#shell[data-ready="true"]');
}
async function exit() { if (app) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); app = null; } }
async function status(value) { await page.waitForFunction(async expected => (await window.moye.updateState()).status === expected, value); }
async function waitApply() { await page.locator('[data-update="apply"]:not(:disabled)').waitFor({ state: 'visible' }); }
try {
  await launch();
  assert.equal(remote.requests.length, 0, 'opening the editor must not contact GitHub');
  const menu = await app.evaluate(({ Menu }) => { const walk = items => items.some(item => item.label === '检查更新…' || item.submenu && walk(item.submenu.items)); return walk(Menu.getApplicationMenu().items); });
  assert.equal(menu, true);
  await page.locator('[data-action="updates"]').click(); await action('check'); await status('error');
  assert.match(await page.locator('#update-message').textContent(), /先连接/);
  await action('cli'); await action('check'); await status('available');
  assert.equal(await page.locator('#update-notes script').count(), 0);
  assert.equal(await page.evaluate(() => window.untrustedRelease), undefined);
  assert.equal(await fs.readFile(documentPath, 'utf8'), original);
  pass('sidebar and native menus open updates; private login is required, startup stays offline and release notes render as text');

  remote.slow = true; await action('download');
  // The click handler runs asynchronously; the cancel button remains available during the request.
  await status('downloading'); await action('cancel'); await status('available');
  assert.equal(await fs.access(path.join(profile, 'updates-v1', 'active.json')).then(() => true, () => false), false);
  remote.slow = false; await action('download'); await status('ready');
  assert.ok(remote.requests.filter(item => item.path.startsWith('/blob/')).every(item => !item.authorization));
  pass('downloads show progress, cancel safely and retry; credentials never reach the redirected asset host');

  await action('close');
  await page.locator('[data-mode="source"]').click(); await page.locator('#source-editor .cm-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'); await page.keyboard.insertText('\n更新前的新内容');
  await page.locator('[data-action="updates"]').click(); await action('apply');
  await waitApply();
  assert.equal(await fs.access(path.join(profile, 'update-apply-test.json')).then(() => true, () => false), false);
  assert.ok((await page.locator('#source-editor .cm-content').innerText()).includes('更新前的新内容'));
  await app.evaluate(() => { process.env.MOYE_TEST_DISCARD = 'save'; }); await action('apply');
  await waitApply();
  const applied = JSON.parse(await fs.readFile(path.join(profile, 'update-apply-test.json'), 'utf8'));
  assert.deepEqual(applied, { kind: 'payload', version: updateVersion });
  assert.ok((await fs.readFile(documentPath, 'utf8')).includes('更新前的新内容'));
  pass('canceling the unsaved-document prompt prevents activation; saving commits the document before the restart request');

  await exit(); await launch();
  assert.equal(await fs.readFile(path.join(profile, 'updated-code-loaded.txt'), 'utf8'), updateVersion);
  await page.locator('[data-action="updates"]').click();
  assert.ok((await page.locator('#update-version').textContent()).includes(`当前版本 ${updateVersion}`));
  await action('close'); await page.locator('[data-action="about"]').click();
  assert.equal(await page.locator('#about-version').textContent(), updateVersion);
  await page.locator('[data-about="updates"]').click();
  const state = JSON.parse(await fs.readFile(path.join(profile, 'updates-v1', 'active.json'), 'utf8'));
  assert.equal(state.attempt, false);
  assert.ok((await fs.readFile(documentPath, 'utf8')).includes('更新前的新内容'));
  await page.screenshot({ path: path.join(run, 'updated-version.png') });
  pass('a real Electron restart loads the verified ASAR and acknowledges startup while keeping saved document bytes');

  remote.current = fixture(pair, { version: installerVersion, electron: '99.0.0' });
  await action('check'); await status('available');
  assert.match(await page.locator('[data-update="download"]').textContent(), /安装器/);
  await action('download'); await status('ready'); assert.equal(await page.locator('[data-update="apply"]').textContent(), '打开安装器');
  await action('apply'); await waitApply();
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'update-apply-test.json'), 'utf8')).kind, 'installer');
  pass('an incompatible runtime selects and verifies the installer; the test records the launch without executing it');

  await page.locator('#update-auth summary').click(); await action('disconnect');
  await page.waitForFunction(async () => (await window.moye.updateState()).credential === 'none');
  assert.deepEqual(errors, []); pass('disconnect clears update authentication and no renderer exceptions occur');

  remote.publicAvailable = true;
  remote.current = fixture(pair, { version: installerVersion, electron: pkg.devDependencies.electron });
  await action('check'); await status('available');
  assert.equal((await page.evaluate(() => window.moye.updateState())).credential, 'none');
  assert.match(await page.locator('#update-source').textContent(), /Irk2wd\/Meki/);
  await action('download'); await status('ready');
  assert.ok(remote.requests.filter(item => item.path.startsWith('/repos/Irk2wd/Meki/')).every(item => !item.authorization));
  assert.ok((await fs.readFile(documentPath, 'utf8')).includes('更新前的新内容'));
  pass('public Meki updates check and download without login while preserving the original profile and saved document');

  await exit();
  await fs.writeFile(path.join(profile, 'updates-v1', 'payloads', `${update.manifest.asarSha256}.asar`), 'damaged cache');
  await launch(); await page.locator('[data-action="updates"]').click();
  assert.ok((await page.locator('#update-version').textContent()).includes(`当前版本 ${pkg.version}`));
  assert.match(await page.locator('#update-message').textContent(), /回退/);
  assert.ok((await fs.readFile(documentPath, 'utf8')).includes('更新前的新内容'));
  assert.deepEqual(errors, []); pass('a damaged cached update falls back to the installed editor on the next real launch and preserves documents');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(run, 'last-state.png') }).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(run, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  await exit(); await remote.close(); console.log(`Evidence: ${run}`);
}
