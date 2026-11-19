import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results');
await fs.mkdir(results, { recursive: true });
const run = await fs.realpath(await fs.mkdtemp(path.join(results, 'themes-')));
const file = path.join(run, '渲染研究手记.md');
const exported = path.join(run, 'journal.html');
const pdf = path.join(run, 'journal.pdf');
const example = path.join(root, 'docs', 'mist.meki-theme.json');
const themeFile = path.join(run, 'mist.meki-theme.json');
const markdown = `# 渲染研究手记

记录本轮场景测试的结果，比较光照、画质与逐帧开销。记录可用来复现后续的性能回归。
The comparison uses the same camera path and render resolution.

## 场景与测量

> 固定相机轨迹，按场景记录热身之后的中位值。

| 场景 | 平均帧时 |
| --- | ---: |
| 温室 | 8.6 ms |
| 河岸 | 10.2 ms |

## 汇总

\`\`\`js
const median = results.toSorted()[Math.floor(results.length / 2)];
console.log('Median frame time:', median);
\`\`\`
`;
await fs.writeFile(file, markdown);
await fs.copyFile(example, themeFile);
const env = {
  ...process.env, MEKI_TEST: '1', MEKI_USER_DATA: path.join(run, 'profile'), MEKIR_LOCAL_STATE: path.join(run, 'local-state'),
  MEKI_TEST_OPEN_PATH: file, MEKI_TEST_THEME_PACKAGE_PATH: themeFile, MEKI_TEST_EXPORT_HTML_PATH: exported,
  MEKI_TEST_EXPORT_PDF_PATH: pdf, MEKI_TEST_DISCARD: 'discard',
};
delete env.ELECTRON_RUN_AS_NODE;
const errors = [], remote = [];
let app, page;

async function ready(window) {
  window.setDefaultTimeout(15000);
  window.on('pageerror', error => errors.push(error.message));
  window.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
  await window.waitForSelector('#shell[data-ready="true"]');
  return window;
}
async function launch() {
  const args = process.env.MEKI_EXECUTABLE ? ['--editor'] : [root, '--editor'];
  app = await electron.launch({ executablePath: process.env.MEKI_EXECUTABLE || require('electron'), args, env, timeout: 30000 });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await ready(page);
}
async function close() {
  if (!app) return;
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
  app = null;
}
async function action(name) {
  await page.locator(`[data-action="${name}"]`).first().evaluate(button => button.click());
  await page.waitForFunction(() => !document.body.classList.contains('is-busy'));
}
const chosen = (window, id) => window.locator(`html[data-theme="${id}"]`).waitFor({ state: 'attached' });
const computed = (selector, property) => page.locator(selector).first().evaluate((node, property) => getComputedStyle(node).getPropertyValue(property), property);
const output = name => path.join(run, name);

try {
  await launch();
  await action('open');
  const heading = '#visual-editor .ProseMirror h1';
  await page.locator(heading).waitFor();
  const titlebarColor = await computed('.titlebar', 'color');
  for (const [id, css, expected] of [
    ['manuscript', 'border-bottom-style', 'double'],
    ['kraft', 'border-bottom-width', '2px'],
    ['graph', 'border-left-width', '4px'],
    ['cyber', 'font-family', /monospace/],
  ]) {
    await action('style');
    if (id === 'manuscript') assert.equal(await page.locator('#theme-choices button').count(), 7);
    const tile = page.locator(`#theme-choices [data-theme="${id}"]`);
    await tile.click();
    await chosen(page, id);
    assert.equal(await tile.getAttribute('aria-pressed'), 'true');
    const background = await computed('#document-scroll', 'background-image');
    const pageColor = await computed('body', 'background-color');
    assert.equal(await computed('#visual-editor .milkdown', 'background-color'), pageColor);
    assert.equal(await tile.locator('.theme-sample > span').evaluate(sample => getComputedStyle(sample).backgroundColor), pageColor);
    if (id === 'kraft') {
      assert.match(background, /^url\("data:image\/png;base64,/);
      const dimensions = await page.evaluate(async source => {
        const image = new Image();
        image.src = source;
        await image.decode();
        return [image.naturalWidth, image.naturalHeight];
      }, background.slice(5, -2));
      assert.deepEqual(dimensions, [360, 360]);
    } else assert.match(background, /gradient\(/);
    const value = await computed(heading, css);
    if (expected instanceof RegExp) assert.match(value, expected);
    else assert.equal(value, expected);
    if (id === 'cyber') {
      assert.equal(await computed('html', 'color-scheme'), 'dark');
      assert.notEqual(await computed('.titlebar', 'color'), titlebarColor);
      await page.screenshot({ path: output('theme-picker.png') });
    }
    await action('style');
    await page.screenshot({ path: output(`${id}.png`) });
    if (id === 'kraft') {
      await action('export-html');
      const html = await fs.readFile(exported, 'utf8');
      assert.ok(html.includes(`--theme-image:${background};`));
      assert.match(html, /\.meki-page\{background:var\(--bg\);\}/);
      assert.match(html, /<div class="meki-page"><article class="meki-document">/);
    }
  }
  await page.locator('[data-mode="source"]').click();
  await page.locator('#source-editor .cm-content').waitFor();
  assert.equal(await computed('#source-editor .cm-editor', 'background-color'), await computed('body', 'background-color'));
  await page.locator('[data-mode="visual"]').click();
  console.log('PASS textured themes keep the editor, source, previews and exported text on solid backgrounds');

  const newWindow = app.waitForEvent('window');
  await page.evaluate(() => window.meki.newWindow());
  const second = await ready(await newWindow);
  await chosen(second, 'cyber');
  await action('style');
  await action('install-theme-package');
  await chosen(page, 'mist-journal');
  await chosen(second, 'mist-journal');
  assert.equal(await computed(heading, 'border-bottom-width'), '2px');
  await fs.writeFile(themeFile, '{"version":2}');
  await action('install-theme-package');
  await page.locator('#toast.error').waitFor();
  assert.equal(await page.locator('#toast').textContent(), '此主题格式版本不受支持。');
  await chosen(page, 'mist-journal');
  await chosen(second, 'mist-journal');
  await action('style');
  await action('export-html');
  const html = await fs.readFile(exported, 'utf8');
  assert.match(html, /--bg:#edf3f0;/);
  assert.match(html, /repeating-linear-gradient\(0deg/);
  assert.match(html, /border-bottom:2px solid var\(--accent\)/);
  await action('export-pdf');
  assert.equal((await fs.readFile(pdf)).toString('ascii', 0, 5), '%PDF-');
  assert.equal(await fs.readFile(file, 'utf8'), markdown);
  console.log('PASS import broadcasts to open windows, rejects malformed updates, and exports the applied texture and layout');

  await close();
  await launch();
  await chosen(page, 'mist-journal');
  await action('style');
  assert.equal(await page.locator('#theme-choices [data-theme="mist-journal"]').getAttribute('aria-pressed'), 'true');
  await action('remove-theme-package');
  await chosen(page, 'paper');
  assert.equal(await page.locator('#theme-choices [data-theme="mist-journal"]').count(), 0);
  assert.equal(await computed('#document-scroll', 'background-image'), 'none');
  assert.deepEqual(errors, []);
  assert.deepEqual(remote, []);
  console.log(`PASS restart and removal work offline. Screenshots: ${run}`);
} finally {
  await close();
}
