// TripTrack web: reads a TripTrack backup (.ttbackup, gzip JSON Lines) in the browser and shows it.
// Nothing leaves the browser; the last file is kept in IndexedDB so a reload needs no new drop.

import { decrypt, WrongPassword } from './tte.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

// ---------------------------------------------------------------- formatting

const NF = {};
const nf = (d = 0) => (NF[d] ??= new Intl.NumberFormat('nl-NL', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt = {
  num: (v, d = 0) => nf(d).format(v),
  km: (m) => nf(m >= 100_000 ? 0 : 1).format(m / 1000),
  kmh: (v, d = 0) => nf(d).format(v),
  dur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h === 0) return `${m} min`;
    return `${nf(0).format(h)} u ${m} min`;
  },
  clock(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
  },
  date: (ms) => new Date(ms).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
  dateLong: (ms) => new Date(ms).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
  dateShort: (ms) => new Date(ms).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }),
  time: (ms) => new Date(ms).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }),
  month: (y, m) => new Date(y, m, 1).toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' }),
  monthShort: (m) => new Date(2000, m, 1).toLocaleDateString('nl-NL', { month: 'short' }).replace('.', ''),
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------- domain (ported from the app)

/** "Leidsche Rijn, Utrecht" or "Utrecht" for one stored "City|district" place. */
function placeName(p) {
  if (!p) return null;
  const [c, d = ''] = p.split('|');
  return d && d !== c ? `${d}, ${c}` : c;
}

/** "Utrecht → Amersfoort"; within one city the districts; a round trip just the place. */
function routeLabel(a, b) {
  if (!a || !b) return null;
  const [c1, d1 = ''] = a.split('|');
  const [c2, d2 = ''] = b.split('|');
  if (c1 !== c2) return `${c1} → ${c2}`;
  if (d1 && d2 && d1 !== d2) return `${d1} → ${d2}`;
  return `Rondje ${c1}`;
}

function weather(code) {
  if (code == null) return null;
  if (code === 0) return 'Helder';
  if (code === 1) return 'Overwegend helder';
  if (code === 2) return 'Half bewolkt';
  if (code === 3) return 'Bewolkt';
  if ([45, 48].includes(code)) return 'Mist';
  if ([51, 53, 55, 56, 57].includes(code)) return 'Motregen';
  if ([61, 63, 65, 66, 67].includes(code)) return 'Regen';
  if ([71, 73, 75, 77].includes(code)) return 'Sneeuw';
  if ([80, 81, 82].includes(code)) return 'Regenbuien';
  if ([85, 86].includes(code)) return 'Sneeuwbuien';
  if ([95, 96, 99].includes(code)) return 'Onweer';
  return 'Onbekend';
}

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));
function limitScore(t) {
  if (t.pctOverLimit == null) return null;
  return clamp100(100 - t.pctOverLimit * 3 - Math.max(0, (t.maxOverLimitKmh ?? 0) - 10) * 2);
}
/** Weighted driving-style score; the limit part counts when the app determined limits. */
function drivingScore(t) {
  if ([t.scoreBraking, t.scoreAccel, t.scoreCornering, t.scoreSmooth].some((v) => v == null)) return null;
  const base = 0.3 * t.scoreBraking + 0.2 * t.scoreAccel + 0.2 * t.scoreCornering + 0.3 * t.scoreSmooth;
  const lim = limitScore(t);
  return Math.round(lim == null ? base : 0.75 * base + 0.25 * lim);
}
const scoreLabel = (s) => (s >= 90 ? 'Uitstekend' : s >= 75 ? 'Goed' : s >= 60 ? 'Redelijk' : 'Onrustig');

const RECORDS = [
  { key: 'top_speed', title: 'Topsnelheid', unit: 'km/u', f: (v) => fmt.num(v) },
  { key: 'best_10km', title: 'Snelste 10 km (gemiddeld)', unit: 'km/u', f: (v) => fmt.num(v, 1) },
  { key: 'nonstop_km', title: 'Langste non-stop (afstand)', unit: 'km', f: (v) => fmt.km(v * 1000) },
  { key: 'nonstop_time', title: 'Langste non-stop (tijd)', unit: '', f: (v) => fmt.dur(v) },
  { key: 'longest_trip', title: 'Langste rit', unit: 'km', f: (v) => fmt.km(v * 1000) },
  { key: 'most_week', title: 'Meeste afstand in één week', unit: 'km', f: (v) => fmt.km(v * 1000) },
  { key: 'most_month', title: 'Meeste afstand in één maand', unit: 'km', f: (v) => fmt.km(v * 1000) },
  { key: 'zero_100', title: 'Snelste 0–100 km/u', unit: 's', f: (v) => fmt.num(v, 1) },
  { key: 'max_accel', title: 'Hardste acceleratie', unit: 'm/s²', f: (v) => fmt.num(v, 2) },
  { key: 'g_corner', title: 'Hoogste g in een bocht', unit: 'g', f: (v) => fmt.num(v, 2) },
  { key: 'smooth_commute', title: 'Zachtste vaste rit (hoogste g)', unit: 'g', f: (v) => fmt.num(v, 2) },
];
const recordDef = (key) => RECORDS.find((r) => r.key === key);

const ROADS = [
  { key: 'pctUrban', label: 'Bebouwde kom', color: 'var(--road-urban)' },
  { key: 'pctRural', label: 'Buitenweg', color: 'var(--road-rural)' },
  { key: 'pctExpressway', label: 'Autoweg', color: 'var(--road-express)' },
  { key: 'pctMotorway', label: 'Snelweg', color: 'var(--road-motorway)' },
];

/** Same scale as the app's route colours. */
function speedColor(v) {
  if (v < 30) return '#1E3A8A';
  if (v < 50) return '#1D4ED8';
  if (v < 80) return '#2D7FF9';
  if (v < 100) return '#38BDF8';
  if (v < 120) return '#7DD3FC';
  return '#E0F2FE';
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------- reading a backup

/** Points [time, lat, lon, alt, speed m/s, accuracy, estimated, gLong, gLat] → typed arrays. */
function packPoints(raw) {
  const n = raw.length;
  const P = {
    n, t: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n), alt: new Float32Array(n),
    v: new Float32Array(n), est: new Uint8Array(n), gLong: new Float32Array(n), gLat: new Float32Array(n), d: new Float64Array(n),
    hasG: false, hasAlt: false,
  };
  for (let i = 0; i < n; i++) {
    const a = raw[i];
    P.t[i] = a[0]; P.lat[i] = a[1]; P.lon[i] = a[2];
    P.alt[i] = a[3] ?? NaN; if (a[3] != null) P.hasAlt = true;
    P.v[i] = (a[4] ?? 0) * 3.6;
    P.est[i] = a[6] === 1 ? 1 : 0;
    P.gLong[i] = a[7] ?? NaN; P.gLat[i] = a[8] ?? NaN;
    if (a[7] != null) P.hasG = true;
    P.d[i] = i === 0 ? 0 : P.d[i - 1] + haversine(P.lat[i - 1], P.lon[i - 1], a[1], a[2]);
  }
  return P;
}

/** Thinned route for overview maps: a point every ~30 m. */
function thin(P, minM = 30) {
  const out = [];
  let last = -Infinity;
  for (let i = 0; i < P.n; i++) {
    if (P.d[i] - last >= minM || i === P.n - 1) { out.push([P.lat[i], P.lon[i]]); last = P.d[i]; }
  }
  return out;
}

/** Reads gzip-compressed JSON Lines from a blob and hands every parsed line to onLine. */
async function readLines(blob, onLine, onProgress) {
  let read = 0;
  const counter = new TransformStream({
    transform(chunk, ctl) { read += chunk.byteLength; onProgress?.(read / blob.size); ctl.enqueue(chunk); },
  });
  const reader = blob.stream().pipeThrough(counter).pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  const handle = (line) => { if (line.trim()) onLine(JSON.parse(line)); };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    handle(buf);
  } catch (e) {
    if (e instanceof SyntaxError || /gzip|decompress|incorrect header|invalid/i.test(e.message)) {
      throw new Error('Dit bestand kan niet worden gelezen. Kies een .ttbackup-bestand uit de app.');
    }
    throw e;
  }
}

function addTrip(o, data) {
  o.hasPts = Array.isArray(o.points);
  o.pts = packPoints(o.points || []);
  delete o.points;
  o.id = o.startTime;
  o.label = routeLabel(o.startPlace, o.endPlace);
  o.score = drivingScore(o);
  o.weather = weather(o.weatherCode);
  const d = new Date(o.startTime);
  o.year = d.getFullYear(); o.month = d.getMonth();
  data.trips.push(o);
}

/** A backup file (.ttbackup) or the web index (index.tte, trips without GPS points). */
async function parseBackup(blob, onProgress) {
  const data = { header: null, car: null, records: [], segments: [], trips: [], fuel: [] };
  let first = true;
  await readLines(blob, (o) => {
    if (first) {
      first = false;
      if (o.format !== 'triptrack-backup' && o.format !== 'triptrack-web') throw new Error('Dit is geen TripTrack-back-up.');
      data.header = o;
      return;
    }
    switch (o.type) {
      case 'car': data.car = o.car; break;
      case 'record': data.records.push(o); break;
      case 'segment': data.segments.push(o); break;
      case 'fuel': data.fuel.push(o); break;
      case 'trip': addTrip(o, data); break;
    }
  }, onProgress);
  if (!data.header) throw new Error('Dit bestand is leeg.');
  data.trips.sort((a, b) => b.startTime - a.startTime);
  data.byStart = new Map(data.trips.map((t) => [t.startTime, t]));
  return data;
}

/** A month file (m/2026-11.tte): GPS points for trips already in DATA. */
async function parseMonth(blob) {
  await readLines(blob, (o) => {
    if (o.type !== 'points') return;
    const t = DATA.byStart.get(o.startTime);
    if (t) { t.pts = packPoints(o.points || []); t.hasPts = true; }
  });
}

// ---------------------------------------------------------------- online data (GitHub Pages)

/**
 * Where the encrypted data lives. On <owner>.github.io/<repo>/ it is the branch "data" of that repo;
 * ?repo=owner/name points elsewhere, ?source=<folder on this site> is for testing.
 */
const REMOTE = (() => {
  const q = new URLSearchParams(location.search);
  const src = q.get('source');
  if (src) {
    const url = new URL(src.endsWith('/') ? src : `${src}/`, location.href);
    return url.origin === location.origin ? { label: 'testgegevens', base: url.href } : null;
  }
  let repo = q.get('repo');
  if (!repo && location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    repo = seg && !seg.includes('.') ? `${owner}/${seg}` : `${owner}/${location.hostname}`;
  }
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? { label: repo, repo } : null;
})();

