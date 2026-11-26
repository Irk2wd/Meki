'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const built = path.join(__dirname, '../dist/search-runtime');
const components = {
  pdf: ['unpdf', 'index.mjs', 'pdf/index.mjs'],
  ppt: ['@aiden0z/pptx-renderer', 'aiden0z-pptx-renderer.browser.es.js', 'ppt.mjs'],
  xml: ['@xmldom/xmldom', 'index.js', 'xml/index.js'],
  tokenizer: ['@huggingface/tokenizers', 'tokenizers.mjs', 'tokenizer.mjs'],
  ort: ['onnxruntime-web', 'ort.wasm.min.mjs', 'ort.wasm.min.mjs'],
  wasmModule: ['onnxruntime-web', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
  wasmBinary: ['onnxruntime-web', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
};
function source(key) {
  const [pkg, name] = components[key];
  return path.join(path.dirname(require.resolve(pkg)), name);
}
function location(key) {
  const file = path.join(built, components[key][2]);
  return fs.existsSync(file) ? file : source(key);
}
const load = key => import(pathToFileURL(location(key)).href);

async function stageRuntime(output) {
  const dir = path.join(output, 'search-runtime');
  await fs.promises.mkdir(dir, { recursive: true });
  for (const [key, [, , name]] of Object.entries(components)) {
    const target = path.join(dir, name);
    if (key === 'pdf' || key === 'xml') {
      const dest = path.dirname(target);
      await fs.promises.cp(path.dirname(source(key)), dest, { recursive: true });
      // Keep package-local imports resolvable when the application ships without node_modules.
      const metadata = key === 'pdf' ? {
        name: 'unpdf', type: 'module', exports: { './pdfjs': './pdfjs.mjs' },
        imports: { '#pdfjs-decoders': './pdfjs-decoders.mjs' },
      } : { type: 'commonjs' };
      await fs.promises.writeFile(path.join(dest, 'package.json'), JSON.stringify(metadata));
    } else await fs.promises.copyFile(source(key), target);
  }
}
module.exports = { load, location, stageRuntime };
