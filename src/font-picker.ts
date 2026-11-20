import { getLocale, ht, t } from '../electron/i18n.mjs';
import { isLocalFontName } from '../electron/theme-format.mjs';
import writingFonts from '../electron/writing-fonts.json' with { type: 'json' };
import type { Settings } from '../shared/meki';
import { fontGroups, installedFamilies, type FontGroup, type LocalFamily } from './local-fonts';

type FontSettings = Pick<Settings, 'font' | 'fontFamily'>;

export class FontPicker {
  private presets: HTMLSelectElement;
  private current = new Option('', 'local');
  private library: HTMLDetailsElement;
  private search: HTMLInputElement;
  private category: HTMLSelectElement;
  private han: HTMLInputElement;
  private list: HTMLSelectElement;
  private status: HTMLOutputElement;
  private manual: HTMLButtonElement;
  private families?: LocalFamily[];
  private loading = false;
  private revision = 0;
  private selected = '';

  constructor(root: HTMLElement, private change: (patch: Partial<FontSettings>) => void) {
    root.innerHTML = `<label class="setting-row">${ht("正文字体")}<select id="font-family"></select></label>
      <p class="font-specimen" aria-label="${ht("字体预览")}"><span>天地山川</span><span lang="en">Aa 0123</span></p>
      <details class="font-library"><summary>${ht("浏览本机字体")}</summary>
        <input id="custom-font" type="search" maxlength="128" autocomplete="off" spellcheck="false"
          aria-label="${ht("搜索或输入字体名称")}" placeholder="${ht("搜索或输入字体名称")}">
        <div class="font-filters"><select aria-label="${ht("字体分类")}">
          <option value="">${ht("全部分类")}</option><option value="serif">${ht("衬线")}</option>
          <option value="sans">${ht("无衬线")}</option><option value="mono">${ht("等宽")}</option>
          <option value="script">${ht("手写")}</option></select>
          <label><input type="checkbox"> ${ht("含汉字")}</label></div>
        <select id="installed-fonts" size="5" aria-label="${ht("本机字体列表")}"></select>
        <div class="font-results"><output aria-live="polite"></output><button type="button" hidden>${ht("使用输入的名称")}</button></div>
      </details>`;
    this.presets = root.querySelector('#font-family')!;
    this.library = root.querySelector('details')!;
    this.search = root.querySelector('#custom-font')!;
    this.category = root.querySelector('.font-filters select')!;
    this.han = root.querySelector('[type=checkbox]')!;
    this.list = root.querySelector('#installed-fonts')!;
    this.status = root.querySelector('output')!;
    this.manual = root.querySelector('button')!;
    for (const [id, preset] of Object.entries(writingFonts)) this.presets.add(new Option(t(preset.label), id));
    this.presets.add(this.current);
    this.presets.onchange = () => {
      const font = this.presets.value as Settings['font'];
      if (Object.hasOwn(writingFonts, font)) this.change({ font, fontFamily: '' });
    };
    this.library.ontoggle = () => { void this.refresh(); };
    this.search.oninput = this.category.onchange = this.han.onchange = () => { void this.refresh(); };
    this.list.onchange = () => { if (this.list.value) this.change({ fontFamily: this.list.value }); };
    this.manual.onclick = () => this.change({ fontFamily: this.search.value.trim() });
    this.search.onkeydown = event => {
      if (event.isComposing || !['ArrowDown', 'Enter'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        if (this.list.options.length) this.list.focus();
        return;
      }
      const name = this.search.value.trim().toLocaleLowerCase();
      const exact = [...this.list.options].find(option => option.value.toLocaleLowerCase() === name);
      if (name && (exact || this.list.options.length === 1)) this.change({ fontFamily: (exact ?? this.list.options[0]).value });
      else if (this.list.options.length) this.list.focus();
      else if (!this.manual.hidden) this.manual.click();
    };
  }

  apply(settings: FontSettings) {
    this.selected = settings.fontFamily;
    this.current.hidden = !this.selected;
    this.current.textContent = this.selected;
    this.presets.value = this.selected ? 'local' : settings.font;
    this.list.value = this.selected;
  }

  private show(families: LocalFamily[]) {
    const chinese = getLocale() === 'zh-CN';
    this.list.replaceChildren(...families.map(({ face, chineseName }) => {
      const label = chinese && chineseName && chineseName !== face.family ? `${chineseName} · ${face.family}` : face.family;
      return new Option(label, face.family);
    }));
    this.list.value = this.selected;
    this.list.hidden = !families.length;
  }

  private async refresh(): Promise<void> {
    const version = ++this.revision;
    if (!this.library.open) {
      if (!this.families?.length) this.families = undefined;
      return;
    }
    const name = this.search.value.trim();
    const query = name.toLocaleLowerCase();
    const category = this.category.value as FontGroup | '';
    const han = this.han.checked;
    if (!this.families && !this.loading) {
      this.loading = true;
      this.status.textContent = t("正在读取本机字体…");
      try { this.families = await installedFamilies(getLocale()); }
      catch { this.families = []; }
      this.loading = false;
      return this.refresh();
    }
    if (!this.families) return;
    const candidates = this.families.filter(({ face, chineseName }) => face.family.toLocaleLowerCase().includes(query) || chineseName?.includes(query));
    this.manual.hidden = !name || !isLocalFontName(name) || !!category || han || candidates.some(({ face }) => face.family.toLocaleLowerCase() === query);
    let matches = candidates;
    if (category || han) {
      const included = ({ groups }: LocalFamily) => !!groups && (!category || groups.includes(category)) && (!han || groups.includes('han'));
      if (candidates.some(family => !family.groups)) {
        this.show(candidates.filter(included));
        this.status.textContent = t("正在读取字体分类…");
        // Font blobs can be large. Read one representative face at a time and stop when the filter changes.
        for (const family of candidates) {
          if (version !== this.revision) return;
          if (!family.groups) await fontGroups(family);
        }
        if (version !== this.revision) return;
      }
      matches = candidates.filter(included);
    }
    this.show(matches);
    this.status.textContent = matches.length ? t("{0} 款字体", matches.length)
      : this.families.length ? t("没有匹配的字体") : t("无法列出本机字体，可输入字体名称。");
  }
}
