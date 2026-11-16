import { t } from '../electron/i18n.mjs';

export function revealFileLabel(platform: string): string {
  return platform === 'darwin' ? t("在 Finder 中显示") : platform === 'win32' ? t("在资源管理器中显示") : t("打开所在文件夹");
}
