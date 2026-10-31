import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipFile } from 'yazl';
const [input, output] = process.argv.slice(2).map(p => path.resolve(p));
if (!input || !output || output.startsWith(input + path.sep)) throw new Error('Usage: zip.mjs directory output.zip (outside directory)');
const zip = new ZipFile();
const stream = fs.createWriteStream(output);
const completed = new Promise((resolve, reject) => { stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); });
zip.outputStream.pipe(stream);
async function walk(dir, prefix = '') {
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name), name = prefix + entry.name;
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = (await fsp.readlink(absolute)).replaceAll('\\', '/');
      if (path.isAbsolute(target)) throw new Error(`Archive cannot contain absolute symlinks: ${name}`);
      zip.addBuffer(Buffer.from(target), name, { mode: 0o120777, mtime: stat.mtime });
    } else if (stat.isDirectory()) {
      zip.addEmptyDirectory(name, { mode: 0o40755, mtime: stat.mtime });
      await walk(absolute, name + '/');
    } else {
      const handle = await fsp.open(absolute, 'r'), magic = Buffer.alloc(4);
      await handle.read(magic, 0, 4, 0); await handle.close();
      const machO = ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic.toString('hex'));
      zip.addFile(absolute, name, { mode: machO || /\.(command|sh)$/.test(name) ? 0o100755 : 0o100644, mtime: stat.mtime });
    }
  }
}
await walk(input); zip.end(); await completed;
console.log(`Archived ${output}`);
