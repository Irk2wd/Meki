'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureApp } = require('../electron/app-identity.cjs');

test('a renamed product reuses the original profile, draft bytes, signing identity and application lock location', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moye-identity-'));
  t.after(() => { const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); fs.rmSync(target, { recursive: true }); });
  fs.mkdirSync(path.join(root, 'Moye'));
  fs.writeFileSync(path.join(root, 'Moye', 'recovery.json'), '\ufeff{"text":"unsaved draft"}');
  const app = { getPath: () => root, setName: value => { app.name = value; }, setPath: (_name, value) => { app.profile = value; }, setAppUserModelId: value => { app.id = value; } };
  configureApp(app, { userData: '' });
  assert.equal(app.name, 'Meki'); assert.equal(app.profile, path.join(root, 'Moye')); assert.equal(app.id, 'io.moye.editor');
  assert.equal(fs.readFileSync(path.join(app.profile, 'recovery.json'), 'utf8'), '\ufeff{"text":"unsaved draft"}');
  assert.equal(fs.existsSync(path.join(root, 'Meki')), false);
  const isolated = path.join(root, 'isolated-test-profile'); configureApp(app, { productName: 'Meki', userData: isolated });
  assert.equal(app.profile, isolated);
});
