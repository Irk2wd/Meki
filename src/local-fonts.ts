import { isLocalFontName } from '../electron/theme-format.mjs';

export type FontGroup = 'han' | 'serif' | 'sans' | 'mono' | 'script';
interface LocalFace { family: string; style: string; blob(): Promise<Blob> }
export interface LocalFamily { face: LocalFace; chineseName?: string; groups?: FontGroup[]; reading?: Promise<FontGroup[]> }

// System fonts may expose only a Latin name and omit their design classification.
const commonFamilies: { names: string[]; chineseName?: string; groups: FontGroup[] }[] = [
  { names: ['Songti SC', 'Songti TC', 'SimSun', '宋体'], chineseName: '宋体', groups: ['han', 'serif'] },
  { names: ['STFangsong', 'FangSong', '仿宋'], chineseName: '仿宋', groups: ['han', 'serif'] },
  { names: ['Kaiti SC', 'Kaiti TC', 'KaiTi', 'STKaiti', '楷体'], chineseName: '楷体', groups: ['han', 'script'] },
  { names: ['Yuanti SC', 'Yuanti TC'], chineseName: '圆体', groups: ['han', 'sans'] },
  { names: ['YouYuan', '幼圆'], chineseName: '幼圆', groups: ['han', 'sans'] },
  { names: ['PingFang SC', 'PingFang TC', 'PingFang HK'], chineseName: '苹方', groups: ['han', 'sans'] },
  { names: ['Microsoft YaHei', '微软雅黑'], chineseName: '微软雅黑', groups: ['han', 'sans'] },
  { names: ['Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC'], chineseName: '思源宋体', groups: ['han', 'serif'] },
  { names: ['Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC'], chineseName: '思源黑体', groups: ['han', 'sans'] },
  { names: ['Helvetica Neue'], groups: ['sans'] },
];
const byFamilyName = new Map(commonFamilies.flatMap(info => info.names.map(name => [name, info] as const)));

export async function installedFamilies(locale: string): Promise<LocalFamily[]> {
  const browser = window as Window & { queryLocalFonts?: () => Promise<LocalFace[]> };
  if (!browser.queryLocalFonts) throw new Error('Local font access is unavailable');
  const families = new Map<string, LocalFace>();
  for (const face of await browser.queryLocalFonts()) {
    if (!face.family || !isLocalFontName(face.family)) continue;
    if (!families.has(face.family) || /^(regular|normal|roman|book)$/i.test(face.style)) families.set(face.family, face);
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  const list = [...families.values()].map(face => {
    const known = byFamilyName.get(face.family);
    return { face, groups: known?.groups, chineseName: known?.chineseName };
  });
  const label = (item: LocalFamily) => (locale === 'zh-CN' && item.chineseName) || item.face.family;
  return list.sort((a, b) => collator.compare(label(a), label(b)) || collator.compare(a.face.family, b.face.family));
}

// A symbol font can advertise the CJK Unicode range for just one pictograph.
// Look up a few common Han characters in its Unicode cmap before offering it for text.
function coversHanText(cmap: DataView): boolean | undefined {
  const characters = [0x4e2d, 0x6587, 0x5c71]; // 中、文、山
  if (cmap.byteLength < 4) return undefined;
  let supported = false;
  for (let i = 0; i < cmap.getUint16(2); i++) {
    const entry = 4 + 8 * i;
    if (entry + 8 > cmap.byteLength) break;
    const platform = cmap.getUint16(entry), encoding = cmap.getUint16(entry + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const offset = cmap.getUint32(entry + 4);
    if (offset + 16 > cmap.byteLength) continue;
    const format = cmap.getUint16(offset);
    if (format !== 4 && format !== 12) continue;
    const length = format === 4 ? cmap.getUint16(offset + 2) : cmap.getUint32(offset + 4);
    if (length < 16 || offset + length > cmap.byteLength) continue;
    const table = new DataView(cmap.buffer, cmap.byteOffset + offset, length);
    if (format === 12) {
      const count = table.getUint32(12);
      if (16 + 12 * count > length) continue;
      supported = true;
      if (characters.every(code => {
        for (let at = 16; at < 16 + 12 * count; at += 12) {
          const start = table.getUint32(at);
          if (code < start) break;
          if (code <= table.getUint32(at + 4)) return table.getUint32(at + 8) + code - start !== 0;
        }
        return false;
      })) return true;
    } else {
      const span = table.getUint16(6); // Byte length of each of the four segment arrays.
      if (span % 2 || 16 + 4 * span > length) continue;
      supported = true;
      if (characters.every(code => {
        for (let i = 0; i < span; i += 2) {
          if (code > table.getUint16(14 + i)) continue;
          const start = table.getUint16(16 + span + i);
          if (code < start) return false;
          const delta = table.getInt16(16 + 2 * span + i);
          const range = 16 + 3 * span + i, displacement = table.getUint16(range);
          if (!displacement) return ((code + delta) & 0xffff) !== 0;
          const glyphAt = range + displacement + 2 * (code - start);
          if (glyphAt + 2 > length) return false;
          const glyph = table.getUint16(glyphAt);
          return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
        }
        return false;
      })) return true;
    }
  }
  return supported ? false : undefined;
}

// Read the SFNT table directory and character and design metadata, never the glyph outlines.
async function classify(face: LocalFace): Promise<FontGroup[]> {
  const blob = await face.blob();
  const view = async (start: number, length: number) => new DataView(await blob.slice(start, start + length).arrayBuffer());
  const header = await view(0, 12);
  if (header.byteLength < 12 || header.getUint32(0) === 0x74746366) return []; // TTC collection
  const length = header.getUint16(4) * 16;
  if (12 + length > blob.size) return [];
  const directory = await view(12, length);
  const groups: FontGroup[] = [];
  let cmap: DataView | undefined, advertisesHan = false;
  for (let at = 0; at < length; at += 16) {
    const tag = directory.getUint32(at);
    const offset = directory.getUint32(at + 8), size = directory.getUint32(at + 12);
    if (offset + size > blob.size) continue;
    if (tag === 0x636d6170) cmap = await view(offset, size); // cmap
    if (tag === 0x706f7374 && size >= 16) { // post.isFixedPitch
      if ((await view(offset + 12, 4)).getUint32(0)) groups.push('mono');
    }
    if (tag !== 0x4f532f32 || size < 50) continue; // OS/2
    const os2 = await view(offset, Math.min(size, 82));
    const codePages = os2.byteLength >= 82 && os2.getUint16(0) >= 1 ? os2.getUint32(78) : 0;
    advertisesHan = Boolean((codePages & ((1 << 18) | (1 << 20))) || (os2.getUint32(46) & (1 << 27)));
    const family = os2.getUint8(30), panose = os2.getUint8(32), serif = os2.getUint8(33);
    if ((family >= 1 && family <= 5) || family === 7 || (panose === 2 && serif >= 2 && serif <= 10)) groups.push('serif');
    if (family === 8 || (panose === 2 && serif >= 11 && serif <= 15)) groups.push('sans');
    if (family === 10 || panose === 3) groups.push('script');
    if (panose === 2 && os2.getUint8(35) === 9) groups.push('mono');
  }
  if ((cmap && coversHanText(cmap)) ?? advertisesHan) groups.push('han');
  return [...new Set(groups)];
}

export function fontGroups(family: LocalFamily): Promise<FontGroup[]> {
  // Several keystrokes can request the same family while its tables are being read.
  return family.reading ??= classify(family.face).catch(() => []).then(groups => family.groups = groups);
}
