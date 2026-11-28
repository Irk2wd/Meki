import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from 'playwright';

const require = createRequire(import.meta.url);
const {groupHost} = require('./research-group-host.cjs');
const root = fileURLToPath(new URL('..',import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(),'mekir-group-ui-'));
const host = await groupHost();
const env = {...process.env,MEKI_TEST:'1',MEKI_USER_DATA:path.join(temp,'profile'),MEKIR_LOCAL_STATE:path.join(temp,'state'),
  MEKI_TEST_RESEARCH_PARENT:temp,MEKI_TEST_DISCARD:'discard'};
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
const results = [], errors = [];
const catalogOnly = () => assert.ok(host.calls.length > 0 && host.calls.every(p => p === '/_mekir/accounts/member.json'),host.calls.join(', '));
try {
  app = await electron.launch({executablePath:process.env.MEKI_EXECUTABLE || require('electron'),args:process.env.MEKI_EXECUTABLE ? [] : [root],env});
  // Windows runners can exercise the native vault. Other hosts may require an interactive keychain.
  if (process.platform !== 'win32') {
    await app.evaluate(({safeStorage}) => {
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async text => Buffer.from(text);
      safeStorage.decryptStringAsync = async bytes => ({result:bytes.toString()});
    });
  }
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('#shell[data-ready=true]').waitFor();
  const dialog = page.locator('#research-subscription-groups');
  const picker = () => page.locator('.research-project-switch').click();
  const library = async () => { await picker(); await page.locator('[data-subscription-groups]').click(); };
  const row = id => dialog.locator(`[data-group-project="${id}"]`);
  await library();
  await dialog.locator('[name=url]').fill(host.url);
  await dialog.locator('[name=username]').fill('member');
  await dialog.locator('[name=password]').fill('test-only');
  await dialog.locator('[type=submit]').click();
  await row('forest').waitFor();
  assert.equal(await dialog.locator('[data-group-project]').count(),2);
  assert.ok(await dialog.locator('[data-pull]').isDisabled());
  catalogOnly();
  results.push('Signing in lists projects from both groups without downloading project data');
  await dialog.locator('[data-group]').selectOption('graphics');
  assert.equal(await dialog.locator('[data-group-project]').count(),1);
  await row('forest').getByRole('checkbox').check();
  await dialog.locator('[data-group]').selectOption('render');
  assert.ok(await row('forest').getByRole('checkbox').isChecked());
  assert.ok(!await row('trail').getByRole('checkbox').isChecked());
  await dialog.locator('[data-pull]').click();
  await row('forest').locator('[data-open-copy]').waitFor();
  assert.equal(host.calls.filter(p => p.includes('/snapshots/')).length,1);
  assert.equal(host.calls.filter(p => p.includes('/media/')).length,1);
  assert.ok(!host.calls.some(p => p.startsWith('/camera/')));
  results.push('Only the selected project downloads a snapshot and thumbnails, across group filters');
  host.calls.length=0;
  await row('forest').locator('[data-open-copy]').click();
  await page.getByRole('heading',{name:'森林树冠',exact:true}).waitFor();
  await page.locator('[data-subscription-status]').filter({hasText:'按需更新'}).waitFor();
  catalogOnly();
  assert.equal(await page.locator('[data-research-new]').count(),0);
  host.calls.length=0;
  await page.locator('#research-workspace [data-action=refresh]').click();
  await page.locator('[data-subscription-status]').filter({hasText:'已同步'}).waitFor();
  assert.deepEqual(host.calls,['/_mekir/accounts/member.json','/trees/latest.json']);
  results.push('The installed read-only timeline opens the local copy and refreshes only the current project');
  await picker();
  assert.equal(await page.locator('[data-subscription]').count(),1);
  await page.locator('[data-subscription-groups]').click();
  await dialog.locator('[role=status]').filter({hasText:/^$/}).waitFor({state:'attached'});
  await row('forest').locator('summary').click();
  await row('forest').locator('[data-remove-copy]').click();
  await row('forest').getByText('仅云端').waitFor();
  assert.deepEqual(await page.evaluate(() => window.meki.previewSubscriptions()),[]);
  assert.equal((await page.evaluate(() => window.meki.previewAccounts()))[0].catalog.groups.length,2);
  assert.equal(await page.evaluate(() => localStorage.getItem('mekir.lastSubscription')),null);
  await dialog.locator('[data-groups-close]').click();
  await library();
  await row('trail').waitFor();
  assert.deepEqual(errors,[]);
  results.push('Removing a local copy preserves the account and both group memberships');
  const output = path.join(root,'test-results');
  await fs.mkdir(output,{recursive:true});
  const folder = await fs.mkdtemp(path.join(output,'group-subscriptions-'));
  await fs.writeFile(path.join(folder,'results.json'),JSON.stringify({results,errors},null,2) + '\n');
  console.log('Group browser: one login, group filtering, selective download, read-only timeline and local removal passed.');
} catch (error) {
  console.error('Requests:',host.calls,'status:',await page?.locator('dialog[open] [role=status]').allTextContents().catch(() => []),'renderer:',errors);
  throw error;
} finally {
  if (app) { await app.evaluate(({app}) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
  await host.close(); await fs.rm(temp,{recursive:true,force:true});
}
