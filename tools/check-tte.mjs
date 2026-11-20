// Decrypts a .tte file with the web page's own code: node web/tools/check-tte.mjs <file> <password>
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decrypt } from '../tte.js';

const [file, password] = process.argv.slice(2);
const plain = await decrypt(readFileSync(file), password);
process.stdout.write(gunzipSync(Buffer.from(plain)).toString('utf8'));
