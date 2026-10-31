import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function stageApplication(sourceRoot = root) {
  const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  const release = path.join(sourceRoot, 'release');
  await fs.mkdir(release, { recursive: true });
  const stage = await fs.mkdtemp(path.join(release, 'stage-'));
  const { name, productName, version, description, main, author, license, repository, homepage } = pkg;
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name, productName, version, description, main, author, license, repository, homepage }, null, 2));
  for (const file of ['dist', 'electron', 'assets', 'LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md']) {
    // Local builds may put dist on another drive through a directory junction.
    // A distributable must contain those bytes, never a link to the build machine.
    await fs.cp(path.join(sourceRoot, file), path.join(stage, file), { recursive: true, dereference: true });
  }
  return { stage, pkg, release };
}