/** Base URL of the newest data. The commit id makes it immutable, so no cache can serve old trips. */
async function remoteBase() {
  if (REMOTE.base) return REMOTE.base;
  try {
    const r = await fetch(`https://api.github.com/repos/${REMOTE.repo}/git/ref/heads/data`, { cache: 'no-store' });
    if (r.ok) return `https://raw.githubusercontent.com/${REMOTE.repo}/${(await r.json()).object.sha}/`;
  } catch {}
  return `https://raw.githubusercontent.com/${REMOTE.repo}/data/`;
}

const PW_KEY = () => `triptrack-pw:${REMOTE?.label}`;
const savedPw = () => { try { return localStorage.getItem(PW_KEY()); } catch { return null; } };
const savePw = (pw) => { try { localStorage.setItem(PW_KEY(), pw); } catch {} };
const forgetPw = () => { try { localStorage.removeItem(PW_KEY()); } catch {} };

async function fetchTte(url, password) {
  const res = await fetch(url, { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gegevens ophalen mislukt (fout ${res.status}).`);
  return new Blob([await decrypt(await res.arrayBuffer(), password)]);
}

async function loadRemote(password, remember) {
  els.unlockError.hidden = true;
  els.unlockBtn.disabled = true;
  els.unlockBtn.textContent = 'Bezig met openen…';
  try {
    const base = await remoteBase();
    const index = await fetchTte(`${base}index.tte`, password);
    if (!index) throw new Error('Er staan nog geen ritten online. Stel in de app de webpagina in en tik op ‘Nu bijwerken’.');
    const data = await parseBackup(index);
    data.remote = { base, password, loaded: new Map() };
    data.fileName = `Online · ${REMOTE.label}`;
    DATA = data;
    if (remember) savePw(password);
    ui.year = 'all'; ui.month = null; ui.query = '';
    showData();
  } catch (e) {
    if (e instanceof WrongPassword) forgetPw();
    DATA = null;
    showUnlock(e.message || 'Openen mislukt.');
  } finally {
    els.unlockBtn.disabled = false;
    els.unlockBtn.textContent = 'Openen';
  }
}

/** Fetches the month files with the GPS points of these trips (online data only), four at a time. */
async function ensurePoints(trips, onProgress) {
  if (!DATA.remote) return;
  const keys = [...new Set(trips.filter((t) => !t.hasPts && t.m).map((t) => t.m))];
  let done = 0;
  const one = async (k) => {
    const cache = DATA.remote.loaded;
    if (!cache.has(k)) {
      cache.set(k, (async () => {
        const blob = await fetchTte(`${DATA.remote.base}m/${k}.tte`, DATA.remote.password);
        if (!blob) throw new Error(`De routes van ${k} staan niet online.`);
        await parseMonth(blob);
      })().catch((e) => { cache.delete(k); throw e; }));
    }
    await cache.get(k);
    onProgress?.(++done, keys.length);
  };
  const queue = [...keys];
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
}

// ---------------------------------------------------------------- storage (IndexedDB, best effort)

const DB_NAME = 'triptrack-web', STORE = 'files';
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbDo(mode, fn) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => res(req?.result);
      tx.onerror = () => rej(tx.error);
    });
  } catch { return undefined; }
}
const idbGet = (k) => idbDo('readonly', (s) => s.get(k));
const idbPut = (k, v) => idbDo('readwrite', (s) => s.put(v, k));
const idbDel = (k) => idbDo('readwrite', (s) => s.delete(k));

// ---------------------------------------------------------------- state

let DATA = null;
const ui = { year: 'all', month: null, sort: { key: 'startTime', dir: -1 }, query: '' };
let cleanups = [];
const onLeave = (fn) => cleanups.push(fn);

const years = () => [...new Set(DATA.trips.map((t) => t.year))].sort((a, b) => b - a);
function filtered() {
  return DATA.trips.filter((t) => (ui.year === 'all' || t.year === ui.year) && (ui.month == null || t.month === ui.month));
}

// ---------------------------------------------------------------- loading UI

const els = {
  drop: $('#drop'), box: $('#drop-box'), error: $('#drop-error'), progress: $('#progress'), bar: $('#progress-bar'),
  view: $('#view'), file: $('#file'), source: $('#source'), sourceName: $('#source-name'), sourceMeta: $('#source-meta'), tip: $('#tip'),
  unlock: $('#unlock'), unlockForm: $('#unlock-form'), unlockPw: $('#unlock-pw'), unlockRemember: $('#unlock-remember'),
  unlockBtn: $('#unlock-btn'), unlockError: $('#unlock-error'), btnOther: $('#btn-other'), btnForget: $('#btn-forget'),
};

async function load(blob, name, { save = true } = {}) {
  els.error.hidden = true;
  els.progress.hidden = false;
  els.bar.style.width = '0';
  try {
    const data = await parseBackup(blob, (f) => { els.bar.style.width = `${Math.round(f * 100)}%`; });
    DATA = data;
    DATA.fileName = name;
    if (save) await idbPut('last', { blob, name, savedAt: Date.now() });
    ui.year = 'all'; ui.month = null; ui.query = '';
    showData();
  } catch (e) {
    els.error.textContent = e.message || 'Dit bestand kan niet worden gelezen.';
    els.error.hidden = false;
    showDrop();
  } finally {
    els.progress.hidden = true;
  }
}

function showStart() {
  cleanup();
  els.view.innerHTML = '';
  els.source.hidden = true;
  $('.nav').hidden = true;
  setNav(null);
}

function showDrop() {
  showStart();
  els.unlock.hidden = true;
  els.drop.hidden = false;
}

function showUnlock(error) {
  showStart();
  els.drop.hidden = true;
  els.unlock.hidden = false;
  $('#unlock-repo').textContent = REMOTE.label;
  els.unlockError.textContent = error || '';
  els.unlockError.hidden = !error;
  els.unlockPw.value = '';
  els.unlockPw.focus();
}

function showData() {
  els.drop.hidden = true;
  els.unlock.hidden = true;
  els.source.hidden = false;
  $('.nav').hidden = false;
  els.sourceName.textContent = DATA.fileName || 'Back-up';
  const n = DATA.trips.length;
  const when = DATA.header.exported;
  els.sourceMeta.textContent = DATA.remote
    ? `${fmt.num(n)} ${n === 1 ? 'rit' : 'ritten'} · bijgewerkt ${fmt.dateShort(when)} ${fmt.time(when)}`
    : `${fmt.num(n)} ${n === 1 ? 'rit' : 'ritten'} · gemaakt ${fmt.dateShort(when)}`;
  fuelEstimates(); // sets t.estL100 for the trips table
  els.btnOther.textContent = DATA.remote ? 'Vernieuwen' : 'Ander bestand';
  els.btnForget.textContent = DATA.remote ? 'Vergrendelen' : 'Vergeten';
  route();
}

els.box.addEventListener('dragover', (e) => { e.preventDefault(); els.box.classList.add('over'); });
els.box.addEventListener('dragleave', () => els.box.classList.remove('over'));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  els.box.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) load(f, f.name);
});
$('#btn-pick').addEventListener('click', () => els.file.click());
els.btnOther.addEventListener('click', () => {
  if (DATA?.remote) loadRemote(DATA.remote.password, false);
  else els.file.click();
});
els.btnForget.addEventListener('click', async () => {
  if (DATA?.remote) forgetPw(); else await idbDel('last');
  DATA = null;
  history.replaceState(null, '', location.pathname + location.search);
  if (REMOTE) showUnlock(); else showDrop();
});
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  if (f) load(f, f.name);
  els.file.value = '';
});
els.unlockForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (els.unlockPw.value) loadRemote(els.unlockPw.value, els.unlockRemember.checked);
});
$('#unlock-file').addEventListener('click', () => showDrop());

// ---------------------------------------------------------------- routing

function setNav(view) {
  $$('.nav a').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}
function cleanup() { cleanups.forEach((f) => { try { f(); } catch {} }); cleanups = []; }

function route() {
  if (!DATA) return;
  cleanup();
  hideTip();
  const [view = 'overzicht', arg] = location.hash.replace(/^#\/?/, '').split('/');
  const views = { overzicht: viewOverview, ritten: viewTrips, rit: viewTrip, verbruik: viewFuel, kaart: viewMap, records: viewRecords };
  const fn = views[view] || viewOverview;
  setNav(view === 'rit' ? 'ritten' : views[view] ? view : 'overzicht');
  els.view.innerHTML = '';
  fn(arg);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- shared bits

function yearChips(onChange) {
  const ys = years();
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Jaar');
  const opts = [['all', 'Alles'], ...ys.map((y) => [y, String(y)])];
  for (const [v, label] of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(ui.year === v));
    b.addEventListener('click', () => { ui.year = v; ui.month = null; onChange(); });
    wrap.appendChild(b);
  }
  return wrap;
}

function head(title, sub, ...extra) {
  const h = document.createElement('header');
  h.className = 'page-head';
  h.innerHTML = `<div><h1 class="display">${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="spacer"></div>`;
  extra.filter(Boolean).forEach((e) => h.appendChild(e));
  return h;
}

function page() {
  const p = document.createElement('div');
  p.className = 'page';
  els.view.appendChild(p);
  return p;
}

const stat = (label, value, unit = '', note = '') =>
  `<div class="panel stat"><div class="label">${label}</div><div class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;

const kv = (k, v) => (v == null || v === '' ? '' : `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`);

function hbars(rows, fmtN) {
  const max = Math.max(...rows.map((r) => r[1]), 1);
  return rows.map(([label, n]) =>
    `<div class="hbar"><span>${esc(label)}</span><div class="track"><div class="fill" style="width:${(n / max) * 100}%"></div></div><span class="n">${fmtN(n)}</span></div>`).join('');
}

function roadSplit(trips) {
  const sums = ROADS.map((r) => trips.reduce((s, t) => s + (t[r.key] ?? 0) * t.distanceM, 0));
  const total = sums.reduce((a, b) => a + b, 0);
  if (total <= 0) return '<p class="muted">Nog geen wegtypes bekend.</p>';
  const pct = sums.map((s) => (s / total) * 100);
  return `<div class="split">${ROADS.map((r, i) => `<span style="width:${pct[i]}%;background:${r.color}"></span>`).join('')}</div>
    <div class="legend">${ROADS.map((r, i) => `<span><i style="background:${r.color}"></i>${r.label} <b style="color:var(--text)">${fmt.num(pct[i])}%</b></span>`).join('')}</div>`;
}

function showTip(x, y, html) { els.tip.innerHTML = html; els.tip.style.left = `${x}px`; els.tip.style.top = `${y}px`; els.tip.hidden = false; }
function hideTip() { els.tip.hidden = true; }

function tripRow(t) {
  const recs = t.recordsSet ? t.recordsSet.split(',').filter(Boolean) : [];
  return `<tr data-id="${t.id}">
    <td><div>${esc(cap(fmt.date(t.startTime)))}</div><div class="muted">${fmt.time(t.startTime)} – ${fmt.time(t.endTime ?? t.startTime)}</div></td>
    <td class="route"><a href="#/rit/${t.id}">${esc(t.label ?? t.dayPart ?? 'Rit')}</a>${recs.length ? ` <span class="badge" title="${esc(recs.map((k) => recordDef(k)?.title ?? k).join(', '))}">RECORD</span>` : ''}</td>
    <td class="num">${fmt.km(t.distanceM)} <span class="muted">km</span></td>
    <td class="num">${fmt.clock(t.totalTimeS)}</td>
    <td class="num">${fmt.kmh(t.avgMovingKmh)} <span class="muted">km/u</span></td>
    <td class="num">${fmt.kmh(t.maxSpeedKmh)} <span class="muted">km/u</span></td>
    <td class="num">${t.estL100 != null ? `${fmt.num(t.estL100, 1)} <span class="muted">l/100</span>` : '<span class="muted">–</span>'}</td>
    <td class="num">${t.score != null ? `<span class="pill">${t.score}</span>` : '<span class="muted">–</span>'}</td>
    <td>${t.weather ? `${esc(t.weather)}${t.temperatureC != null ? ` <span class="muted">${fmt.num(t.temperatureC)}°</span>` : ''}` : '<span class="muted">–</span>'}</td>
  </tr>`;
}

function bindRows(tbody) {
  tbody.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/rit/${tr.dataset.id}`;
  });
}

// ---------------------------------------------------------------- overview

function viewOverview() {
  const p = page();
  const render = () => {
    p.innerHTML = '';
    const trips = filtered();
    p.appendChild(head('Overzicht', carLine(), yearChips(render)));
    if (!trips.length) { p.insertAdjacentHTML('beforeend', '<div class="panel empty">Geen ritten in deze periode.</div>'); return; }

    const dist = trips.reduce((s, t) => s + t.distanceM, 0);
    const time = trips.reduce((s, t) => s + t.totalTimeS, 0);
    const moving = trips.reduce((s, t) => s + t.movingTimeS, 0);
    const scored = trips.filter((t) => t.score != null);
    const avgScore = scored.length ? Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length) : null;

    p.insertAdjacentHTML('beforeend', `<div class="grid g4">
      ${stat('Afstand', fmt.km(dist), 'km', `gemiddeld ${fmt.km(dist / trips.length)} km per rit`)}
      ${stat('Ritten', fmt.num(trips.length), '', `${fmt.num(new Set(trips.map((t) => new Date(t.startTime).toDateString())).size)} dagen gereden`)}
      ${stat('Rijtijd', fmt.dur(time), '', `waarvan ${fmt.dur(moving)} in beweging`)}
      ${stat('Rijstijl', avgScore ?? '–', '', avgScore != null ? `gemiddeld · ${scoreLabel(avgScore)}` : 'nog geen score')}
    </div>`);

    // Distance per month
    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<div class="panel-head"><h2 class="label">Afstand per maand</h2><div class="spacer"></div><span class="hint">Klik op een maand voor de ritten</span></div><div class="chart" id="months"></div>`;
    p.appendChild(panel);
    monthChart($('#months', panel), trips);

    // Breakdowns
    const dayParts = ['Ochtend', 'Middag', 'Avond', 'Nacht'].map((d) => [d, trips.filter((t) => t.dayPart === d).length]);
    const wd = ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'];
    const weekdays = wd.map((d, i) => [d, trips.filter((t) => (new Date(t.startTime).getDay() + 6) % 7 === i).reduce((s, t) => s + t.distanceM, 0)]);
    const wx = {};
    trips.forEach((t) => { if (t.weather) wx[t.weather] = (wx[t.weather] || 0) + 1; });
    const wxRows = Object.entries(wx).sort((a, b) => b[1] - a[1]).slice(0, 6);

    p.insertAdjacentHTML('beforeend', `<div class="grid g3">
      <section class="panel"><h2 class="label">Wegtypes</h2>${roadSplit(trips)}</section>
      <section class="panel"><h2 class="label">Dagdeel</h2>${hbars(dayParts, (n) => `${fmt.num(n)}×`)}</section>
      <section class="panel"><h2 class="label">Afstand per weekdag</h2>${hbars(weekdays, (m) => `${fmt.km(m)} km`)}</section>
    </div>`);

    const top = trips.reduce((a, t) => (t.maxSpeedKmh > (a?.maxSpeedKmh ?? -1) ? t : a), null);
    const gain = trips.reduce((s, t) => s + (t.elevGainM || 0), 0);
    const newKm = trips.reduce((s, t) => s + (t.newRoadKm || 0), 0);
    const brakes = trips.reduce((s, t) => s + (t.hardBrakeCount || 0), 0);
    const recs = trips.reduce((s, t) => s + (t.recordsSet ? t.recordsSet.split(',').filter(Boolean).length : 0), 0);
    p.insertAdjacentHTML('beforeend', `<div class="grid g2">
      <section class="panel"><h2 class="label">Meer cijfers</h2>
        ${kv('Gemiddelde snelheid (in beweging)', `${fmt.kmh(moving ? (dist / moving) * 3.6 : 0)} km/u`)}
        ${kv('Hoogste snelheid', top ? `<a href="#/rit/${top.id}">${fmt.kmh(top.maxSpeedKmh)} km/u</a>` : null)}
        ${kv('Nieuwe wegen', `${fmt.km(newKm * 1000)} km`)}
        ${kv('Geklommen', `${fmt.num(gain)} m`)}
        ${kv('Hard geremd', `${fmt.num(brakes)}×`)}
        ${kv('Records gezet', fmt.num(recs))}
      </section>
      <section class="panel"><h2 class="label">Weer bij de start</h2>${wxRows.length ? hbars(wxRows, (n) => `${fmt.num(n)}×`) : '<p class="muted">Geen weergegevens.</p>'}</section>
    </div>`);

    const last = document.createElement('section');
    last.className = 'panel';
    last.innerHTML = `<div class="panel-head"><h2 class="label">Laatste ritten</h2><div class="spacer"></div><a href="#/ritten" class="hint" style="color:var(--blue-light)">Alle ritten →</a></div>
      <div class="table-wrap"><table><tbody>${trips.slice(0, 6).map(tripRow).join('')}</tbody></table></div>`;
    p.appendChild(last);
    bindRows($('tbody', last));
  };
  render();
}

function carLine() {
  const c = DATA.car;
  if (!c) return '';
  return esc([c.brand, c.model].filter(Boolean).map((s) => cap(String(s).toLowerCase())).join(' '));
}

function monthChart(el, trips) {
  // Months from first to last trip (a selected year: all twelve).
  let start, end;
  if (ui.year !== 'all') { start = [ui.year, 0]; end = [ui.year, 11]; }
  else {
    const first = new Date(Math.min(...trips.map((t) => t.startTime)));
    const lastD = new Date(Math.max(...trips.map((t) => t.startTime)));
    start = [first.getFullYear(), first.getMonth()]; end = [lastD.getFullYear(), lastD.getMonth()];
  }
  const months = [];
  for (let y = start[0], m = start[1]; y < end[0] || (y === end[0] && m <= end[1]); m === 11 ? (y++, m = 0) : m++) {
    const ts = trips.filter((t) => t.year === y && t.month === m);
    months.push({ y, m, km: ts.reduce((s, t) => s + t.distanceM, 0) / 1000, n: ts.length });
  }
  const W = 1000, H = 240, padL = 44, padB = 34, padT = 10;
  const max = Math.max(...months.map((m) => m.km), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / months.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Afstand per maand">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmt.num(v)}</text>`;
  }
  const labelEvery = months.length > 36 ? 12 : months.length > 18 ? 3 : 1;
  months.forEach((mo, i) => {
    const x = padL + i * bw;
    const h = H - padB - y(mo.km);
    svg += `<rect class="bar" data-i="${i}" x="${x + bw * 0.18}" y="${y(mo.km)}" width="${bw * 0.64}" height="${Math.max(h, mo.km > 0 ? 2 : 0)}" rx="${Math.min(4, bw * 0.2)}"/>`;
    svg += `<rect data-i="${i}" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent" style="cursor:pointer"/>`;
    const showLabel = labelEvery === 1 ? true : labelEvery === 12 ? mo.m === 0 : mo.m % 3 === 0;
    if (showLabel) {
      svg += `<text class="axis" x="${x + bw / 2}" y="${H - padB + 16}" text-anchor="middle">${labelEvery === 12 ? mo.y : fmt.monthShort(mo.m)}</text>`;
      if (ui.year === 'all' && labelEvery !== 12 && mo.m === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - padB + 30}" text-anchor="middle">${mo.y}</text>`;
    }
  });
  svg += '</svg>';
  el.innerHTML = svg;
  const bars = $$('.bar', el);
  el.addEventListener('mousemove', (e) => {
    const i = e.target.dataset?.i;
    bars.forEach((b) => b.classList.toggle('on', b.dataset.i === i));
    if (i == null) { hideTip(); return; }
    const mo = months[+i];
    showTip(e.clientX, e.clientY, `<b>${esc(cap(fmt.month(mo.y, mo.m)))}</b> · ${fmt.km(mo.km * 1000)} km · ${mo.n} ${mo.n === 1 ? 'rit' : 'ritten'}`);
  });
  el.addEventListener('mouseleave', () => { hideTip(); bars.forEach((b) => b.classList.remove('on')); });
  el.addEventListener('click', (e) => {
    const i = e.target.dataset?.i;
    if (i == null) return;
    const mo = months[+i];
    if (!mo.n) return;
    ui.year = mo.y; ui.month = mo.m;
    location.hash = '#/ritten';
  });
  onLeave(hideTip);
}

function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------- trips table

const COLS = [
  { key: 'startTime', label: 'Datum' },
  { key: 'label', label: 'Route' },
  { key: 'distanceM', label: 'Afstand', num: true },
  { key: 'totalTimeS', label: 'Tijd', num: true },
  { key: 'avgMovingKmh', label: 'Gem.', num: true },
  { key: 'maxSpeedKmh', label: 'Top', num: true },
  { key: 'estL100', label: 'Verbruik', num: true },
  { key: 'score', label: 'Rijstijl', num: true },
  { key: 'temperatureC', label: 'Weer' },
];

function viewTrips() {
  const p = page();
  const render = () => {
    p.innerHTML = '';
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'search';
    search.placeholder = 'Zoek ritten';
    search.title = 'Zoek op plaats, datum, weer of dagdeel';
    search.setAttribute('aria-label', 'Ritten zoeken');
    search.value = ui.query;
    const monthChip = ui.month != null ? (() => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'link';
      b.textContent = `${cap(fmt.month(ui.year, ui.month))} ✕`;
      b.setAttribute('aria-label', 'Maandfilter wissen');
      b.addEventListener('click', () => { ui.month = null; render(); });
      return b;
    })() : null;
    p.appendChild(head('Ritten', '', monthChip, search, yearChips(render)));

    const panel = document.createElement('section');
    panel.className = 'panel';
    panel.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>${COLS.map((c) => `<th class="${c.num ? 'num' : ''}" ${ui.sort.key === c.key ? `aria-sort="${ui.sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button type="button" data-key="${c.key}">${c.label}</button></th>`).join('')}</tr></thead>
      <tbody></tbody></table></div><div class="table-foot"></div>`;
    p.appendChild(panel);
    const tbody = $('tbody', panel), foot = $('.table-foot', panel);

    const fill = () => {
      const q = ui.query.trim().toLowerCase();
      let rows = filtered();
      if (q) rows = rows.filter((t) => [t.label, placeName(t.startPlace), placeName(t.endPlace), t.weather, t.dayPart, fmt.date(t.startTime)].join(' ').toLowerCase().includes(q));
      const { key, dir } = ui.sort;
      rows = [...rows].sort((a, b) => {
        const va = a[key], vb = b[key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return (typeof va === 'string' ? va.localeCompare(vb, 'nl') : va - vb) * dir;
      });
      tbody.innerHTML = rows.length ? rows.map(tripRow).join('') : `<tr><td colspan="${COLS.length}" class="empty">Geen ritten gevonden.</td></tr>`;
      const dist = rows.reduce((s, t) => s + t.distanceM, 0);
      foot.textContent = `${fmt.num(rows.length)} ${rows.length === 1 ? 'rit' : 'ritten'} · ${fmt.km(dist)} km`;
    };
    search.addEventListener('input', () => { ui.query = search.value; fill(); });
    $('thead', panel).addEventListener('click', (e) => {
      const k = e.target.closest('button')?.dataset.key;
      if (!k) return;
      ui.sort = { key: k, dir: ui.sort.key === k ? -ui.sort.dir : (k === 'label' ? 1 : -1) };
      render();
      $('.search', p)?.focus();
    });
    bindRows(tbody);
    fill();
  };
  render();
}

// ---------------------------------------------------------------- map helpers

function makeMap(el, opts = {}) {
  // The scroll wheel scrolls the page; it zooms the map only after a click on it.
  const map = L.map(el, { preferCanvas: true, zoomControl: true, attributionControl: true, scrollWheelZoom: false, ...opts });
  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout blur', () => map.scrollWheelZoom.disable());
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'dark-tiles', attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  map.attributionControl.setPrefix(false);
  onLeave(() => map.remove());
  return map;
}

function drawRoute(map, P) {
  const layer = L.layerGroup().addTo(map);
  if (P.n < 2) return layer;
  let cur = [[P.lat[0], P.lon[0]]], color = speedColor(P.v[0]), est = P.est[0];
  const flush = () => {
    if (cur.length > 1) L.polyline(cur, { color, weight: 5, opacity: est ? 0.6 : 0.95, dashArray: est ? '6 8' : null, lineCap: 'round', lineJoin: 'round' }).addTo(layer);
  };
  for (let i = 1; i < P.n; i++) {
    const c = speedColor(P.v[i]);
    const e = P.est[i];
    cur.push([P.lat[i], P.lon[i]]);
    if (c !== color || e !== est) { flush(); cur = [[P.lat[i], P.lon[i]]]; color = c; est = e; }
  }
  flush();
  L.circleMarker([P.lat[0], P.lon[0]], { radius: 7, color: '#2D7FF9', weight: 3, fillColor: '#000', fillOpacity: 1 }).bindTooltip('Start', { className: 'tt-label' }).addTo(layer);
  L.circleMarker([P.lat[P.n - 1], P.lon[P.n - 1]], { radius: 7, color: '#ffffff', weight: 3, fillColor: '#2D7FF9', fillOpacity: 1 }).bindTooltip('Aankomst', { className: 'tt-label' }).addTo(layer);
  return layer;
}

// ---------------------------------------------------------------- trip detail

function viewTrip(arg) {
  const t = DATA.trips.find((x) => String(x.id) === arg);
  const p = page();
  if (!t) { p.innerHTML = '<a class="back" href="#/ritten">← Ritten</a><div class="panel empty">Deze rit staat niet in de back-up.</div>'; return; }
  if (!t.hasPts && DATA.remote) {
    // Online data: the GPS points come in a month file, fetched now.
    p.innerHTML = `<a class="back" href="#/ritten">← Ritten</a><div class="panel empty" id="trip-wait">Route laden…</div>`;
    const hash = location.hash;
    ensurePoints([t]).then(() => { if (location.hash === hash) route(); })
      .catch((e) => { const w = $('#trip-wait'); if (w) w.textContent = e.message; });
    return;
  }
  const P = t.pts;
  const idx = DATA.trips.indexOf(t);
  const newer = DATA.trips[idx - 1], older = DATA.trips[idx + 1];

  const subBits = [
    cap(fmt.dateLong(t.startTime)),
    `${fmt.time(t.startTime)} – ${fmt.time(t.endTime ?? t.startTime)}`,
    t.weather ? `${t.weather}${t.temperatureC != null ? `, ${fmt.num(t.temperatureC)}°` : ''}` : null,
  ].filter(Boolean).map(esc).join(' · ');

  p.innerHTML = `<div style="display:flex;gap:18px;align-items:center">
      <a class="back" href="#/ritten">← Ritten</a><div style="flex:1"></div>
      ${older ? `<a class="back" href="#/rit/${older.id}">← Vorige rit</a>` : ''}${newer ? `<a class="back" href="#/rit/${newer.id}">Volgende rit →</a>` : ''}
    </div>`;
  const h = head(t.label ?? 'Rit', subBits);
  if ((t.label ?? '').length > 28) $('h1', h).style.fontSize = '32px';
  p.appendChild(h);

  p.insertAdjacentHTML('beforeend', `<div class="grid g4">
    ${stat('Afstand', fmt.km(t.distanceM), 'km')}
    ${stat('Tijd', fmt.dur(t.totalTimeS), '', `${fmt.dur(t.movingTimeS)} in beweging`)}
    ${stat('Gemiddeld', fmt.kmh(t.avgMovingKmh), 'km/u', `${fmt.kmh(t.avgTotalKmh)} km/u over de hele rit`)}
    ${stat('Top', fmt.kmh(t.maxSpeedKmh), 'km/u')}
  </div>`);

  const grid = document.createElement('div');
  grid.className = 'grid g-detail';
  grid.innerHTML = `<div class="map" id="trip-map"></div><div class="grid" style="align-content:start"></div>`;
  p.appendChild(grid);
  const side = grid.children[1];

  const recs = t.recordsSet ? t.recordsSet.split(',').filter(Boolean) : [];
  side.insertAdjacentHTML('beforeend', `<section class="panel">
    <h2 class="label">Rijstijl</h2>
    ${t.score != null ? `<div class="stat"><div class="value">${t.score}<span class="unit">${scoreLabel(t.score)}</span></div></div>
      <div style="margin-top:12px">${hbars([
        ['Remmen', t.scoreBraking], ['Optrekken', t.scoreAccel], ['Bochten', t.scoreCornering], ['Gelijkmatig', t.scoreSmooth],
        ...(limitScore(t) != null ? [['Snelheidslimiet', limitScore(t)]] : []),
      ], (n) => String(n))}</div>` : `<p class="muted">${t.distanceM < 1000 ? 'Rit te kort voor een rijstijlscore.' : 'Geen score voor deze rit.'}</p>`}
  </section>
  <section class="panel"><h2 class="label">Wegtypes${t.roadTypeEstimated ? ' <span class="muted" style="text-transform:none;letter-spacing:0">(geschat)</span>' : ''}</h2>${roadSplit([t])}</section>
  <section class="panel"><h2 class="label">Details</h2>
    ${kv('Van', esc(placeName(t.startPlace)))}
    ${kv('Naar', esc(placeName(t.endPlace)))}
    ${kv('Dagdeel', esc(t.dayPart))}
    ${kv('Snelste 0–100', t.best0to100S != null ? `${fmt.num(t.best0to100S, 1)} s` : null)}
    ${kv('Snelste 10 km', t.best10kmAvgKmh != null ? `${fmt.kmh(t.best10kmAvgKmh, 1)} km/u` : null)}
    ${kv('Langste non-stop', `${fmt.km(t.longestNonStopM)} km · ${fmt.dur(t.longestNonStopS)}`)}
    ${kv('Stijging / daling', `${fmt.num(t.elevGainM)} / ${fmt.num(t.elevLossM)} m`)}
    ${kv('Hard optrekken / remmen', `${t.hardAccelCount}× / ${t.hardBrakeCount}×`)}
    ${(() => {
      const e = fuelEstimates().byTrip.get(t.id);
      if (!e) return '';
      const avg = fuelEstimates().overall;
      const diff = avg ? Math.round((e.l100 / avg - 1) * 100) : 0;
      return kv('Verbruik (berekend)', `≈ ${fmt.num(e.l100, 1)} l/100 km · ${fmt.num(e.liters, 2)} l${e.euros != null ? ` · € ${fmt.num(e.euros, 2)}` : ''}`)
        + (avg ? kv('Tegenover je gemiddelde', diff <= -3 ? `${-diff}% zuiniger` : diff >= 3 ? `${diff}% meer` : 'gemiddeld') : '');
    })()}
    ${kv('Nieuwe wegen', t.newRoadKm != null ? `${fmt.km(t.newRoadKm * 1000)} km` : null)}
    ${kv('Te hard', t.pctOverLimit != null ? `${fmt.num(t.pctOverLimit, 1)}% van de afstand` : null)}
    ${recs.length ? kv('Records', recs.map((k) => `<span class="badge">${esc(recordDef(k)?.title ?? k)}</span>`).join(' ')) : ''}
  </section>`);

  const map = makeMap($('#trip-map', grid));
  if (P.n > 1) {
    drawRoute(map, P);
    map.fitBounds(L.latLngBounds(thin(P, 50)), { padding: [30, 30] });
  } else {
    map.setView([52.15, 5.3], 7);
  }
  const cursor = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#2D7FF9', fillOpacity: 1, interactive: false });

  // Charts over distance
  if (P.n > 1) {
    const sp = document.createElement('section');
    sp.className = 'panel';
    sp.innerHTML = `<div class="panel-head"><h2 class="label">Snelheid en hoogte</h2><div class="spacer"></div>
      <div class="legend"><span><i style="background:var(--blue)"></i>Snelheid (km/u)</span>${P.hasAlt ? '<span><i style="background:#3A4252"></i>Hoogte</span>' : ''}</div></div>
      <div class="canvas-chart" id="c-speed"></div><div class="readout" id="readout"><span>Beweeg over de grafiek om de plek op de kaart te zien.</span></div>`;
    p.appendChild(sp);
    const charts = [speedChart($('#c-speed', sp), P)];

    const gp = document.createElement('section');
    gp.className = 'panel';
    if (P.hasG) {
      gp.innerHTML = `<div class="panel-head"><h2 class="label">G-krachten</h2><div class="spacer"></div>
        <div class="legend"><span><i style="background:var(--blue)"></i>Remmen en optrekken (g)</span><span><i style="background:var(--road-urban)"></i>Bochten (g)</span></div></div>
        <div class="canvas-chart" id="c-g"></div>
        <div class="readout">${[['Optrekken', t.gPeakAccel], ['Remmen', t.gPeakBrake], ['Bocht', t.gPeakCorner]].filter((x) => x[1] != null).map(([k, v]) => `<span>Piek ${k.toLowerCase()} <b>${fmt.num(v, 2)} g</b></span>`).join('')}</div>`;
      p.appendChild(gp);
      charts.push(gChart($('#c-g', gp), P));
    }

    const readout = $('#readout', sp);
    const onHover = (i) => {
      charts.forEach((c) => c.setCursor(i));
      if (i == null) { cursor.remove(); return; }
      cursor.setLatLng([P.lat[i], P.lon[i]]).addTo(map);
      const bits = [
        `<span>Afstand <b>${fmt.km(P.d[i])} km</b></span>`,
        `<span>Tijd <b>${fmt.time(P.t[i])}</b></span>`,
        `<span>Snelheid <b>${fmt.kmh(P.v[i])} km/u</b>${P.est[i] ? ' (geschat)' : ''}</span>`,
      ];
      if (!Number.isNaN(P.alt[i])) bits.push(`<span>Hoogte <b>${fmt.num(P.alt[i])} m</b></span>`);
      if (!Number.isNaN(P.gLong[i])) bits.push(`<span>G <b>${fmt.num(Math.hypot(P.gLong[i], P.gLat[i] || 0), 2)} g</b></span>`);
      readout.innerHTML = bits.join('');
    };
    charts.forEach((c) => c.onHover(onHover));
  }
}

/** Canvas chart over distance with a shared hover cursor. draw(ctx, w, h, x) paints the base. */
function canvasChart(el, P, draw) {
  const base = document.createElement('canvas');
  const top = document.createElement('canvas');
  el.append(base, top);
  let W = 0, H = 0, cursorI = null, hoverFn = null;
  const PAD = { l: 44, r: 12, t: 10, b: 26 };
  const xOf = (d) => PAD.l + (d / P.d[P.n - 1]) * (W - PAD.l - PAD.r);
  const size = () => {
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    for (const c of [base, top]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0); }
    const g = base.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.font = '11px Inter, sans-serif';
    draw(g, W, H, PAD, xOf);
    // x axis: km
    g.fillStyle = '#8D94A5';
    g.textAlign = 'center';
    const total = P.d[P.n - 1] / 1000;
    const step = niceStep(total / 8);
    for (let k = 0; k <= total + 1e-9; k += step) g.fillText(`${fmt.num(k, step < 1 ? 1 : 0)} km`, xOf(k * 1000), H - 8);
    paintCursor();
  };
  const paintCursor = () => {
    const g = top.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (cursorI == null) return;
    const x = xOf(P.d[cursorI]);
    g.strokeStyle = 'rgba(244,246,250,.7)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, PAD.t); g.lineTo(x, H - PAD.b); g.stroke();
  };
  const ro = new ResizeObserver(size);
  ro.observe(el);
  onLeave(() => ro.disconnect());
  const indexAt = (clientX) => {
    const r = el.getBoundingClientRect();
    const frac = (clientX - r.left - PAD.l) / (W - PAD.l - PAD.r);
    if (frac < 0 || frac > 1) return null;
    const target = frac * P.d[P.n - 1];
    let lo = 0, hi = P.n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (P.d[mid] < target) lo = mid + 1; else hi = mid; }
    return lo;
  };
  top.addEventListener('mousemove', (e) => hoverFn?.(indexAt(e.clientX)));
  top.addEventListener('mouseleave', () => hoverFn?.(null));
  return {
    setCursor(i) { cursorI = i; paintCursor(); },
    onHover(fn) { hoverFn = fn; },
  };
}

function speedChart(el, P) {
  return canvasChart(el, P, (g, W, H, PAD, xOf) => {
    const plotH = H - PAD.t - PAD.b;
    let maxV = 0;
    for (let i = 0; i < P.n; i++) maxV = Math.max(maxV, P.v[i]);
    const topV = Math.max(60, Math.ceil((maxV * 1.08) / 10) * 10);
    const yV = (v) => PAD.t + plotH * (1 - v / topV);
    // altitude area, scaled to its own range
    if (P.hasAlt) {
      let a0 = Infinity, a1 = -Infinity;
      for (let i = 0; i < P.n; i++) if (!Number.isNaN(P.alt[i])) { a0 = Math.min(a0, P.alt[i]); a1 = Math.max(a1, P.alt[i]); }
      const span = Math.max(a1 - a0, 20);
      const yA = (a) => PAD.t + plotH * (1 - 0.55 * ((a - a0) / span));
      g.beginPath();
      g.moveTo(xOf(0), H - PAD.b);
      for (let i = 0; i < P.n; i++) if (!Number.isNaN(P.alt[i])) g.lineTo(xOf(P.d[i]), yA(P.alt[i]));
      g.lineTo(xOf(P.d[P.n - 1]), H - PAD.b);
      g.closePath();
      g.fillStyle = '#1A1E27';
      g.fill();
    }
    // guide lines
    g.strokeStyle = '#242833'; g.fillStyle = '#8D94A5'; g.textAlign = 'right'; g.lineWidth = 1;
    for (const v of [50, 80, 100, 130].filter((v) => v < topV)) {
      g.beginPath(); g.moveTo(PAD.l, yV(v)); g.lineTo(W - PAD.r, yV(v)); g.stroke();
      g.fillText(String(v), PAD.l - 8, yV(v) + 4);
    }
    // speed
    g.beginPath();
    for (let i = 0; i < P.n; i++) { const x = xOf(P.d[i]), y = yV(P.v[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.strokeStyle = '#2D7FF9'; g.lineWidth = 1.8; g.lineJoin = 'round';
    g.stroke();
  });
}

function gChart(el, P) {
  return canvasChart(el, P, (g, W, H, PAD, xOf) => {
    const plotH = H - PAD.t - PAD.b;
    let m = 0;
    for (let i = 0; i < P.n; i++) {
      if (!Number.isNaN(P.gLong[i])) m = Math.max(m, Math.abs(P.gLong[i]));
      if (!Number.isNaN(P.gLat[i])) m = Math.max(m, Math.abs(P.gLat[i]));
    }
    const top = Math.max(0.4, Math.ceil(m * 1.15 * 10) / 10);
    const y = (v) => PAD.t + plotH * (0.5 - v / (2 * top));
    g.strokeStyle = '#242833'; g.fillStyle = '#8D94A5'; g.textAlign = 'right'; g.lineWidth = 1;
    for (const v of [-top, -top / 2, 0, top / 2, top]) {
      g.beginPath(); g.moveTo(PAD.l, y(v)); g.lineTo(W - PAD.r, y(v)); g.stroke();
      g.fillText(fmt.num(v, 1), PAD.l - 8, y(v) + 4);
    }
    const line = (arr, color) => {
      g.beginPath();
      let pen = false;
      for (let i = 0; i < P.n; i++) {
        if (Number.isNaN(arr[i])) { pen = false; continue; }
        const px = xOf(P.d[i]), py = y(arr[i]);
        pen ? g.lineTo(px, py) : g.moveTo(px, py);
        pen = true;
      }
      g.strokeStyle = color; g.lineWidth = 1.4; g.stroke();
    };
    line(P.gLat, '#A9CCFF');
    line(P.gLong, '#2D7FF9');
  });
}

// ---------------------------------------------------------------- all trips map

function viewMap() {
  const p = page();
  const render = () => {
    cleanup();
    p.innerHTML = '';
    const trips = filtered();
    const dist = trips.reduce((s, t) => s + t.distanceM, 0);
    p.appendChild(head('Kaart', `${fmt.num(trips.length)} ${trips.length === 1 ? 'rit' : 'ritten'} · ${fmt.km(dist)} km`, yearChips(render)));
    const el = document.createElement('div');
    el.className = 'map map-tall';
    p.appendChild(el);
    if (DATA.remote && trips.some((t) => !t.hasPts)) {
      // Online data: fetch the routes of these trips first, then draw.
      const sub = $('.sub', p);
      const hash = location.hash, year = ui.year;
      sub.textContent = 'Routes laden…';
      ensurePoints(trips, (d, n) => { sub.textContent = `Routes laden… ${d} van ${n} maanden`; })
        .then(() => { if (location.hash === hash && ui.year === year) render(); })
        .catch((e) => { sub.textContent = e.message; });
      return;
    }
    const map = makeMap(el);
    const group = L.featureGroup().addTo(map);
    for (const t of trips) {
      if (t.pts.n < 2) continue;
      const line = L.polyline(thin(t.pts), { color: '#2D7FF9', weight: 3, opacity: 0.4, lineCap: 'round', lineJoin: 'round' });
      line.bindTooltip(`${esc(t.label ?? 'Rit')} · ${esc(fmt.dateShort(t.startTime))} · ${fmt.km(t.distanceM)} km`, { className: 'tt-label', sticky: true });
      line.on('mouseover', () => { line.setStyle({ color: '#ffffff', weight: 5, opacity: 1 }); line.bringToFront(); });
      line.on('mouseout', () => line.setStyle({ color: '#2D7FF9', weight: 3, opacity: 0.4 }));
      line.on('click', () => { location.hash = `#/rit/${t.id}`; });
      line.addTo(group);
    }
    if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [30, 30] });
    else map.setView([52.15, 5.3], 7);
  };
  render();
}

// ---------------------------------------------------------------- fuel per trip (ported from FuelModel.kt)

/** Modelled litres before calibration: rolling, air drag, accelerating, climbing, idling, cold start. */
function rawLiters(t, car) {
  if (t.fuelAero == null || t.fuelKinetic == null || t.distanceM < 10) return null;
  const G = 9.81;
  const wheelJ = car.mass * (0.011 * G * t.distanceM + t.fuelKinetic + G * (t.elevGainM || 0)) + 0.5 * 1.2 * 0.65 * t.fuelAero;
  const [eff, lhv] = car.diesel ? [0.32, 35.8e6] : [0.27, 32.0e6];
  const idleS = Math.max(0, (t.totalTimeS || 0) - (t.movingTimeS || 0));
  const temp = t.temperatureC ?? 12;
  const coldStart = 0.06 * (1 + Math.max(0, (15 - temp) / 15));
  return wheelJ / (eff * lhv) + (idleS * 0.6) / 3600 + coldStart;
}

/** Calibrated litres, l/100 km and euros per trip id (cached per loaded data). */
function fuelEstimates() {
  if (DATA.est) return DATA.est;
  const c = DATA.car || {};
  const car = {
    mass: c.massReady ?? (c.massEmpty != null ? c.massEmpty + 100 : 1300),
    diesel: /diesel/i.test(c.fuel || ''),
    official: c.consumptionL100 ?? null,
  };
  const trips = DATA.trips;
  const raw = new Map();
  for (const t of trips) { const r = rawLiters(t, car); if (r != null) raw.set(t.id, r); }
  const est = { k: 1, provisional: true, byTrip: new Map(), overall: null };
  DATA.est = est;
  if (!raw.size) return est;
  const rawKm = trips.filter((t) => raw.has(t.id)).reduce((s, t) => s + t.distanceM / 1000, 0);
  const rawPerKm = [...raw.values()].reduce((a, b) => a + b, 0) / Math.max(rawKm, 1e-9);
  const rawOf = (t) => raw.get(t.id) ?? (t.distanceM / 1000) * rawPerKm;

  const fills = [...(DATA.fuel || [])].sort((a, b) => a.time - b.time);
  let measured = 0, modelled = 0, lastFull = null, liters = 0;
  for (const f of fills) {
    liters += f.liters;
    if (f.full === false) continue;
    if (lastFull) {
      const inTank = trips.filter((t) => { const e = t.endTime ?? t.startTime; return e > lastFull.time && e <= f.time; });
      if (inTank.reduce((s, t) => s + t.distanceM, 0) / 1000 >= 30) {
        measured += liters;
        modelled += inTank.reduce((s, t) => s + rawOf(t), 0);
      }
    }
    lastFull = f;
    liters = 0;
  }
  const clamp = (v) => Math.min(2.5, Math.max(0.4, v));
  if (modelled > 0) { est.k = clamp(measured / modelled); est.provisional = false; }
  else if (car.official != null) est.k = clamp((car.official * 1.15) / (([...raw.values()].reduce((a, b) => a + b, 0) / rawKm) * 100));

  const priced = fills.filter((f) => f.liters > 0);
  let L = 0, KM = 0;
  for (const t of trips) {
    const r = raw.get(t.id);
    const km = t.distanceM / 1000;
    if (r == null || km < 1) continue;
    const l = r * est.k;
    const end = t.endTime ?? t.startTime;
    const p = [...priced].reverse().find((f) => f.time <= end) ?? priced[0];
    const e = { liters: l, l100: (l / km) * 100, euros: p ? (p.euros / p.liters) * l : null, km };
    est.byTrip.set(t.id, e);
    t.estL100 = e.l100;
    L += l; KM += km;
  }
  est.overall = KM > 0.5 ? (L / KM) * 100 : null;
  return est;
}

/** l/100 km over a set of trips (litres-weighted). */
function l100Of(trips) {
  const est = fuelEstimates();
  let l = 0, km = 0;
  for (const t of trips) { const e = est.byTrip.get(t.id); if (e) { l += e.liters; km += e.km; } }
  return km > 0.5 ? (l / km) * 100 : null;
}

/** Recurring routes: start and end both within 600 m, at least three trips (as in the app). */
function routeGroups(trips) {
  const near = (a1, o1, a2, o2) => a1 != null && a2 != null && haversine(a1, o1, a2, o2) <= 600;
  const groups = [];
  for (const t of [...trips].filter((t) => t.startLat != null && t.endLat != null).sort((a, b) => a.startTime - b.startTime)) {
    const g = groups.find((g) => near(g[0].startLat, g[0].startLon, t.startLat, t.startLon) && near(g[0].endLat, g[0].endLon, t.endLat, t.endLon));
    if (g) g.push(t); else groups.push([t]);
  }
  return groups.filter((g) => g.length >= 3).sort((a, b) => b.length - a.length);
}

const TRIP_KINDS = [
  ['Kort (< 5 km)', (t) => t.distanceM < 5000],
  ['Stad', (t) => t.distanceM >= 5000 && t.avgMovingKmh < 45],
  ['Gemengd', (t) => t.distanceM >= 5000 && t.avgMovingKmh >= 45 && t.avgMovingKmh <= 75],
  ['Snelweg', (t) => t.distanceM >= 5000 && t.avgMovingKmh > 75],
];

/** Panels with fuel per trip, added up per month, kind of trip and route; most and least economical trips. */
function fuelTripPanels(p, trips) {
  const est = fuelEstimates();
  if (!est.byTrip.size) return;
  const note = est.provisional
    ? 'Voorlopig: berekend uit je rijstijl en het opgegeven verbruik. Na twee volle tanks ijkt TripTrack op wat je echt tankt.'
    : 'Per rit berekend uit snelheid, optrekken, stilstaan en hoogte, en geijkt op je tankbeurten.';

  // Per month
  const months = [];
  const ts = trips.length ? trips : DATA.trips;
  const first = new Date(Math.min(...ts.map((t) => t.startTime))), last = new Date(Math.max(...ts.map((t) => t.startTime)));
  const start = ui.year === 'all' ? [first.getFullYear(), first.getMonth()] : [ui.year, 0];
  const end = ui.year === 'all' ? [last.getFullYear(), last.getMonth()] : [ui.year, 11];
  for (let y = start[0], m = start[1]; y < end[0] || (y === end[0] && m <= end[1]); m === 11 ? (y++, m = 0) : m++) {
    const mt = trips.filter((t) => t.year === y && t.month === m);
    const v = l100Of(mt);
    months.push({ value: v ?? 0, label: fmt.monthShort(m), tip: `<b>${esc(cap(fmt.month(y, m)))}</b> · ${v != null ? `${fmt.num(v, 1)} l/100 km` : 'geen ritten'} · ${mt.length} ritten` });
  }
  const periodAvg = l100Of(trips);
  const mp = document.createElement('section');
  mp.className = 'panel';
  mp.innerHTML = `<div class="panel-head"><h2 class="label">Verbruik per maand, per rit berekend</h2><div class="spacer"></div>
    ${periodAvg != null ? `<span class="legend"><span><i style="background:var(--blue-light)"></i>gemiddeld ${fmt.num(periodAvg, 1)} l/100 km</span></span>` : ''}</div>
    <div class="chart" id="fuel-est-months"></div><p class="muted" style="font-size:13px;margin:10px 0 0">${note}</p>`;
  p.appendChild(mp);
  svgBars($('#fuel-est-months', mp), months, { avg: periodAvg, fmtAxis: (v) => fmt.num(v, v < 10 ? 1 : 0), labelEvery: Math.ceil(months.length / 12) });

  // Kind of trip + routes
  const kinds = TRIP_KINDS.map(([label, test]) => {
    const g = trips.filter(test);
    return [label, l100Of(g), g.reduce((s, t) => s + t.distanceM, 0) / 1000];
  }).filter((r) => r[1] != null);
  const totalKm = kinds.reduce((s, r) => s + r[2], 0) || 1;
  const maxK = Math.max(...kinds.map((r) => r[1]), 1);
  const groups = routeGroups(trips).slice(0, 5);
  const row = document.createElement('div');
  row.className = 'grid g2';
  row.innerHTML = `<section class="panel"><h2 class="label">Soort rit</h2>
      ${kinds.map(([label, v, km]) => `<div class="hbar"><span>${esc(label)}<br><span class="muted" style="font-size:11px">${fmt.num((km / totalKm) * 100)}% van je km</span></span>
        <div class="track"><div class="fill" style="width:${(v / maxK) * 100}%"></div></div><span class="n" style="color:var(--text);font-weight:600">${fmt.num(v, 1)} l</span></div>`).join('')}
      <p class="muted" style="font-size:12px;margin:8px 0 0">l/100 km; gemiddelde snelheid in beweging: stad &lt; 45, snelweg &gt; 75 km/u.</p></section>
    <section class="panel"><h2 class="label">Vaste ritten</h2>
      ${groups.length ? groups.map((g) => {
        const v = l100Of(g);
        const eur = g.map((t) => est.byTrip.get(t.id)?.euros).filter((x) => x != null);
        const best = g.filter((t) => est.byTrip.has(t.id)).sort((a, b) => est.byTrip.get(a.id).l100 - est.byTrip.get(b.id).l100)[0];
        return `<div class="kv"><a class="k" href="#/rit/${best?.id ?? g[0].id}" style="color:var(--text)">${esc(g[0].label ?? 'Vaste rit')}<br><span class="muted" style="font-size:12px">${g.length}× · zuinigste ${best ? fmt.num(est.byTrip.get(best.id).l100, 1) : '–'} l/100 km</span></a>
          <span class="v">${v != null ? `${fmt.num(v, 1)} l/100 km` : '–'}${eur.length ? `<br><span class="muted" style="font-size:12px;font-weight:400">€ ${fmt.num(eur.reduce((a, b) => a + b, 0) / eur.length, 2)} per rit</span>` : ''}</span></div>`;
      }).join('') : '<p class="muted">Nog geen route die je drie keer of vaker reed.</p>'}</section>`;
  p.appendChild(row);

  // Most and least economical
  const ranked = trips.filter((t) => t.distanceM >= 5000 && est.byTrip.has(t.id)).sort((a, b) => est.byTrip.get(a.id).l100 - est.byTrip.get(b.id).l100);
  if (ranked.length >= 4) {
    const list = (arr) => arr.map((t) => `<div class="kv"><a class="k" href="#/rit/${t.id}" style="color:var(--text)">${esc(t.label ?? 'Rit')}<br>
      <span class="muted" style="font-size:12px">${esc(fmt.dateShort(t.startTime))} · ${fmt.km(t.distanceM)} km · gem. ${fmt.kmh(t.avgMovingKmh)} km/u</span></a>
      <span class="v">${fmt.num(est.byTrip.get(t.id).l100, 1)} l/100 km</span></div>`).join('');
    p.insertAdjacentHTML('beforeend', `<div class="grid g2">
      <section class="panel"><h2 class="label">Zuinigste ritten</h2>${list(ranked.slice(0, 5))}</section>
      <section class="panel"><h2 class="label">Minst zuinige ritten</h2>${list(ranked.slice(-5).reverse())}</section>
    </div>`);
  }
}

// ---------------------------------------------------------------- fuel (ported from FuelStats.kt)

/** Full-to-full consumption: liters of a full tank (plus partial fills since) over the km since the previous full tank. */
function fuelSummary(fills, trips) {
  const sorted = [...fills].sort((a, b) => a.time - b.time);
  const ends = trips.map((t) => [t.endTime ?? t.startTime, t.distanceM]);
  const intervals = [];
  let lastFull = null, liters = 0;
  for (const f of sorted) {
    liters += f.liters;
    if (f.full === false) continue;
    if (lastFull) {
      const km = ends.filter(([e]) => e > lastFull.time && e <= f.time).reduce((s, [, m]) => s + m, 0) / 1000;
      if (km >= 30) intervals.push({ endTime: f.time, km, liters, l100: (liters / km) * 100 });
    }
    lastFull = f;
    liters = 0;
  }
  const lastPriced = [...sorted].reverse().find((f) => f.liters > 0);
  return { sorted, intervals, lastPrice: lastPriced ? lastPriced.euros / lastPriced.liters : null };
}

const avgOf = (intervals) => {
  const km = intervals.reduce((s, i) => s + i.km, 0);
  return km > 0 ? (intervals.reduce((s, i) => s + i.liters, 0) / km) * 100 : null;
};

/** Stations by visits (then litres), as in the app; fill-ups without a station are left out. */
function stationsOf(fills) {
  const m = new Map();
  for (const f of fills) {
    if (!f.station) continue;
    const s = m.get(f.station) ?? { name: f.station, visits: 0, liters: 0, euros: 0 };
    s.visits++; s.liters += f.liters; s.euros += f.euros;
    m.set(f.station, s);
  }
  return [...m.values()].sort((a, b) => b.visits - a.visits || b.liters - a.liters);
}

/** Generic SVG bar chart with hover tooltips; bars: [{ value, label, tip }]. */
function svgBars(el, bars, { avg = null, fmtAxis = (v) => fmt.num(v), labelEvery = 1, onClick = null, width = 1000 } = {}) {
  const W = width, H = 240, padL = 44, padB = 30, padT = 10;
  const max = Math.max(...bars.map((b) => b.value), avg ?? 0, 1e-9);
  const step = niceStep(max / 4);
  const top = Math.ceil((max * 1.05) / step) * step;
  const bw = (W - padL) / Math.max(bars.length, 1);
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmtAxis(v)}</text>`;
  }
  bars.forEach((b, i) => {
    const x = padL + i * bw;
    const barW = Math.min(bw * 0.64, 64);
    svg += `<rect class="bar" data-i="${i}" x="${x + (bw - barW) / 2}" y="${y(b.value)}" width="${barW}" height="${Math.max(H - padB - y(b.value), b.value > 0 ? 2 : 0)}" rx="${Math.min(4, bw * 0.2)}"/>`;
    svg += `<rect data-i="${i}" x="${x}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"${onClick ? ' style="cursor:pointer"' : ''}/>`;
    if (i % labelEvery === 0) svg += `<text class="axis" x="${x + bw / 2}" y="${H - padB + 18}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (avg != null) svg += `<line x1="${padL}" x2="${W}" y1="${y(avg)}" y2="${y(avg)}" stroke="var(--blue-light)" stroke-width="2" stroke-dasharray="8 7"/>`;
  svg += '</svg>';
  el.innerHTML = svg;
  const rects = $$('.bar', el);
  el.addEventListener('mousemove', (e) => {
    const i = e.target.dataset?.i;
    rects.forEach((r) => r.classList.toggle('on', r.dataset.i === i));
    if (i == null) { hideTip(); return; }
    showTip(e.clientX, e.clientY, bars[+i].tip);
  });
  el.addEventListener('mouseleave', () => { hideTip(); rects.forEach((r) => r.classList.remove('on')); });
  if (onClick) el.addEventListener('click', (e) => { const i = e.target.dataset?.i; if (i != null) onClick(bars[+i]); });
  onLeave(hideTip);
}

