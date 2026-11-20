// Writes tools/sample.ttbackup: a made-up TripTrack backup (same format as the app) for testing the web page.
// Usage: node tools/sample-backup.mjs [trips]
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const N = Number(process.argv[2] || 140);
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const PLACES = [
  ['Utrecht|Lunetten', 52.0655, 5.1400], ['Utrecht|Overvecht', 52.1170, 5.1100], ['Amersfoort|', 52.1561, 5.3878],
  ['Zeist|', 52.0900, 5.2330], ['Hilversum|', 52.2292, 5.1669], ['Houten|', 52.0280, 5.1680], ['Arnhem|', 51.9851, 5.8987],
  ['Amsterdam|Oost', 52.3600, 4.9300], ['\'s-Hertogenbosch|', 51.6978, 5.3037], ['Nieuwegein|', 52.0290, 5.0810],
];
const HOME = PLACES[0];
const R = 6371000;

function path(a, b) {
  // A curvy line from a to b through two offset waypoints, sampled every ~10 m.
  const [, la1, lo1] = a, [, la2, lo2] = b;
  const way = [[la1, lo1]];
  const dist = Math.hypot(la2 - la1, (lo2 - lo1) * 0.62);
  const round = dist < 0.005;
  const k = round ? 0.03 : dist * 0.25;
  for (const f of [0.33, 0.66]) {
    way.push([la1 + (la2 - la1) * f + (rnd() - 0.5) * k, lo1 + (lo2 - lo1) * f + (rnd() - 0.5) * k / 0.62]);
  }
  if (round) way.splice(2, 0, [la1 + 0.02 * (rnd() - 0.5), lo1 + 0.03]);
  way.push([la2 + 0.0004, lo2]);
  const pts = [];
  for (let s = 0; s < way.length - 1; s++) {
    const [p, q] = [way[s], way[s + 1]];
    const m = Math.hypot((q[0] - p[0]) * 111000, (q[1] - p[1]) * 68000);
    const steps = Math.max(2, Math.round(m / 10));
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const wob = Math.sin(f * Math.PI * 6 + s) * 0.0006;
      pts.push([p[0] + (q[0] - p[0]) * f + wob, p[1] + (q[1] - p[1]) * f - wob]);
    }
  }
  pts.push(way[way.length - 1]);
  return pts;
}

