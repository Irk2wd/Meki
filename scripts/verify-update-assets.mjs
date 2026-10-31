import fs from 'node:fs';
import path from 'node:path';
import { verifyUpdateAssets } from './update-assets.mjs';
const file = path.resolve(process.argv[2]);
await verifyUpdateAssets(JSON.parse(fs.readFileSync(file, 'utf8')), path.dirname(file));
console.log('Signed update assets match the tested installer.');
