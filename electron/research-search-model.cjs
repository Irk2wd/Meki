'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { pathToFileURL } = require('node:url');
const runtime = require('./research-search-runtime.cjs');

const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const modelId = 'multilingual-e5-small-q8-' + revision.slice(0, 12);
const files = [
  ['tokenizer.json', 17082730, '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39'],
  ['tokenizer_config.json', 443, 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b'],
  ['onnx/model_quantized.onnx', 118308185, 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193'],
];
const searchHome = () => process.env.MEKIR_SEARCH_HOME || path.join(os.homedir(), '.mekir', 'search');
let pending, activeHome;

async function modelFile(dir, [name, size, hash]) {
  const target = path.join(dir, path.basename(name));
  try {
    if ((await fsp.stat(target)).size === size) {
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(target)) digest.update(chunk);
      if (digest.digest('hex') === hash) return target;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetch('https://huggingface.co/Xenova/multilingual-e5-small/resolve/' + revision + '/' + name, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error('Model download failed (HTTP ' + response.status + ').');
  const digest = crypto.createHash('sha256'), tmp = target + '.' + crypto.randomUUID() + '.partial';
  let length = 0;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) {
      length += chunk.length;
      if (length > size) return done(new Error('Unexpected model download size.'));
      digest.update(chunk); done(null, chunk);
    } }), fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (length !== size || digest.digest('hex') !== hash) throw new Error('Incomplete or invalid model download.');
    await fsp.rename(tmp, target);
  } finally { await fsp.rm(tmp, { force: true }); }
  return target;
}

async function openModel() {
  if (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy) {
    require('node:http').setGlobalProxyFromEnv?.();
  }
  const folder = path.join(searchHome(), 'models', modelId);
  await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
  const [tokenFile, configFile, weights] = await Promise.all(files.map(file => modelFile(folder, file)));
  const { Tokenizer } = await runtime.load('tokenizer');
  const tokenizer = new Tokenizer(JSON.parse(await fsp.readFile(tokenFile, 'utf8')), JSON.parse(await fsp.readFile(configFile, 'utf8')));
  const ort = await runtime.load('ort');
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(runtime.location('wasmModule')).href, wasm: pathToFileURL(runtime.location('wasmBinary')).href };
  ort.env.wasm.wasmBinary = await fsp.readFile(runtime.location('wasmBinary'));
  const session = await ort.InferenceSession.create(new Uint8Array(await fsp.readFile(weights)), { executionProviders: ['wasm'] });
  return { tokenizer, ort, session };
}

async function embed(texts) {
  const home = searchHome();
  if (!pending || activeHome !== home) { activeHome = home; pending = openModel().catch(error => { pending = undefined; throw error; }); }
  const { tokenizer, ort, session } = await pending;
  const tokens = texts.map(text => {
    const ids = tokenizer.encode(text).ids;
    return ids.length <= 512 ? ids : [...ids.slice(0, 511), ids.at(-1)];
  });
  const width = Math.max(...tokens.map(row => row.length)), shape = [tokens.length, width];
  const ids = new BigInt64Array(tokens.length * width).fill(1n), mask = new BigInt64Array(ids.length);
  tokens.forEach((row, i) => row.forEach((id, j) => { ids[i * width + j] = BigInt(id); mask[i * width + j] = 1n; }));
  const feeds = { input_ids: new ort.Tensor('int64', ids, shape), attention_mask: new ort.Tensor('int64', mask, shape) };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(ids.length), shape);
  const output = await session.run(feeds);
  try {
    const hidden = output[session.outputNames[0]], dimension = hidden.dims[2];
    if (dimension !== 384) throw new Error('Unexpected embedding shape.');
    return tokens.map((row, i) => {
      const vector = new Float32Array(dimension);
      for (let j = 0; j < row.length; j++) {
        const offset = (i * width + j) * dimension;
        for (let k = 0; k < dimension; k++) vector[k] += hidden.data[offset + k];
      }
      const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
      for (let k = 0; k < dimension; k++) vector[k] /= norm;
      return vector;
    });
  } finally {
    for (const tensor of [...Object.values(feeds), ...Object.values(output)]) tensor.dispose();
  }
}
module.exports = { embed, modelId, searchHome };