/** SVG line with dots over time; points: [{ t, value, tip }]. */
function svgLine(el, points, { fmtAxis = (v) => fmt.num(v, 2), width = 1000 } = {}) {
  const W = width, H = 240, padL = 52, padB = 30, padT = 14;
  const vals = points.map((p) => p.value);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.15, 0.03);
  lo -= pad; hi += pad;
  const t0 = points[0].t, span = Math.max(points[points.length - 1].t - t0, 1);
  const x = (t) => padL + ((t - t0) / span) * (W - padL - 12);
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
  for (let k = 0; k <= 3; k++) {
    const v = lo + ((hi - lo) * k) / 3;
    svg += `<line class="grid-line" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${fmtAxis(v)}</text>`;
  }
  svg += `<polyline fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" points="${points.map((p) => `${x(p.t)},${y(p.value)}`).join(' ')}"/>`;
  points.forEach((p, i) => { svg += `<circle data-i="${i}" cx="${x(p.t)}" cy="${y(p.value)}" r="6" fill="var(--blue-light)" style="cursor:default"/>`; });
  svg += `<text class="axis" x="${padL}" y="${H - 8}">${esc(fmt.dateShort(t0))}</text><text class="axis" x="${W - 12}" y="${H - 8}" text-anchor="end">${esc(fmt.dateShort(points[points.length - 1].t))}</text>`;
  svg += '</svg>';
  el.innerHTML = svg;
  el.addEventListener('mousemove', (e) => {
    const i = e.target.dataset?.i;
    if (i == null) { hideTip(); return; }
    showTip(e.clientX, e.clientY, points[+i].tip);
  });
  el.addEventListener('mouseleave', hideTip);
  onLeave(hideTip);
}

