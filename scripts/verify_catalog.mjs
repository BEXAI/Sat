// Verify site/data/catalog.json with the same satellite.js version and the same
// orbit-core.js the website uses.
//
// Usage (from the repo root, after `npm ci`):
//   node scripts/verify_catalog.mjs                                  # sanity checks
//   node scripts/verify_catalog.mjs --reference test-output/reference.json
//
// Exits non-zero if too many objects fail to propagate, or if positions differ
// from the independent reference by more than the tolerance.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sat = await import(require.resolve('satellite.js', { paths: [here] }));
const core = await import(path.join(here, '..', 'site', 'orbit-core.js'));

const args = process.argv.slice(2);
const refPath = args.includes('--reference') ? args[args.indexOf('--reference') + 1] : null;
const catalog = JSON.parse(readFileSync(path.join(here, '..', 'site', 'data', 'catalog.json'), 'utf8'));
const { cols, tables } = catalog;
const n = cols.id.length;
let failed = false;

console.log(`catalog: ${n} objects, built ${catalog.builtAt}, fetched ${catalog.fetchedAt}`);

// 1. Schema: every column has one entry per object; ids unique.
for (const [k, v] of Object.entries(cols)) {
  if (v.length !== n) { console.error(`  column ${k} has ${v.length} entries, expected ${n}`); failed = true; }
}
if (new Set(cols.id).size !== n) { console.error('  duplicate NORAD ids'); failed = true; }

// 2. Initialise + propagate everything "now" (the page's hot path), and time it.
let t0 = performance.now();
const recs = core.buildSatrecs(sat, cols);
const initMs = performance.now() - t0;
const initFail = recs.filter((r) => !r).length;
const date = refPath ? new Date(JSON.parse(readFileSync(refPath, 'utf8')).time) : new Date();
const pos = new Float32Array(3 * n);
t0 = performance.now();
const bad = core.propagateRange(sat, recs, date, pos);
const propMs = performance.now() - t0;
console.log(`init: ${initMs.toFixed(0)} ms (${initFail} failed) · full propagation: ${propMs.toFixed(0)} ms (${bad} failed) at ${date.toISOString()}`);
if (bad > n * 0.01) { console.error('  more than 1% of objects failed to propagate'); failed = true; }

// 3. Altitude sanity by regime.
const ranges = { LEO: [100, 2500], MEO: [1500, 40000], GEO: [30000, 42000], HEO: [100, 400000] };
let outOfRange = 0;
for (let i = 0; i < n; i++) {
  if (Number.isNaN(pos[3 * i])) continue;
  const g = core.ecfToGeodetic(pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]);
  const [lo, hi] = ranges[tables.regime[cols.regime[i]]];
  if (g.alt < lo || g.alt > hi) outOfRange++;
}
console.log(`altitude outside the expected range for its regime: ${outOfRange}`);
if (outOfRange > n * 0.01) failed = true;

// 4. ISS spot check.
const iss = cols.id.indexOf(25544);
if (iss >= 0) {
  const g = core.ecfToGeodetic(pos[3 * iss], pos[3 * iss + 1], pos[3 * iss + 2]);
  console.log(`ISS: lat ${g.lat.toFixed(3)}°, lon ${g.lon.toFixed(3)}°, alt ${g.alt.toFixed(1)} km`);
  if (g.alt < 350 || g.alt > 480) { console.error('  ISS altitude looks wrong'); failed = true; }
}

// 5. Compare TEME positions with the independent Python sgp4 reference.
if (refPath) {
  const ref = JSON.parse(readFileSync(refPath, 'utf8'));
  const index = new Map(cols.id.map((id, i) => [id, i]));
  const errs = [];
  for (const [id, r] of Object.entries(ref.positions)) {
    const i = index.get(Number(id));
    if (i === undefined) continue;
    const pv = core.propagateOne(sat, recs[i], date);
    if (!pv) continue;
    const p = pv.position;
    errs.push({ id, d: Math.hypot(p.x - r[0], p.y - r[1], p.z - r[2]) });
  }
  errs.sort((a, b) => a.d - b.d);
  const q = (f) => errs[Math.min(errs.length - 1, Math.floor(f * errs.length))].d;
  console.log(`vs reference (${errs.length} objects): median ${(q(0.5) * 1000).toFixed(1)} m, 99th pct ${(q(0.99) * 1000).toFixed(1)} m, max ${(errs.at(-1).d * 1000).toFixed(1)} m (NORAD ${errs.at(-1).id})`);
  if (q(0.99) > 1.0) { console.error('  99th percentile difference exceeds 1 km'); failed = true; }
}

console.log(failed ? 'VERIFY: FAILED' : 'VERIFY: OK');
process.exit(failed ? 1 : 0);