function hav(a, b) {
  const t = Math.PI / 180;
  const x = Math.sin((b[0] - a[0]) * t / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin((b[1] - a[1]) * t / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function trip(startMs, from, to) {
  const line = path(from, to);
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + hav(line[i - 1], line[i]));
  const total = cum[cum.length - 1];
  const cruise = total > 25000 ? 118 + rnd() * 12 : total > 8000 ? 80 : 48;
  const points = [];
  let d = 0, v = 0, t = startMs, j = 0, prevHead = 0, maxV = 0, maxA = 0, maxD = 0, hardA = 0, hardB = 0, gain = 0, loss = 0, lastAlt = null;
  while (d < total) {
    const fromEnd = total - d;
    let target = d < 2500 || fromEnd < 2500 ? 50 : cruise;
    if (fromEnd < 300) target = 15;
    if (rnd() < 0.004) target = 0; // traffic light
    const acc = Math.max(-4.5, Math.min(2.6, (target - v) / 3.6 * 0.35 + (rnd() - 0.5) * 0.4));
    const nv = Math.max(0, v + acc * 3.6);
    if (acc > 2.4) hardA++;
    if (acc < -3.8) hardB++;
    maxA = Math.max(maxA, acc); maxD = Math.max(maxD, -acc);
    v = nv; maxV = Math.max(maxV, v);
    d += Math.max(v / 3.6, 0.5);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const f = (d - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-6);
    const lat = line[j][0] + (line[j + 1][0] - line[j][0]) * Math.min(f, 1);
    const lon = line[j][1] + (line[j + 1][1] - line[j][1]) * Math.min(f, 1);
    const head = Math.atan2(line[j + 1][1] - line[j][1], line[j + 1][0] - line[j][0]);
    const turn = Math.atan2(Math.sin(head - prevHead), Math.cos(head - prevHead));
    prevHead = head;
    const alt = 4 + 25 * Math.max(0, Math.sin(lon * 40)) + Math.max(0, (lon - 5.2) * 60) + (rnd() - 0.5) * 2;
    if (lastAlt != null) { if (alt > lastAlt) gain += alt - lastAlt; else loss += lastAlt - alt; }
    lastAlt = alt;
    const gLong = -acc / 9.81 + (rnd() - 0.5) * 0.02;
    const gLat = Math.max(-0.6, Math.min(0.6, (turn * v / 3.6) / 9.81 + (rnd() - 0.5) * 0.03));
    points.push([t, +lat.toFixed(6), +lon.toFixed(6), +alt.toFixed(1), +(v / 3.6).toFixed(2), 4 + rnd() * 6, 0, +gLong.toFixed(3), +gLat.toFixed(3)]);
    t += 1000;
  }
  const secs = points.length;
  const moving = points.filter((p) => p[4] > 1).length;
  const h = new Date(startMs).getHours();
  const urban = total > 25000 ? 0.15 : total > 8000 ? 0.45 : 0.85;
  const motor = total > 25000 ? 0.6 : total > 8000 ? 0.2 : 0;
  const month = new Date(startMs).getMonth();
  return {
    type: 'trip', startTime: startMs, endTime: t, distanceM: total, totalTimeS: secs, movingTimeS: moving,
    avgMovingKmh: total / moving * 3.6, avgTotalKmh: total / secs * 3.6, maxSpeedKmh: maxV,
    maxAccel: maxA, maxDecel: maxD, hardAccelCount: hardA, hardBrakeCount: hardB, best0to100S: maxV > 100 ? 8 + rnd() * 4 : null,
    elevGainM: Math.round(gain), elevLossM: Math.round(loss), curvinessDegPerKm: 40 + rnd() * 80,
    longestNonStopM: total * (0.4 + rnd() * 0.5), longestNonStopS: Math.round(secs * 0.5), best10kmAvgKmh: total > 10000 ? cruise * 0.9 : null,
    dayPart: h < 6 ? 'Nacht' : h < 12 ? 'Ochtend' : h < 18 ? 'Middag' : 'Avond',
    weatherCode: pick([0, 1, 2, 3, 3, 61, 80, 45, 51]), temperatureC: Math.round(4 + 14 * Math.sin((month - 3) / 12 * 2 * Math.PI) + 6 + rnd() * 4),
    precipitationMm: 0, windKmh: Math.round(rnd() * 30),
    pctUrban: urban, pctRural: (1 - urban - motor) * 0.6, pctExpressway: (1 - urban - motor) * 0.4, pctMotorway: motor, roadTypeEstimated: false,
    recordsSet: '', pctOverLimit: +(rnd() * 6).toFixed(1), maxOverLimitKmh: Math.round(rnd() * 15), limitCoverage: 0.9,
    scoreBraking: Math.round(70 + rnd() * 30), scoreAccel: Math.round(70 + rnd() * 30), scoreCornering: Math.round(75 + rnd() * 25), scoreSmooth: Math.round(60 + rnd() * 38),
    hardCornerCount: Math.round(rnd() * 3), maxLateralAccel: 3 + rnd() * 2,
    gPeakAccel: maxA / 9.81, gPeakBrake: maxD / 9.81, gPeakCorner: 0.2 + rnd() * 0.3, newRoadKm: rnd() < 0.3 ? +(rnd() * 12).toFixed(1) : 0,
    startLat: points[0][1], startLon: points[0][2], endLat: points[secs - 1][1], endLon: points[secs - 1][2],
    startPlace: from[0], endPlace: to[0], points,
  };
}

const trips = [];
let ms = new Date(2025, 0, 6, 7, 40).getTime();
const end = new Date(2026, 10, 18).getTime();
const gap = (end - ms) / N;
for (let i = 0; i < N; i++) {
  const day = new Date(ms + i * gap);
  day.setHours(pick([7, 8, 8, 12, 16, 17, 17, 19, 21, 23]), Math.floor(rnd() * 60));
  const r = rnd();
  const [from, to] = r < 0.35 ? [HOME, PLACES[2]] : r < 0.6 ? [PLACES[2], HOME] : r < 0.7 ? [HOME, HOME] : r < 0.85 ? [HOME, pick(PLACES.slice(1))] : [pick(PLACES.slice(1)), HOME];
  trips.push(trip(day.getTime(), from, to));
}
// Fill-ups: full tank every ~550-700 km at the end of a trip, now and then a partial one.
const STATIONS = ['Shell Utrechtseweg', 'Esso Veldzigt', 'Tango Ravenswade', 'BP Waterlinieweg', 'TotalEnergies Biltstraat'];
const fuel = [];
let sinceFull = 0, nextAt = 0;
trips.forEach((t, i) => {
  sinceFull += t.distanceM / 1000;
  if (i === 0 || sinceFull >= nextAt) {
    const month = new Date(t.startTime).getMonth() + new Date(t.startTime).getFullYear() * 12;
    const price = 1.86 + 0.12 * Math.sin(month / 3) + (rnd() - 0.5) * 0.06;
    const partial = i > 0 && rnd() < 0.12;
    const liters = i === 0 ? 38 : sinceFull * (6.1 + (rnd() - 0.5) * 1.1) / 100 * (partial ? 0.5 : 1);
    t.fuelStation = pick(STATIONS);
    fuel.push({ type: 'fuel', time: t.endTime, liters: +liters.toFixed(2), euros: +(liters * price).toFixed(2), full: !partial,
      station: t.fuelStation, tripStart: t.startTime });
    if (!partial) { sinceFull = 0; nextAt = 550 + rnd() * 150; }
  }
});

const best = trips.reduce((a, t) => (t.maxSpeedKmh > a.maxSpeedKmh ? t : a));
best.recordsSet = 'top_speed';
const longest = trips.reduce((a, t) => (t.distanceM > a.distanceM ? t : a));
longest.recordsSet = longest.recordsSet ? longest.recordsSet + ',longest_trip' : 'longest_trip';

const lines = [
  { type: 'header', format: 'triptrack-backup', version: 1, exported: end, trips: trips.length },
  { type: 'car', car: { plate: 'XX-000-X', brand: 'VOLKSWAGEN', model: 'GOLF', fuel: 'Benzine', consumptionL100: 5.4 } },
  ...fuel,
  { type: 'record', key: 'top_speed', value: best.maxSpeedKmh, time: best.startTime },
  { type: 'record', key: 'longest_trip', value: longest.distanceM / 1000, time: longest.startTime },
  { type: 'record', key: 'zero_100', value: 8.4, time: best.startTime },
  { type: 'record', key: 'most_month', value: 1240.5, time: trips[40].startTime, label: 'mei 2025' },
  { type: 'record', key: 'nonstop_time', value: 3120, time: longest.startTime },
  { type: 'record', key: 'g_corner', value: 0.47, time: trips[12].startTime },
  ...trips,
];
const out = fileURLToPath(new URL('./sample.ttbackup', import.meta.url));
writeFileSync(out, gzipSync(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
console.log(`${out}: ${trips.length} trips, ${trips.reduce((s, t) => s + t.points.length, 0)} points`);
