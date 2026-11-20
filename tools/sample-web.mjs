// Turns tools/sample.ttbackup into tools/sample-web/ (index.tte + m/<month>.tte), encrypted the way
// the app's WebSync does it. Open http://localhost:8765/?source=tools/sample-web/ with password "testwachtwoord".
// Usage: node tools/sample-web.mjs [password]
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { encrypt } from '../tte.js';

const password = process.argv[2] || 'testwachtwoord';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const lines = gunzipSync(readFileSync(here('./sample.ttbackup'))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const monthOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const body = [];
const months = new Map();
for (const o of lines.slice(1)) {
  if (o.type === 'car') { const car = { ...o.car }; delete car.plate; body.push({ type: 'car', car }); continue; }
  if (o.type !== 'trip') { body.push(o); continue; }
  const { points, ...summary } = o;
  const m = monthOf(o.startTime);
  body.push({ ...summary, m });
  if (!months.has(m)) months.set(m, []);
  months.get(m).push({ type: 'points', startTime: o.startTime, points });
}

const out = here('./sample-web/');
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}m`, { recursive: true });
const salt = crypto.getRandomValues(new Uint8Array(16));
const write = async (path, objs) => {
  const gz = gzipSync(objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  writeFileSync(out + path, await encrypt(gz, password, salt));
};
const header = { type: 'header', format: 'triptrack-web', version: 1, exported: Date.now(), trips: body.filter((o) => o.type === 'trip').length,
  months: [...months].map(([key, t]) => ({ key, trips: t.length })) };
await write('index.tte', [header, ...body]);
for (const [key, pts] of months) await write(`m/${key}.tte`, [{ type: 'header', format: 'triptrack-web-month', month: key }, ...pts]);
console.log(`${out}: index + ${months.size} months, password "${password}"`);
