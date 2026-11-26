// orbit-core.js: shared orbit maths for the page, its Web Worker and the Node
// verification script. It takes the satellite.js namespace as an argument so the
// browser can load it from the CDN and Node can load it from npm.

export const EARTH_RADIUS_KM = 6378.137;
export const MU = 398600.4418;
const DEG = Math.PI / 180;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Rebuild a CelesTrak-style OMM record from the columnar catalog. */
export function ommAt(cols, i) {
  return {
    OBJECT_NAME: cols.name ? cols.name[i] : '',
    OBJECT_ID: cols.cospar ? cols.cospar[i] : '',
    NORAD_CAT_ID: cols.id[i],
    EPOCH: new Date(cols.epoch[i]).toISOString(),
    MEAN_MOTION: cols.mm[i],
    ECCENTRICITY: cols.ecc[i],
    INCLINATION: cols.inc[i],
    RA_OF_ASC_NODE: cols.raan[i],
    ARG_OF_PERICENTER: cols.argp[i],
    MEAN_ANOMALY: cols.ma[i],
    BSTAR: cols.bstar[i],
    MEAN_MOTION_DOT: cols.ndot[i],
    MEAN_MOTION_DDOT: cols.nddot[i],
    ELEMENT_SET_NO: 999,
  };
}

/** One SGP4 record, or null where initialisation fails. */
export function satrecAt(sat, cols, i) {
  try {
    const rec = sat.json2satrec(ommAt(cols, i));
    return rec && !rec.error ? rec : null;
  } catch {
    return null;
  }
}

/** SGP4 records for objects [start, end) written into `out` (null where initialisation fails). */
export function buildSatrecs(sat, cols, out = new Array(cols.id.length), start = 0, end = cols.id.length) {
  for (let i = start; i < end; i++) out[i] = satrecAt(sat, cols, i);
  return out;
}

/** TEME position/velocity (km, km/s) or null. Handles old and new satellite.js error shapes. */
export function propagateOne(sat, rec, date) {
  if (!rec) return null;
  let pv;
  try {
    pv = sat.propagate(rec, date);
  } catch {
    return null;
  }
  const p = pv && pv.position;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x)) return null;
  return pv;
}

/** Rotate a TEME/ECI vector into Earth-fixed (ECF) coordinates for GMST `gmst` (radians). */
export function eciToEcf(p, gmst) {
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  return { x: p.x * c + p.y * s, y: -p.x * s + p.y * c, z: p.z };
}

/**
 * Propagate objects [start, end) to `date` and write Earth-fixed (ECF) positions
 * in km into `out` (x, y, z per object). Failures are written as `fill`
 * (NaN by default; the page uses 0 so the GPU can skip them).
 * Returns the number of failures.
 */
export function propagateRange(sat, satrecs, date, out, start = 0, end = satrecs.length, fill = NaN) {
  const gmst = sat.gstime(date);
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  let bad = 0;
  for (let i = start; i < end; i++) {
    const pv = propagateOne(sat, satrecs[i], date);
    const j = 3 * i;
    if (pv) {
      const p = pv.position;
      const x = p.x * c + p.y * s;
      const y = -p.x * s + p.y * c;
      const z = p.z;
      // Reject results inside the Earth or absurdly far away (decayed or bad element sets)
      const r = Math.sqrt(x * x + y * y + z * z);
      if (r > EARTH_RADIUS_KM + 80 && r < 500000) {
        out[j] = x; out[j + 1] = y; out[j + 2] = z;
        continue;
      }
    }
    out[j] = out[j + 1] = out[j + 2] = fill;
    bad++;
  }
  return bad;
}

/** Orbit shape from mean elements: semi-major axis, perigee/apogee altitude (km), period (min). */
export function orbitShape(meanMotionRevPerDay, ecc) {
  const n = (meanMotionRevPerDay * 2 * Math.PI) / 86400;
  const a = Math.cbrt(MU / (n * n));
  return {
    a,
    perigee: a * (1 - ecc) - EARTH_RADIUS_KM,
    apogee: a * (1 + ecc) - EARTH_RADIUS_KM,
    period: 1440 / meanMotionRevPerDay,
  };
}

