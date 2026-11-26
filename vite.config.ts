import { defineConfig } from 'vite';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const pdfPackage = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const { stageRuntime } = createRequire(import.meta.url)('./electron/research-search-runtime.cjs');

export default defineConfig({
  base: './',
  plugins: [{
    name: 'research-pdf-resources',
    apply: 'build',
    async writeBundle({ dir }) {
      await stageRuntime(dir!);
      await Promise.all(['cmaps', 'standard_fonts', 'wasm', 'iccs'].map(folder =>
        cp(path.join(pdfPackage, folder), path.join(dir!, 'pdf-data', folder), { recursive: true })
      ));
    },
  }],
  build: { target: 'es2022', assetsInlineLimit: 100000, sourcemap: false },
});
