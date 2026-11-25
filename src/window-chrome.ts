import { t } from '../electron/i18n.mjs';
import { icon } from './icons';
import './window-chrome.css';

export function installWindowChrome(platform: string, fitted: boolean, notify: (message: string, error: boolean) => void) {
  if (platform !== 'win32' && platform !== 'darwin') return;
  const shell = document.querySelector<HTMLElement>('#shell')!;
  const caption = document.createElement('header');
  caption.id = 'window-caption';
  const brand = shell.querySelector<HTMLElement>('.sidebar .brand')!;
  const sidebar = shell.querySelector<HTMLButtonElement>('.document-location [data-action="sidebar"]')!;
  caption.append(brand, sidebar);
  if (platform === 'win32') {
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'icon-button';
    menu.title = menu.ariaLabel = t("应用菜单");
    menu.setAttribute('aria-haspopup', 'menu');
    menu.setAttribute('aria-expanded', 'false');
    menu.innerHTML = icon('menu', 17);
    menu.addEventListener('click', async () => {
      if (menu.getAttribute('aria-expanded') === 'true') return;
      const { left, bottom } = menu.getBoundingClientRect();
      menu.setAttribute('aria-expanded', 'true');
      try { await window.meki.showApplicationMenu(left, bottom); }
      catch (error) { notify(String(error), true); }
      finally { menu.setAttribute('aria-expanded', 'false'); }
    });
    caption.append(menu);
  }
  shell.before(caption);
  document.body.classList.toggle('window-fitted', fitted);
  const focus = () => document.body.classList.toggle('window-inactive', !document.hasFocus());
  window.addEventListener('focus', focus);
  window.addEventListener('blur', focus);
  focus();
}
