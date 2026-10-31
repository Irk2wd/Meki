import { setLocale, getLocale, t } from '../electron/i18n.mjs';

// Set the process-wide UI language before importing components with static labels.
// A saved preference takes effect on the next application start, in every window.
async function boot() {
  if (!window.moye) throw new Error(t('请通过 Meki 桌面应用打开编辑器（npm start）。'));
  const state = await window.moye.boot();
  setLocale(state.locale);
  document.documentElement.lang = getLocale();
  await import('./main');
}
void boot().catch(error => {
  document.querySelector('#app')!.textContent = t('启动失败：{0}', String(error));
});
