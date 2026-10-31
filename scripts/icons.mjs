import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.join(root, 'assets');
await fs.mkdir(assets, { recursive: true });
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="236" fill="#416b5b"/><path d="M288 752V374l224 224 224-224v378M288 278l224 224 224-224" fill="none" stroke="#fffdf4" stroke-width="50" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
console.log('Generated original Meki icons.');
// Original DMG artwork. Finder supplies the app and Applications icons above it.
const background = '<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380"><rect width="540" height="380" fill="#faf9f4"/><text x="270" y="64" text-anchor="middle" font-family="Arial,sans-serif" font-size="30" fill="#294b3e">Meki</text><text x="270" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="#68746c">A quiet place to write.</text><path d="M238 200h64m-13-13 13 13-13 13" fill="none" stroke="#416b5b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><text x="270" y="320" text-anchor="middle" font-family="Arial,sans-serif" font-size="15" fill="#416b5b">Drag Meki to Applications</text></svg>';
await fs.writeFile(path.join(assets, 'installer-background.png'), await sharp(Buffer.from(background)).png().toBuffer());
