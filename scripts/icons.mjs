import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
await fs.mkdir(assets, { recursive: true });
const source = 'src/brand-mark.svg';
const mark = await fs.readFile(path.join(root, source));
// Share the sidebar artwork, with transparent padding for desktop icon spacing.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(64 64) scale(28)">${mark.toString('utf8').trim()}</g></svg>`;
await fs.writeFile(path.join(assets, 'icon.svg'), svg);
const png = async size => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer();
await fs.writeFile(path.join(assets, 'icon.png'), await png(512));
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map(png));
const icoHeader = Buffer.alloc(6 + sizes.length * 16);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(sizes.length, 4);
let offset = icoHeader.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  icoHeader[entry] = sizes[i] % 256; icoHeader[entry + 1] = sizes[i] % 256;
  icoHeader.writeUInt16LE(1, entry + 4); icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(images[i].length, entry + 8); icoHeader.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await fs.writeFile(path.join(assets, 'icon.ico'), Buffer.concat([icoHeader, ...images]));
const icnsParts = await Promise.all([[128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(async ([size, type]) => {
  const data = await png(size), header = Buffer.alloc(8); header.write(type); header.writeUInt32BE(data.length + 8, 4); return Buffer.concat([header, data]);
}));
const header = Buffer.alloc(8); header.write('icns'); header.writeUInt32BE(8 + icnsParts.reduce((n, b) => n + b.length, 0), 4);
await fs.writeFile(path.join(assets, 'icon.icns'), Buffer.concat([header, ...icnsParts]));
// Original DMG artwork. Finder supplies the app and Applications icons above it.
const background = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
  <defs><linearGradient id="paper" x2="1" y2="1"><stop stop-color="#FFF5F0"/><stop offset=".52" stop-color="#F3EDFB"/><stop offset="1" stop-color="#E7F6F5"/></linearGradient></defs>
  <rect width="540" height="380" fill="url(#paper)"/>
  <text x="270" y="76" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" fill="#303053">mekiR</text>
  <path d="M238 200h64m-13-13 13 13-13 13" stroke="#6D608D" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <text x="270" y="320" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#51466D">Drag mekiR to Applications</text>
</svg>`;
await fs.writeFile(path.join(assets, 'installer-background.png'), await sharp(Buffer.from(background)).png().toBuffer());

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generated = ['icon.icns', 'icon.ico', 'icon.png', 'icon.svg', 'installer-background.png'];
const manifest = {
  schema: 1,
  generator: 'scripts/icons.mjs',
  generatorSha256: digest(await fs.readFile(fileURLToPath(import.meta.url))),
  source: { path: source, sha256: digest(mark) },
  assets: await Promise.all(generated.map(async name => ({
    path: `assets/${name}`, sha256: digest(await fs.readFile(path.join(assets, name))),
    license: 'MIT', origin: 'scripts/icons.mjs',
  }))),
};
await fs.writeFile(path.join(assets, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Generated mekiR icons and provenance.');