/** Geodetic latitude/longitude (degrees) and altitude (km) from ECF km (WGS-84). */
export function ecfToGeodetic(x, y, z) {
  const lon = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - WGS84_E2));
  let h = 0;
  for (let k = 0; k < 5; k++) {
    const sinLat = Math.sin(lat);
    const N = EARTH_RADIUS_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    h = p / Math.cos(lat) - N;
    lat = Math.atan2(z, p * (1 - (WGS84_E2 * N) / (N + h)));
  }
  return { lat: lat / DEG, lon: lon / DEG, alt: h };
}

/**
 * An observer on the ground, prepared for fast look-angle maths.
 * lat/lon in degrees, height in km.
 */
export function makeObserver(latDeg, lonDeg, heightKm = 0) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
  const sinLon = Math.sin(lon), cosLon = Math.cos(lon);
  const N = EARTH_RADIUS_KM / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  return {
    lat: latDeg, lon: lonDeg,
    x: (N + heightKm) * cosLat * cosLon,
    y: (N + heightKm) * cosLat * sinLon,
    z: (N * (1 - WGS84_E2) + heightKm) * sinLat,
    sinLat, cosLat, sinLon, cosLon,
  };
}

/**
 * Azimuth and elevation (degrees) and range (km) of an ECF point from an observer.
 * Writes into `out` to avoid allocations in hot loops.
 */
export function lookAngles(obs, x, y, z, out = {}) {
  const rx = x - obs.x, ry = y - obs.y, rz = z - obs.z;
  const south = obs.sinLat * obs.cosLon * rx + obs.sinLat * obs.sinLon * ry - obs.cosLat * rz;
  const east = -obs.sinLon * rx + obs.cosLon * ry;
  const up = obs.cosLat * obs.cosLon * rx + obs.cosLat * obs.sinLon * ry + obs.sinLat * rz;
  const range = Math.sqrt(rx * rx + ry * ry + rz * rz);
  out.el = Math.asin(up / range) / DEG;
  let az = Math.atan2(east, -south) / DEG;
  if (az < 0) az += 360;
  out.az = az;
  out.range = range;
  return out;
}

/** ECF position of one object at `date`, or null. */
export function ecfAt(sat, rec, date) {
  const pv = propagateOne(sat, rec, date);
  if (!pv) return null;
  const e = eciToEcf(pv.position, sat.gstime(date));
  e.eci = pv.position;
  e.vel = pv.velocity;
  return e;
}

/**
 * Upcoming passes of one object over an observer.
 * Returns [{aos, los, tca, maxEl, aosAz, losAz, track:[{az, el, t}]}] (times in ms).
 * A pass is any interval with elevation above `minEl` degrees.
 */
export function findPasses(sat, rec, obs, startMs, hours = 48, maxPasses = 6, minEl = 0) {
  const step = 20000;
  const end = startMs + hours * 3600000;
  const tmp = {};
  const elAt = (t) => {
    const e = ecfAt(sat, rec, new Date(t));
    if (!e) return NaN;
    return lookAngles(obs, e.x, e.y, e.z, tmp).el;
  };
  const refine = (lo, hi, rising) => {
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      const above = elAt(mid) > minEl;
      if (above === rising) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const passes = [];
  let prevT = startMs;
  let prevEl = elAt(startMs);
  if (Number.isNaN(prevEl)) return passes;
  let aos = prevEl > minEl ? startMs : null;
  for (let t = startMs + step; t <= end && passes.length < maxPasses; t += step) {
    const el = elAt(t);
    if (Number.isNaN(el)) break;
    if (aos === null && el > minEl && prevEl <= minEl) aos = refine(prevT, t, true);
    if (aos !== null && el <= minEl && prevEl > minEl) {
      const los = refine(prevT, t, false);
      passes.push(describePass(sat, rec, obs, aos, los));
      aos = null;
    }
    prevT = t;
    prevEl = el;
  }
  return passes;
}

function describePass(sat, rec, obs, aos, los) {
  const n = Math.max(12, Math.min(90, Math.round((los - aos) / 15000)));
  const track = [];
  let best = { el: -90, t: aos };
  for (let k = 0; k <= n; k++) {
    const t = aos + ((los - aos) * k) / n;
    const e = ecfAt(sat, rec, new Date(t));
    if (!e) continue;
    const la = lookAngles(obs, e.x, e.y, e.z);
    track.push({ az: la.az, el: Math.max(0, la.el), t });
    if (la.el > best.el) best = { el: la.el, t };
  }
  return {
    aos, los, tca: best.t, maxEl: best.el,
    aosAz: track.length ? track[0].az : NaN,
    losAz: track.length ? track[track.length - 1].az : NaN,
    track,
  };
}
