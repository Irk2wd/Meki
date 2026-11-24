'use strict';
const { resolveTheme } = require('./theme-format.mjs');

function windowChromeOptions(platform, settings, contrast) {
  const { palette } = resolveTheme(settings.theme, settings.installedThemes);
  const backgroundColor = contrast?.background || palette.bg;
  if (platform === 'darwin') return {
    backgroundColor, titleBarStyle: 'hiddenInset', titleBarOverlay: true, trafficLightPosition: { x: 16, y: 12 },
  };
  if (platform === 'win32') return {
    backgroundColor, titleBarStyle: 'hidden', autoHideMenuBar: true,
    titleBarOverlay: { color: contrast?.background || palette.side, symbolColor: contrast?.text || palette.text, height: 36 },
  };
  return { backgroundColor };
}

function fittedWindow(win, platform) {
  return win.isMaximized() || win.isFullScreen() || (platform === 'win32' && win.isSnapped());
}

module.exports = { windowChromeOptions, fittedWindow };
