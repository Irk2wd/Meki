'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configureApp } = require('../electron/app-identity.cjs');

test('mekiR starts with its own application identity and leaves existing Meki drafts in their profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meki-identity-'));
  t.after(() => { const target = fs.realpathSync(root); assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir())); fs.rmSync(target, { recursive: true }); });
  fs.mkdirSync(path.join(root, 'Meki'));
  const originalDraft = path.join(root, 'Meki', 'recovery.json');
  fs.writeFileSync(originalDraft, '\ufeff{"text":"unsaved draft"}');
  const app = { getPath: () => root, setName: value => { app.name = value; }, setPath: (_name, value) => { app.profile = value; }, setAppUserModelId: value => { app.id = value; } };
  configureApp(app, { userData: '' });
  assert.equal(app.name, 'mekiR'); assert.equal(app.profile, path.join(root, 'mekiR')); assert.equal(app.id, 'io.meki.research');
  assert.equal(fs.existsSync(path.join(app.profile, 'recovery.json')), false);
  assert.equal(fs.readFileSync(originalDraft, 'utf8'), '\ufeff{"text":"unsaved draft"}');
  const isolated = path.join(root, 'isolated-test-profile'); configureApp(app, { userData: isolated });
  assert.equal(app.profile, isolated);
});