function viewFuel() {
  const p = page();
  const render = () => {
    cleanup();
    p.innerHTML = '';
    p.appendChild(head('Verbruik', carLine(), yearChips(render)));
    const all = DATA.fuel || [];
    if (!all.length) {
      p.insertAdjacentHTML('beforeend', `<div class="panel empty">Nog geen tankbeurten. Vul ze in de app in onder <b>Verbruik</b>; na de volgende update staan ze hier.</div>`);
      fuelTripPanels(p, DATA.trips.filter((t) => ui.year === 'all' || t.year === ui.year));
      return;
    }
    const inYear = (t) => ui.year === 'all' || new Date(t).getFullYear() === ui.year;
    const s = fuelSummary(all, DATA.trips);
    const fills = s.sorted.filter((f) => inYear(f.time));
    const intervals = s.intervals.filter((i) => inYear(i.endTime));
    const avg = avgOf(intervals);
    const euros = fills.reduce((a, f) => a + f.euros, 0);
    const liters = fills.reduce((a, f) => a + f.liters, 0);
    const avgPrice = liters > 0 ? euros / liters : null;
    const allAvg = avgOf(s.intervals);
    const perKm = allAvg != null && s.lastPrice != null ? (allAvg / 100) * s.lastPrice : null;
    const official = DATA.car?.consumptionL100;

    p.insertAdjacentHTML('beforeend', `<div class="grid g4">
      ${stat('Verbruik', avg != null ? fmt.num(avg, 1) : '–', avg != null ? 'l/100 km' : '', intervals.length
        ? `over ${fmt.num(intervals.reduce((a, i) => a + i.km, 0))} km · ${intervals.length} ${intervals.length === 1 ? 'tank' : 'tanks'}` : 'na de volgende volle tank')}
      ${stat('Literprijs', s.lastPrice != null ? `€ ${fmt.num(s.lastPrice, 3)}` : '–', '', avgPrice != null ? `gemiddeld € ${fmt.num(avgPrice, 3)}` : '')}
      ${stat('Per km', perKm != null ? fmt.num(perKm * 100, 1) : '–', perKm != null ? 'ct' : '', perKm != null ? 'bij je gemiddelde verbruik en de laatste prijs' : '')}
      ${stat('Getankt', `€ ${fmt.num(euros)}`, '', `${fmt.num(liters)} l · ${fills.length} ${fills.length === 1 ? 'keer' : 'keer'}`)}
    </div>`);

    // Consumption per tank
    const per = document.createElement('section');
    per.className = 'panel';
    per.innerHTML = `<div class="panel-head"><h2 class="label">Verbruik per tank</h2><div class="spacer"></div>
      ${avg != null ? `<span class="legend"><span><i style="background:var(--blue-light)"></i>gemiddeld ${fmt.num(avg, 1)} l/100 km${official ? ` · opgave ${fmt.num(official, 1)}` : ''}</span></span>` : ''}</div>
      <div class="chart" id="fuel-tanks"></div>`;
    p.appendChild(per);
    if (intervals.length) {
      svgBars($('#fuel-tanks', per), intervals.map((i) => ({
        value: i.l100,
        label: fmt.dateShort(i.endTime).replace(/ \d{4}$/, ''),
        tip: `<b>${esc(fmt.dateShort(i.endTime))}</b> · ${fmt.num(i.l100, 1)} l/100 km · ${fmt.num(i.km)} km · ${fmt.num(i.liters, 1)} l`,
      })), { avg, fmtAxis: (v) => fmt.num(v, v < 10 ? 1 : 0), labelEvery: Math.ceil(intervals.length / 12) });
    } else {
      $('#fuel-tanks', per).innerHTML = '<p class="muted">Je verbruik verschijnt na twee volle tanks met ritten ertussen.</p>';
    }

    fuelTripPanels(p, DATA.trips.filter((t) => ui.year === 'all' || t.year === ui.year));

    // Stations
    const stations = stationsOf(fills);
    if (stations.length) {
      const regulars = stations.filter((st) => st.visits >= 2);
      const cheap = regulars.length >= 2 ? regulars.reduce((a, b) => (b.euros / b.liters < a.euros / a.liters ? b : a)) : null;
      p.insertAdjacentHTML('beforeend', `<section class="panel"><div class="panel-head"><h2 class="label">Tankstations</h2><div class="spacer"></div>
        ${cheap ? `<span class="hint">Goedkoopst van je vaste stations: <b style="color:var(--text)">${esc(cheap.name)}</b></span>` : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>Station</th><th class="num">Keer</th><th class="num">Liters</th><th class="num">Bedrag</th><th class="num">Gem. prijs per liter</th></tr></thead>
        <tbody>${stations.slice(0, 8).map((st, i) => `<tr style="cursor:default">
          <td class="route">${esc(st.name)}${i === 0 && st.visits > 1 ? ' <span class="badge">FAVORIET</span>' : ''}</td>
          <td class="num">${st.visits}×</td><td class="num">${fmt.num(st.liters)} <span class="muted">l</span></td>
          <td class="num">€ ${fmt.num(st.euros, 0)}</td><td class="num">€ ${fmt.num(st.euros / st.liters, 3)}</td></tr>`).join('')}</tbody></table></div></section>`);
    }

    // Price and spending
    const row = document.createElement('div');
    row.className = 'grid g2';
    row.innerHTML = `<section class="panel"><h2 class="label">Literprijs</h2><div class="chart" id="fuel-price"></div></section>
      <section class="panel"><h2 class="label">Uitgaven per maand</h2><div class="chart" id="fuel-months"></div></section>`;
    p.appendChild(row);
    const priced = fills.filter((f) => f.liters > 0);
    if (priced.length >= 2) {
      svgLine($('#fuel-price', row), priced.map((f) => ({
        t: f.time, value: f.euros / f.liters,
        tip: `<b>€ ${fmt.num(f.euros / f.liters, 3)}</b> · ${esc(fmt.dateShort(f.time))}${f.station ? ` · ${esc(f.station)}` : ''}`,
      })), { fmtAxis: (v) => fmt.num(v, 2), width: 560 });
    } else {
      $('#fuel-price', row).innerHTML = '<p class="muted">Na twee tankbeurten zie je hier hoe de prijs loopt.</p>';
    }
    const first = new Date(fills[0]?.time ?? Date.now()), last = new Date(fills[fills.length - 1]?.time ?? Date.now());
    const start = ui.year === 'all' ? [first.getFullYear(), first.getMonth()] : [ui.year, 0];
    const end = ui.year === 'all' ? [last.getFullYear(), last.getMonth()] : [ui.year, 11];
    const months = [];
    for (let y = start[0], m = start[1]; y < end[0] || (y === end[0] && m <= end[1]); m === 11 ? (y++, m = 0) : m++) {
      const fs = fills.filter((f) => { const d = new Date(f.time); return d.getFullYear() === y && d.getMonth() === m; });
      const eur = fs.reduce((a, f) => a + f.euros, 0);
      months.push({ value: eur, label: fmt.monthShort(m), tip: `<b>${esc(cap(fmt.month(y, m)))}</b> · € ${fmt.num(eur, 2)} · ${fs.length}× getankt` });
    }
    svgBars($('#fuel-months', row), months, { fmtAxis: (v) => `€ ${fmt.num(v)}`, labelEvery: Math.ceil(months.length / 8), width: 560 });

    // All fill-ups
    const byEnd = new Map(s.intervals.map((i) => [i.endTime, i]));
    const list = [...fills].reverse();
    const table = document.createElement('section');
    table.className = 'panel';
    table.innerHTML = `<div class="panel-head"><h2 class="label">Tankbeurten</h2></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Datum</th><th>Station</th><th class="num">Liters</th><th class="num">Bedrag</th><th class="num">Prijs per liter</th><th class="num">Verbruik</th><th>Tank</th></tr></thead>
        <tbody>${list.map((f) => {
          const iv = byEnd.get(f.time);
          const trip = f.tripStart != null ? DATA.byStart.get(f.tripStart) : null;
          return `<tr${trip ? ` data-id="${trip.id}"` : ' style="cursor:default"'}>
            <td><div>${esc(cap(fmt.date(f.time)))}</div><div class="muted">${fmt.time(f.time)}</div></td>
            <td class="route">${trip ? `<a href="#/rit/${trip.id}">${esc(f.station || trip.label || 'Rit')}</a>` : esc(f.station || '–')}</td>
            <td class="num">${fmt.num(f.liters, 2)} <span class="muted">l</span></td>
            <td class="num">€ ${fmt.num(f.euros, 2)}</td>
            <td class="num">€ ${fmt.num(f.liters > 0 ? f.euros / f.liters : 0, 3)}</td>
            <td class="num">${iv ? `${fmt.num(iv.l100, 1)} <span class="muted">l/100 km</span>` : '<span class="muted">–</span>'}</td>
            <td>${f.full === false ? '<span class="muted">deels</span>' : 'vol'}</td>
          </tr>`;
        }).join('') || `<tr><td colspan="7" class="empty">Geen tankbeurten in ${ui.year}.</td></tr>`}</tbody>
      </table></div>`;
    p.appendChild(table);
    bindRows($('tbody', table));
  };
  render();
}

