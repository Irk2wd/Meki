'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveTheme } = require('../electron/theme-format.mjs');
const { windowChromeOptions, fittedWindow } = require('../electron/window-chrome.cjs');

test('Windows caption controls follow the active theme and system high contrast', () => {
  const installedThemes = [{ id: 'field-notes', base: 'linen', palette: { side: '#281f18', text: '#fff6dd' } }];
  for (const theme of ['paper', 'night', 'field-notes']) {
    const settings = { theme, installedThemes };
    const { palette } = resolveTheme(theme, installedThemes);
    const options = windowChromeOptions('win32', settings);
    assert.deepEqual(options, {
      backgroundColor: palette.bg, titleBarStyle: 'hidden', autoHideMenuBar: true,
      titleBarOverlay: { color: palette.side, symbolColor: palette.text, height: 36 },
    });
    const contrast = { background: '#000000', text: '#ffff00' };
    const accessible = windowChromeOptions('win32', settings, contrast);
    assert.equal(accessible.backgroundColor, contrast.background);
    assert.equal(accessible.titleBarOverlay.color, contrast.background);
    assert.equal(accessible.titleBarOverlay.symbolColor, contrast.text);
  }
});

test('only Windows queries snapping and all platforms recognise maximized and fullscreen windows', () => {
  const normal = { isMaximized: () => false, isFullScreen: () => false };
  assert.equal(fittedWindow({ ...normal, isSnapped: () => true }, 'win32'), true);
  assert.equal(fittedWindow({ ...normal, isSnapped: () => false }, 'win32'), false);
  for (const platform of ['darwin', 'linux']) {
    assert.equal(fittedWindow(normal, platform), false);
    assert.equal(fittedWindow({ ...normal, isMaximized: () => true }, platform), true);
    assert.equal(fittedWindow({ ...normal, isFullScreen: () => true }, platform), true);
  }
  assert.equal(windowChromeOptions('darwin', { theme: 'night' }).titleBarStyle, 'hiddenInset');
  assert.deepEqual(windowChromeOptions('linux', { theme: 'night' }), { backgroundColor: resolveTheme('night').palette.bg });
});
