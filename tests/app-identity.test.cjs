'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureApp } = require('../electron/app-identity.cjs');

test('Meki startup keeps its stable profile and application identity without changing existing drafts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meki-identity-'));
  t.after(() => { const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); fs.rmSync(target, { recursive: true }); });
  fs.mkdirSync(path.join(root, 'Meki'));
  fs.writeFileSync(path.join(root, 'Meki', 'recovery.json'), '\ufeff{"text":"unsaved draft"}');
  const app = { getPath: () => root, setName: value => { app.name = value; }, setPath: (_name, value) => { app.profile = value; }, setAppUserModelId: value => { app.id = value; } };
  configureApp(app, { userData: '' });
  assert.equal(app.name, 'Meki'); assert.equal(app.profile, path.join(root, 'Meki')); assert.equal(app.id, 'io.meki.editor');
  assert.equal(fs.readFileSync(path.join(app.profile, 'recovery.json'), 'utf8'), '\ufeff{"text":"unsaved draft"}');
  assert.equal(fs.existsSync(path.join(root, 'Meki')), true);
  const isolated = path.join(root, 'isolated-test-profile'); configureApp(app, { productName: 'Meki', userData: isolated });
  assert.equal(app.profile, isolated);
});