// ---------------------------------------------------------------- records

function viewRecords() {
  const p = page();
  p.appendChild(head('Records', 'Je beste prestaties ooit, zoals de app ze bijhoudt.'));
  const findTrip = (time) => DATA.trips.find((t) => time >= t.startTime - 60_000 && time <= (t.endTime ?? t.startTime) + 60_000);
  const cards = RECORDS.map((def) => {
    const r = DATA.records.find((x) => x.key === def.key);
    if (!r) return '';
    const trip = findTrip(r.time);
    const inner = `<div class="label">${esc(def.title)}</div>
      <div class="value">${def.f(r.value)}${def.unit ? `<span class="unit">${def.unit}</span>` : ''}</div>
      <div class="when">${esc(cap(fmt.date(r.time)))}${r.label ? ` · ${esc(r.label)}` : trip?.label ? ` · ${esc(trip.label)}` : ''}</div>`;
    return trip ? `<a class="panel record" href="#/rit/${trip.id}">${inner}</a>` : `<div class="panel record">${inner}</div>`;
  }).join('');
  p.insertAdjacentHTML('beforeend', cards ? `<div class="grid g3">${cards}</div>` : '<div class="panel empty">Nog geen records in deze back-up.</div>');

  // Fuel: favourite station and the most economical trip (calculated per trip).
  const fav = stationsOf(DATA.fuel || [])[0];
  const est = fuelEstimates();
  const thrifty = DATA.trips.filter((t) => t.distanceM >= 5000 && est.byTrip.has(t.id))
    .sort((a, b) => est.byTrip.get(a.id).l100 - est.byTrip.get(b.id).l100)[0];
  if (fav || thrifty) {
    p.insertAdjacentHTML('beforeend', `<div class="grid g2">
      ${fav ? `<div class="panel record"><div class="label">Favoriete tankstation</div>
        <div class="value" style="font-size:24px">${esc(fav.name)}</div>
        <div class="when">${fav.visits}× getankt · ${fmt.num(fav.liters)} l · gem. € ${fmt.num(fav.euros / fav.liters, 3)} per liter</div></div>` : ''}
      ${thrifty ? `<a class="panel record" href="#/rit/${thrifty.id}"><div class="label">Zuinigste rit${est.provisional ? ' (voorlopig)' : ''}</div>
        <div class="value">${fmt.num(est.byTrip.get(thrifty.id).l100, 1)}<span class="unit">l/100 km</span></div>
        <div class="when">${esc(cap(fmt.date(thrifty.startTime)))} · ${esc(thrifty.label ?? 'Rit')} · ${fmt.km(thrifty.distanceM)} km</div></a>` : ''}
    </div>`);
  }

  const top5 = (title, sorter, val) => {
    const list = [...DATA.trips].filter((t) => val(t) != null).sort(sorter).slice(0, 5);
    return `<section class="panel"><h2 class="label">${title}</h2>${list.map((t, i) =>
      `<div class="kv"><a class="k" href="#/rit/${t.id}" style="color:var(--text)">${i + 1}. ${esc(t.label ?? 'Rit')}<br><span class="muted" style="font-size:12px">${esc(fmt.dateShort(t.startTime))}</span></a><span class="v">${val(t)}</span></div>`).join('') || '<p class="muted">Geen ritten.</p>'}</section>`;
  };
  p.insertAdjacentHTML('beforeend', `<div class="grid g3">
    ${top5('Langste ritten', (a, b) => b.distanceM - a.distanceM, (t) => `${fmt.km(t.distanceM)} km`)}
    ${top5('Hoogste snelheid', (a, b) => b.maxSpeedKmh - a.maxSpeedKmh, (t) => `${fmt.kmh(t.maxSpeedKmh)} km/u`)}
    ${top5('Beste rijstijl', (a, b) => b.score - a.score || b.distanceM - a.distanceM, (t) => t.score)}
  </div>`);
}

// ---------------------------------------------------------------- start

(async function start() {
  // ?data=<path on this site> loads a backup from the same origin (used for testing).
  const param = new URLSearchParams(location.search).get('data');
  if (param) {
    try {
      const url = new URL(param, location.href);
      if (url.origin !== location.origin) throw new Error('Alleen bestanden van deze site.');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Bestand niet gevonden (${res.status}).`);
      await load(await res.blob(), url.pathname.split('/').pop(), { save: false });
      return;
    } catch (e) {
      els.error.textContent = e.message;
      els.error.hidden = false;
    }
  }
  // On GitHub Pages: the encrypted online data, with the remembered password if there is one.
  if (REMOTE) {
    const pw = savedPw();
    if (pw) await loadRemote(pw, true); else showUnlock();
    return;
  }
  const saved = await idbGet('last');
  if (saved?.blob) { await load(saved.blob, saved.name, { save: false }); return; }
  showDrop();
})();
