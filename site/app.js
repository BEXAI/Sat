// Orbitwatch: live positions of every publicly catalogued active satellite.
//
// Data: site/data/catalog.json (CelesTrak GP element sets + SATCAT metadata) and
// site/data/world.json (Natural Earth outlines), both published beside the page.
// Positions: SGP4 (satellite.js) in a Web Worker, sampled a few times per second
// and interpolated on the GPU so motion stays smooth at any playback speed.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { json2satrec } from 'satellite.js/dist/io.js';
import { propagate, gstime } from 'satellite.js/dist/propagation.js';
import { jday } from 'satellite.js/dist/ext.js';
import { sunPos } from 'satellite.js/dist/sun.js';
import { shadowFraction } from 'satellite.js/dist/shadow.js';
import {
  EARTH_RADIUS_KM, satrecAt, buildSatrecs, propagateRange, propagateOne, orbitShape,
  ecfToGeodetic, makeObserver, lookAngles, ecfAt, eciToEcf, findPasses,
} from './orbit-core.js';

const sat = { json2satrec, propagate, gstime };
const R = EARTH_RADIUS_KM;
const DAY = 86400000;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const CATEGORY_LABELS = {
  stations: 'Space stations',
  starlink: 'Starlink',
  oneweb: 'OneWeb',
  kuiper: 'Amazon Kuiper',
  navigation: 'Navigation (GNSS)',
  military: 'Military',
  weather: 'Weather',
  earth: 'Earth observation',
  comms: 'Communications',
  science: 'Science & tech demos',
  other: 'Other',
};
const REGIME_LABELS = { LEO: 'Low Earth orbit', MEO: 'Medium Earth orbit', GEO: 'Geosynchronous', HEO: 'Highly elliptical' };
const QUICK_PICKS = [25544, 48274, 20580, 43013, 60133, 49260, 41866];
const BOOST = new Map(QUICK_PICKS.map((id, k) => [id, k]));
const CITIES = [
  ['Auckland', -36.8485, 174.7633], ['Beijing', 39.9042, 116.4074], ['Berlin', 52.52, 13.405],
  ['Buenos Aires', -34.6037, -58.3816], ['Cairo', 30.0444, 31.2357], ['Cape Canaveral', 28.3922, -80.6077],
  ['Chicago', 41.8781, -87.6298], ['Delhi', 28.6139, 77.209], ['Dubai', 25.2048, 55.2708],
  ['Honolulu', 21.3069, -157.8583], ['Houston', 29.7604, -95.3698], ['Istanbul', 41.0082, 28.9784],
  ['Johannesburg', -26.2041, 28.0473], ['Lagos', 6.5244, 3.3792], ['London', 51.5072, -0.1276],
  ['Los Angeles', 34.0522, -118.2437], ['Madrid', 40.4168, -3.7038], ['Mexico City', 19.4326, -99.1332],
  ['Moscow', 55.7558, 37.6173], ['Mumbai', 19.076, 72.8777], ['Nairobi', -1.2921, 36.8219],
  ['New York', 40.7128, -74.006], ['Paris', 48.8566, 2.3522], ['Reykjavík', 64.1466, -21.9426],
  ['Rome', 41.9028, 12.4964], ['São Paulo', -23.5505, -46.6333], ['Seoul', 37.5665, 126.978],
  ['Shanghai', 31.2304, 121.4737], ['Singapore', 1.3521, 103.8198], ['Sydney', -33.8688, 151.2093],
  ['Tokyo', 35.6762, 139.6503], ['Toronto', 43.6532, -79.3832],
];

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...children) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs) {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'text') n.textContent = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v);
  }
  return n;
}
const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => nf.format(Math.round(n));
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const pad = (n) => String(n).padStart(2, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function utcStamp(t) {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
function localTime(t, withDate) {
  const d = new Date(t);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${d.getDate()} ${MONTHS[d.getMonth()]} ${hm}` : hm;
}
function ago(ms) {
  const m = Math.abs(ms) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.round(m)} min`;
  const hr = m / 60;
  if (hr < 48) return `${Math.round(hr)} h`;
  return `${Math.round(hr / 24)} days`;
}
function offsetLabel(ms) {
  if (Math.abs(ms) < 30000) return 'now';
  const sign = ms < 0 ? '−' : '+';
  let m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440); m -= d * 1440;
  const hh = Math.floor(m / 60); m -= hh * 60;
  return sign + (d ? `${d} d ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`);
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (az) => COMPASS[Math.round(az / 22.5) % 16];
const store = {
  get(k, fallback) { try { const v = localStorage.getItem('orbitwatch:' + k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('orbitwatch:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Theme tokens -> numbers the renderers can use
function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  const t = {};
  for (const n of ['bg', 'panel', 'ink', 'muted', 'line', 'accent', 'ocean', 'land', 'border', 'grid', 'night', 'rim']) t[n] = get('--' + n);
  t.cat = {};
  for (const k of Object.keys(CATEGORY_LABELS)) t.cat[k] = get('--c-' + k);
  return t;
}
const probe = document.createElement('canvas').getContext('2d');
function rgba(css) {
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  const v = probe.fillStyle;
  if (v.startsWith('#')) {
    const n = parseInt(v.slice(1), 16);
    return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  const m = v.match(/[\d.]+/g) || [0, 0, 0, 1];
  return [m[0] / 255, m[1] / 255, m[2] / 255, m[3] == null ? 1 : +m[3]];
}

// ------------------------------------------------------------------ state
let catalog, cols, tables, N;
let catKey;          // category key per object
let tokens = readTokens();
let world = null;
let globe = null, map = null;
let view = store.get('view', 'globe');
let sched = null;
let vis;             // Float32Array visibility per object
let visibleCount = 0;
let favs = new Set(store.get('favs', []));
let observer = null; // {lat, lon, name, o: prepared}
let picking = false;
let sel = null;      // {i, rec, passes, passesFor}
let follow = false;
let searchIndex;     // lowercase names

const time = { base: Date.now(), wall: performance.now(), speed: 1, paused: false };
function simNow() { return time.paused ? time.base : time.base + (performance.now() - time.wall) * time.speed; }
function setSim(t, opts = {}) {
  time.base = t;
  time.wall = performance.now();
  if (opts.speed != null) time.speed = opts.speed;
  if (opts.paused != null) time.paused = opts.paused;
  updateTimeUI(true);
}
const isLive = () => !time.paused && time.speed === 1 && Math.abs(simNow() - Date.now()) < 5000;

// ------------------------------------------------------------------ position providers
function numericColumns() {
  const out = {};
  for (const k of ['id', 'epoch', 'mm', 'ecc', 'inc', 'raan', 'argp', 'ma', 'bstar', 'ndot', 'nddot']) out[k] = Float64Array.from(cols[k]);
  return out;
}

function workerProvider(onSnap) {
  return new Promise((resolve, reject) => {
    let w;
    try {
      w = new Worker(new URL('propagate.worker.js', document.baseURI), { type: 'module' });
    } catch (e) { reject(e); return; }
    const fail = (why) => { clearTimeout(timer); try { w.terminate(); } catch { /* ignore */ } reject(new Error(why)); };
    let timer = setTimeout(() => fail('worker did not start'), 12000);
    w.onerror = (e) => { e.preventDefault?.(); fail('worker error'); };
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'loaded') {
        clearTimeout(timer);
        timer = setTimeout(() => fail('worker init timeout'), 30000);
        const c = numericColumns();
        w.postMessage({ type: 'init', cols: c }, Object.values(c).map((a) => a.buffer));
      } else if (m.type === 'ready') {
        clearTimeout(timer);
        w.onerror = (e) => console.warn('worker error', e);
        resolve({
          kind: 'worker',
          slow: 1,
          request(key, t) { w.postMessage({ type: 'prop', key, time: t }); },
        });
      } else if (m.type === 'pos') {
        onSnap(m.key, m.time, m.buf);
      }
    };
  });
}

function mainThreadProvider(onSnap) {
  // Fallback when Web Workers are unavailable: same maths in small time slices.
  const recs = new Array(N);
  let built = 0;
  const queue = [];
  let running = false;
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  const pump = () => {
    const t0 = performance.now();
    while (performance.now() - t0 < 10) {
      if (built < N) {
        const end = Math.min(N, built + 400);
        buildSatrecs(sat, cols, recs, built, end);
        built = end;
        if (built === N) readyResolve();
        continue;
      }
      const job = queue[0];
      if (!job) { running = false; return; }
      const end = Math.min(N, job.i + 800);
      propagateRange(sat, recs, new Date(job.t), job.buf, job.i, end, 0);
      job.i = end;
      if (end === N) { queue.shift(); onSnap(job.key, job.t, job.buf); }
    }
    setTimeout(pump, 0);
  };
  const kick = () => { if (!running) { running = true; setTimeout(pump, 0); } };
  kick();
  return ready.then(() => ({
    kind: 'main thread',
    slow: 2.5,
    request(key, t) { queue.push({ key, t, i: 0, buf: new Float32Array(3 * N) }); kick(); },
  }));
}

// Keeps two snapshots around "now" (a at or before, b after) and the blend factor f.
class Scheduler {
  constructor() { this.provider = null; this.snaps = new Map(); this.pending = new Set(); this.a = null; this.b = null; this.f = 0; }
  onSnap(key, t, buf) { this.pending.delete(key); this.snaps.set(key, { t, buf }); }
  step(speed) {
    const slow = this.provider ? this.provider.slow : 1;
    if (speed <= 1) return 1000 * slow;
    const wall = speed <= 10 ? 500 : speed <= 60 ? 300 : 220;
    return speed * wall * slow;
  }
  request(key, t) { this.pending.add(key); this.provider.request(key, t); }
  update(t) {
    if (!this.provider) return;
    if (time.paused) {
      const tt = Math.round(t);
      const key = 'p' + tt;
      const sn = this.snaps.get(key);
      if (sn) { this.a = this.b = sn; this.f = 0; this.prune(new Set([key])); }
      else if (this.pending.size === 0) this.request(key, tt);
      return;
    }
    const step = this.step(time.speed);
    const g0 = Math.floor(t / step) * step;
    const keys = [0, 1, 2].map((k) => `${step}:${g0 + k * step}`);
    for (let k = 0; k < 3; k++) {
      if (!this.snaps.has(keys[k]) && !this.pending.has(keys[k]) && this.pending.size < 2) this.request(keys[k], g0 + k * step);
    }
    const s0 = this.snaps.get(keys[0]);
    const s1 = this.snaps.get(keys[1]);
    if (s0 && s1) { this.a = s0; this.b = s1; this.f = Math.min(1, Math.max(0, (t - g0) / step)); }
    else if (s0) { this.a = this.b = s0; this.f = 0; }
    this.prune(new Set(keys));
  }
  prune(keep) { for (const k of this.snaps.keys()) if (!keep.has(k)) this.snaps.delete(k); }
  // Interpolated ECF km position of object i (same blend as the GPU shader). Returns false if unknown.
  pos(i, out) {
    if (!this.a) return false;
    const A = this.a.buf, B = this.b.buf, j = 3 * i;
    const ax = A[j], ay = A[j + 1], az = A[j + 2];
    const bx = B[j], by = B[j + 1], bz = B[j + 2];
    if ((ax === 0 && ay === 0 && az === 0) || (bx === 0 && by === 0 && bz === 0)) return false;
    const f = this.f;
    let x = ax + (bx - ax) * f, y = ay + (by - ay) * f, z = az + (bz - az) * f;
    const ra = Math.sqrt(ax * ax + ay * ay + az * az), rb = Math.sqrt(bx * bx + by * by + bz * bz);
    const k = (ra + (rb - ra) * f) / Math.sqrt(x * x + y * y + z * z);
    out.x = x * k; out.y = y * k; out.z = z * k;
    return true;
  }
}

// ------------------------------------------------------------------ world map drawing (shared)
function drawWorld(ctx, W, H, tk, opts = {}) {
  ctx.fillStyle = tk.ocean;
  ctx.fillRect(0, 0, W, H);
  const X = (lon) => ((lon + 180) / 360) * W;
  const Y = (lat) => ((90 - lat) / 180) * H;
  ctx.strokeStyle = tk.grid;
  ctx.lineWidth = Math.max(1, W / 2048);
  ctx.beginPath();
  for (let lon = -180; lon <= 180; lon += 30) { ctx.moveTo(X(lon), 0); ctx.lineTo(X(lon), H); }
  for (let lat = -60; lat <= 60; lat += 30) { ctx.moveTo(0, Y(lat)); ctx.lineTo(W, Y(lat)); }
  ctx.stroke();
  if (!world) return;
  ctx.fillStyle = tk.land;
  ctx.beginPath();
  for (const ring of world.land) {
    // rings crossing the antimeridian are stored unwrapped; draw the copy on each side too
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < ring.length; k += 2) { if (ring[k] < lo) lo = ring[k]; if (ring[k] > hi) hi = ring[k]; }
    for (const off of [-360, 0, 360]) {
      if (lo + off >= 180 || hi + off <= -180) continue;
      ctx.moveTo(X(ring[0] + off), Y(ring[1]));
      for (let k = 2; k < ring.length; k += 2) ctx.lineTo(X(ring[k] + off), Y(ring[k + 1]));
      ctx.closePath();
    }
  }
  ctx.fill('evenodd');
  ctx.strokeStyle = tk.border;
  ctx.lineWidth = opts.borderWidth || Math.max(0.8, W / 3000);
  ctx.beginPath();
  for (const line of world.borders) {
    ctx.moveTo(X(line[0]), Y(line[1]));
    for (let k = 2; k < line.length; k += 2) {
      if (Math.abs(line[k] - line[k - 2]) > 180) ctx.moveTo(X(line[k]), Y(line[k + 1]));
      else ctx.lineTo(X(line[k]), Y(line[k + 1]));
    }
  }
  ctx.stroke();
}

// Scene coordinates: Earth radius 1, Y = north pole, +X = 0° lon, -Z = 90°E.
const toScene = (x, y, z, out) => out.set(x / R, z / R, -y / R);

function sunDirectionEcf(t) {
  const d = new Date(t);
  const r = sunPos(jday(d)).rsun;
  const e = eciToEcf(r, gstime(d));
  const n = Math.hypot(e.x, e.y, e.z);
  return { x: e.x / n, y: e.y / n, z: e.z / n, eci: r };
}

// ------------------------------------------------------------------ globe (three.js)
const POINT_VS = `
attribute vec3 posB;
attribute vec3 color;
attribute float vis;
uniform float uF;
uniform float uSize;
uniform float uPx;
varying vec3 vColor;
void main() {
  vec3 a = position;
  vec3 b = posB;
  if (vis < 0.5 || dot(a, a) < 1.0 || dot(b, b) < 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 e = normalize(mix(a, b, uF)) * mix(length(a), length(b), uF);
  vec3 p = vec3(e.x, e.z, -e.y) / ${R.toFixed(3)};
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(uSize * uPx * 3.4 / -mv.z, 1.7 * uPx, 6.0 * uPx);
  vColor = color;
}`;
const POINT_FS = `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  gl_FragColor = vec4(vColor, smoothstep(0.5, 0.32, d));
}`;
const RING_FS = `
uniform vec3 uColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float ring = smoothstep(0.5, 0.43, d) * smoothstep(0.30, 0.37, d);
  float core = smoothstep(0.16, 0.10, d);
  float a = max(ring, core);
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
}`;
const MARK_VS = `
uniform float uSize;
uniform float uPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPx;
}`;
const EARTH_VS = `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vView = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const EARTH_FS = `
uniform sampler2D map;
uniform vec3 sunDir;
uniform vec4 night;
uniform vec3 rim;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vView;
void main() {
  vec3 n = normalize(vN);
  vec3 base = texture2D(map, vUv).rgb;
  float day = smoothstep(-0.09, 0.09, dot(n, sunDir));
  vec3 col = mix(mix(base, night.rgb, night.a), base, day);
  float r = pow(1.0 - max(dot(n, normalize(vView)), 0.0), 4.0);
  col = mix(col, rim, r * 0.38);
  gl_FragColor = vec4(col, 1.0);
}`;

function createGlobe(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const px = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(px);
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = !reducedMotion;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.minDistance = 1.2;
  controls.maxDistance = 30;
  controls.rotateSpeed = 0.5;
  controls.zoomSpeed = 0.9;

  // Earth
  const maxTex = renderer.capabilities.maxTextureSize;
  const small = Math.max(screen.width, screen.height) < 1000;
  const texW = maxTex >= 4096 && !small ? 4096 : 2048;
  const texCanvas = document.createElement('canvas');
  texCanvas.width = texW; texCanvas.height = texW / 2;
  const texture = new THREE.CanvasTexture(texCanvas);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const earthMat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      night: { value: new THREE.Vector4(0, 0, 0, 0.5) },
      rim: { value: new THREE.Vector3(0.5, 0.6, 0.8) },
    },
    vertexShader: EARTH_VS,
    fragmentShader: EARTH_FS,
  });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), earthMat);
  scene.add(earth);

  // Satellites
  const geo = new THREE.BufferGeometry();
  const posA = new THREE.BufferAttribute(new Float32Array(3 * N), 3);
  const posB = new THREE.BufferAttribute(new Float32Array(3 * N), 3);
  const color = new THREE.BufferAttribute(new Float32Array(3 * N), 3);
  const visAttr = new THREE.BufferAttribute(vis, 1);
  posA.setUsage(THREE.DynamicDrawUsage); posB.setUsage(THREE.DynamicDrawUsage); visAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posA);
  geo.setAttribute('posB', posB);
  geo.setAttribute('color', color);
  geo.setAttribute('vis', visAttr);
  const pointMat = new THREE.ShaderMaterial({
    uniforms: { uF: { value: 0 }, uSize: { value: 2.7 }, uPx: { value: px } },
    vertexShader: POINT_VS,
    fragmentShader: POINT_FS,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, pointMat);
  points.frustumCulled = false;
  scene.add(points);

  // Markers: selected object and observer
  const markMat = (size) => new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Vector3(1, 0.4, 0.1) }, uSize: { value: size }, uPx: { value: px } },
    vertexShader: MARK_VS, fragmentShader: RING_FS, transparent: true, depthWrite: false,
  });
  const selGeo = new THREE.BufferGeometry();
  selGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const selMark = new THREE.Points(selGeo, markMat(26));
  selMark.frustumCulled = false; selMark.visible = false; selMark.renderOrder = 3;
  scene.add(selMark);
  const obsGeo = new THREE.BufferGeometry();
  obsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const obsMark = new THREE.Points(obsGeo, markMat(16));
  obsMark.frustumCulled = false; obsMark.visible = false; obsMark.renderOrder = 2;
  scene.add(obsMark);

  // Orbit (inertial ellipse, rotated into the Earth-fixed frame each frame) and ground track
  const orbitGroup = new THREE.Group();
  scene.add(orbitGroup);
  const orbitMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const orbitLine = new THREE.Line(new THREE.BufferGeometry(), orbitMat);
  orbitLine.frustumCulled = false;
  orbitGroup.add(orbitLine);
  const trackMat = new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, dashSize: 0.02, gapSize: 0.014 });
  const trackLine = new THREE.Line(new THREE.BufferGeometry(), trackMat);
  trackLine.frustumCulled = false;
  scene.add(trackLine);
  orbitGroup.visible = trackLine.visible = false;

  const tmpV = new THREE.Vector3();
  const pv = new THREE.Matrix4();
  let lastA = null, lastB = null, sunT = -Infinity, orbitInfo = null;
  let tween = null;

  function applyTheme() {
    const ctx = texCanvas.getContext('2d');
    drawWorld(ctx, texCanvas.width, texCanvas.height, tokens);
    texture.needsUpdate = true;
    const n = rgba(tokens.night); earthMat.uniforms.night.value.set(n[0], n[1], n[2], Math.min(0.85, n[3] * 1.4));
    const r = rgba(tokens.rim); earthMat.uniforms.rim.value.set(r[0], r[1], r[2]);
    const a = rgba(tokens.accent);
    selMark.material.uniforms.uColor.value.set(a[0], a[1], a[2]);
    obsMark.material.uniforms.uColor.value.set(a[0], a[1], a[2]);
    orbitMat.color.set(tokens.accent); trackMat.color.set(tokens.accent);
    recolor();
  }
  function recolor() {
    const arr = color.array;
    const cache = {};
    for (const k of Object.keys(CATEGORY_LABELS)) cache[k] = rgba(tokens.cat[k]);
    for (let i = 0; i < N; i++) { const c = cache[catKey[i]]; arr[3 * i] = c[0]; arr[3 * i + 1] = c[1]; arr[3 * i + 2] = c[2]; }
    color.needsUpdate = true;
  }
  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }
  function lookAtLatLon(lat, lon, dist = 3.3) {
    const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
    camera.position.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(dist);
    controls.update();
  }
  function flyTo(dir, minDist) {
    const from = camera.position.clone();
    const d0 = from.length();
    const d1 = Math.max(d0, minDist || 0);
    const to = dir.clone().normalize();
    if (reducedMotion) { camera.position.copy(to.multiplyScalar(d1)); return; }
    tween = { from: from.normalize(), to, d0, d1, t0: performance.now(), dur: 900 };
  }
  function setOrbit(info) {
    orbitInfo = info;
    if (!info) { orbitGroup.visible = trackLine.visible = false; return; }
    orbitLine.geometry.dispose();
    orbitLine.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(info.eciScene, 3));
    trackLine.geometry.dispose();
    trackLine.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(info.trackScene, 3));
    trackLine.computeLineDistances();
    orbitGroup.visible = trackLine.visible = true;
  }
  function setObserver(o) {
    if (!o) { obsMark.visible = false; return; }
    const la = (o.lat * Math.PI) / 180, lo = (o.lon * Math.PI) / 180;
    const p = obsGeo.attributes.position;
    p.setXYZ(0, Math.cos(la) * Math.cos(lo) * 1.002, Math.sin(la) * 1.002, -Math.cos(la) * Math.sin(lo) * 1.002);
    p.needsUpdate = true;
    obsMark.visible = true;
  }

  function render(t) {
    const a = sched.a, b = sched.b;
    if (a && (a !== lastA || b !== lastB)) {
      posA.array = a.buf; posA.needsUpdate = true;
      posB.array = b.buf; posB.needsUpdate = true;
      lastA = a; lastB = b;
    }
    pointMat.uniforms.uF.value = sched.f;
    if (Math.abs(t - sunT) > 30000) {
      const sd = sunDirectionEcf(t);
      earthMat.uniforms.sunDir.value.set(sd.x, sd.z, -sd.y);
      sunT = t;
    }
    // selection marker, follow, orbit rotation
    if (sel && sched.pos(sel.i, scratch)) {
      toScene(scratch.x, scratch.y, scratch.z, tmpV);
      selGeo.attributes.position.setXYZ(0, tmpV.x, tmpV.y, tmpV.z);
      selGeo.attributes.position.needsUpdate = true;
      selMark.visible = true;
      if (follow && !tween) {
        const d = camera.position.length();
        const target = tmpV.clone().normalize().multiplyScalar(Math.max(d, tmpV.length() + 0.6));
        camera.position.lerp(target, reducedMotion ? 1 : 0.08);
      }
    } else selMark.visible = false;
    if (orbitInfo) orbitGroup.rotation.y = -gstime(new Date(t));
    if (tween) {
      const k = Math.min(1, (performance.now() - tween.t0) / tween.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const dir = tween.from.clone().lerp(tween.to, e).normalize();
      camera.position.copy(dir.multiplyScalar(tween.d0 + (tween.d1 - tween.d0) * e));
      if (k >= 1) tween = null;
    }
    // shrink points a little when zoomed far out
    pointMat.uniforms.uSize.value = camera.position.length() > 8 ? 2.2 : 2.7;
    controls.update();
    renderer.render(scene, camera);
  }

  // Screen-space picking that respects the Earth hiding objects behind it.
  function pick(clientX, clientY, radius = 14) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    camera.updateMatrixWorld();
    pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const m = pv.elements;
    const C = camera.position;
    const cc = C.x * C.x + C.y * C.y + C.z * C.z - 1;
    let best = -1, bestD = radius * radius;
    for (let i = 0; i < N; i++) {
      if (!vis[i] || !sched.pos(i, scratch)) continue;
      const x = scratch.x / R, y = scratch.z / R, z = -scratch.y / R;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) continue;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w * 0.5 + 0.5) * rect.width;
      const sy = (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w * 0.5) * rect.height;
      const d2 = (sx - mx) ** 2 + (sy - my) ** 2;
      if (d2 >= bestD) continue;
      // occluded if the segment camera -> point hits the unit sphere first
      const dx = x - C.x, dy = y - C.y, dz = z - C.z;
      const A = dx * dx + dy * dy + dz * dz;
      const B = 2 * (C.x * dx + C.y * dy + C.z * dz);
      const disc = B * B - 4 * A * cc;
      if (disc > 0) {
        const t1 = (-B - Math.sqrt(disc)) / (2 * A);
        if (t1 > 0 && t1 < 1) continue;
      }
      best = i; bestD = d2;
    }
    return best;
  }
  // Ground point under the cursor (lat/lon degrees) or null.
  const ray = new THREE.Raycaster();
  function groundAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(earth)[0];
    if (!hit) return null;
    const p = hit.point.normalize();
    return { lat: (Math.asin(p.y) * 180) / Math.PI, lon: (Math.atan2(-p.z, p.x) * 180) / Math.PI };
  }

  new ResizeObserver(resize).observe(canvas);
  resize();
  return { render, applyTheme, recolor, pick, groundAt, lookAtLatLon, flyTo, setOrbit, setObserver, controls, camera, visAttr, canvas };
}
const scratch = { x: 0, y: 0, z: 0 };

// ------------------------------------------------------------------ 2D map
function createMap(canvas) {
  const ctx = canvas.getContext('2d');
  const base = document.createElement('canvas');
  let W = 0, H = 0, px = 1, box = { x: 0, y: 0, w: 0, h: 0 };
  const screenXY = new Float32Array(2 * N).fill(-1e4);
  let byCat = {};
  let lastDraw = 0;
  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    px = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(r.width * px); H = Math.round(r.height * px);
    canvas.width = W; canvas.height = H;
    const w = Math.min(W, H * 2), hh = w / 2;
    box = { x: (W - w) / 2, y: (H - hh) / 2, w, h: hh };
    base.width = Math.max(1, Math.round(box.w)); base.height = Math.max(1, Math.round(box.h));
    drawWorld(base.getContext('2d'), base.width, base.height, tokens, { borderWidth: Math.max(0.6, px * 0.6) });
  }
  function regroup() {
    byCat = {};
    for (let i = 0; i < N; i++) if (vis[i]) (byCat[catKey[i]] ||= []).push(i);
  }
  const X = (lon) => box.x + ((lon + 180) / 360) * box.w;
  const Y = (lat) => box.y + ((90 - lat) / 180) * box.h;
  function terminator(t) {
    const sd = sunDirectionEcf(t);
    const dec = Math.asin(sd.z);
    const sunLon = Math.atan2(sd.y, sd.x);
    ctx.fillStyle = tokens.night;
    ctx.beginPath();
    const steps = 180;
    for (let k = 0; k <= steps; k++) {
      const lon = -Math.PI + (2 * Math.PI * k) / steps;
      const lat = Math.atan(-Math.cos(lon - sunLon) / Math.tan(Math.abs(dec) < 1e-4 ? 1e-4 : dec));
      const x = X((lon * 180) / Math.PI), y = Y((lat * 180) / Math.PI);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    const edge = dec > 0 ? box.y + box.h : box.y; // night is on the pole facing away from the sun
    ctx.lineTo(box.x + box.w, edge); ctx.lineTo(box.x, edge);
    ctx.closePath();
    ctx.fill();
  }
  function ring(x, y, r, colr) {
    ctx.strokeStyle = colr; ctx.lineWidth = 2 * px;
    ctx.beginPath(); ctx.arc(x, y, r * px, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = colr; ctx.beginPath(); ctx.arc(x, y, 2 * px, 0, Math.PI * 2); ctx.fill();
  }
  function draw(t, force) {
    const now = performance.now();
    if (!force && now - lastDraw < 33) return;
    lastDraw = now;
    if (!W) layout();
    ctx.fillStyle = tokens.bg;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, box.x, box.y, box.w, box.h);
    terminator(t);
    // ground track of the selection
    if (sel && sel.track) {
      ctx.strokeStyle = tokens.accent; ctx.lineWidth = 1.5 * px; ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath();
      let prev = null;
      for (const [lat, lon] of sel.track) {
        const x = X(lon), y = Y(lat);
        if (prev === null || Math.abs(lon - prev) > 180) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        prev = lon;
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const sz = Math.max(1.6, 1.6 * px);
    for (const [k, list] of Object.entries(byCat)) {
      ctx.fillStyle = tokens.cat[k];
      for (const i of list) {
        if (!sched.pos(i, scratch)) { screenXY[2 * i] = -1e4; continue; }
        const lon = (Math.atan2(scratch.y, scratch.x) * 180) / Math.PI;
        const lat = (Math.atan2(scratch.z, Math.hypot(scratch.x, scratch.y)) * 180) / Math.PI;
        const x = X(lon), y = Y(lat);
        screenXY[2 * i] = x; screenXY[2 * i + 1] = y;
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
    }
    if (observer) ring(X(observer.lon), Y(observer.lat), 6, tokens.accent);
    if (sel && sched.pos(sel.i, scratch)) {
      const lon = (Math.atan2(scratch.y, scratch.x) * 180) / Math.PI;
      const lat = (Math.atan2(scratch.z, Math.hypot(scratch.x, scratch.y)) * 180) / Math.PI;
      ring(X(lon), Y(lat), 9, tokens.accent);
    }
  }
  function pick(clientX, clientY, radius = 10) {
    const r = canvas.getBoundingClientRect();
    const mx = (clientX - r.left) * px, my = (clientY - r.top) * px;
    let best = -1, bestD = (radius * px) ** 2;
    for (let i = 0; i < N; i++) {
      if (!vis[i]) continue;
      const d2 = (screenXY[2 * i] - mx) ** 2 + (screenXY[2 * i + 1] - my) ** 2;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  }
  function groundAt(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = (clientX - r.left) * px, y = (clientY - r.top) * px;
    if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) return null;
    return { lon: ((x - box.x) / box.w) * 360 - 180, lat: 90 - ((y - box.y) / box.h) * 180 };
  }
  new ResizeObserver(() => { layout(); draw(simNow(), true); }).observe(canvas);
  return { draw, pick, groundAt, regroup, applyTheme() { layout(); }, canvas };
}

// ------------------------------------------------------------------ filters
const filt = { cats: new Set(Object.keys(CATEGORY_LABELS)), regimes: new Set(['LEO', 'MEO', 'GEO', 'HEO']), owner: '', favs: false, recent: false };
function launchMs(i) {
  const v = cols.launch[i];
  if (!v) return 0;
  return Date.UTC(Math.floor(v / 10000), (Math.floor(v / 100) % 100) - 1, v % 100);
}
function applyFilters() {
  const ownerIdx = filt.owner === '' ? -1 : tables.owner.indexOf(filt.owner);
  const recentCut = Date.now() - 30 * DAY;
  let n = 0;
  for (let i = 0; i < N; i++) {
    let ok = filt.cats.has(catKey[i]) && filt.regimes.has(tables.regime[cols.regime[i]]);
    if (ok && ownerIdx >= 0) ok = cols.owner[i] === ownerIdx;
    if (ok && filt.favs) ok = favs.has(cols.id[i]);
    if (ok && filt.recent) ok = launchMs(i) >= recentCut;
    vis[i] = ok ? 1 : 0;
    if (ok) n++;
  }
  visibleCount = n;
  if (globe) globe.visAttr.needsUpdate = true;
  if (map) map.regroup();
  const c = $('counter');
  c.textContent = '';
  c.append('Showing ', h('b', { text: fmtInt(n) }), ` of ${fmtInt(N)} objects`);
  lastOverhead = 0;
}

function buildFilterUI() {
  const counts = {};
  for (let i = 0; i < N; i++) counts[catKey[i]] = (counts[catKey[i]] || 0) + 1;
  const list = $('cat-list');
  const order = Object.keys(CATEGORY_LABELS).filter((k) => counts[k]).sort((a, b) => counts[b] - counts[a]);
  list.replaceChildren(...order.map((k) => h('li', null,
    h('button', {
      type: 'button', 'aria-pressed': 'true', 'data-cat': k,
      onclick(e) {
        const on = filt.cats.has(k);
        if (on) filt.cats.delete(k); else filt.cats.add(k);
        e.currentTarget.setAttribute('aria-pressed', String(!on));
        applyFilters();
      },
    },
    h('span', { class: 'box', 'aria-hidden': 'true' }),
    h('span', { class: 'swatch', style: `background: var(--c-${k})` }),
    h('span', { class: 'lbl', text: CATEGORY_LABELS[k] }),
    h('span', { class: 'n', text: fmtInt(counts[k]) })))));
  const setAll = (on) => {
    filt.cats = new Set(on ? Object.keys(CATEGORY_LABELS) : []);
    for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', String(on));
    applyFilters();
  };
  $('cat-all').onclick = () => setAll(true);
  $('cat-none').onclick = () => setAll(false);

  const rc = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  for (let i = 0; i < N; i++) rc[tables.regime[cols.regime[i]]]++;
  $('regime-chips').replaceChildren(...Object.keys(rc).map((r) => h('button', {
    type: 'button', 'aria-pressed': 'true', title: REGIME_LABELS[r],
    onclick(e) {
      const on = filt.regimes.has(r);
      if (on) filt.regimes.delete(r); else filt.regimes.add(r);
      e.currentTarget.setAttribute('aria-pressed', String(!on));
      applyFilters();
    },
  }, r, h('span', { class: 'n', text: fmtInt(rc[r]) }))));

  const oc = new Map();
  for (let i = 0; i < N; i++) oc.set(cols.owner[i], (oc.get(cols.owner[i]) || 0) + 1);
  const owners = [...oc.entries()].sort((a, b) => b[1] - a[1]);
  const ownerSel = $('owner');
  for (const [idx, n] of owners) ownerSel.append(h('option', { value: tables.owner[idx], text: `${tables.ownerName[idx]} (${fmtInt(n)})` }));
  ownerSel.onchange = () => { filt.owner = ownerSel.value; applyFilters(); };
  $('only-favs').onchange = (e) => { filt.favs = e.target.checked; applyFilters(); };
  $('only-new').onchange = (e) => { filt.recent = e.target.checked; applyFilters(); };
}

// ------------------------------------------------------------------ tabs
const TABS = ['filters', 'selected', 'overhead', 'stats'];
function showTab(name) {
  for (const t of TABS) {
    $('tab-' + t).setAttribute('aria-selected', String(t === name));
    $('panel-' + t).hidden = t !== name;
  }
  if (name === 'overhead') lastOverhead = 0;
}
for (const t of TABS) $('tab-' + t).addEventListener('click', () => showTab(t));
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const cur = TABS.findIndex((t) => $('tab-' + t).getAttribute('aria-selected') === 'true');
  const next = TABS[(cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
  showTab(next); $('tab-' + next).focus();
});

// ------------------------------------------------------------------ selection
function computeOrbit(i, t) {
  const rec = sel.rec;
  const shape = orbitShape(cols.mm[i], cols.ecc[i]);
  const P = shape.period * 60000;
  const samples = 240;
  const eci = new Float32Array(3 * (samples + 1));
  const start = t - P / 2;
  let ok = 0;
  for (let k = 0; k <= samples; k++) {
    const pvv = propagateOne(sat, rec, new Date(start + (P * k) / samples));
    if (!pvv) continue;
    const p = pvv.position;
    eci[3 * ok] = p.x / R; eci[3 * ok + 1] = p.z / R; eci[3 * ok + 2] = -p.y / R;
    ok++;
  }
  // ground track: from a quarter period behind to one period ahead (max 12 h)
  const span = Math.min(P * 1.25, 12 * 3600000);
  const tStart = t - Math.min(P / 4, 3 * 3600000);
  const tn = 300;
  const trackScene = new Float32Array(3 * (tn + 1));
  const track = [];
  for (let k = 0; k <= tn; k++) {
    const e = ecfAt(sat, rec, new Date(tStart + (span * k) / tn));
    if (!e) continue;
    // geocentric direction, so the track sits exactly under the drawn dots
    const r = Math.sqrt(e.x * e.x + e.y * e.y + e.z * e.z);
    track.push([(Math.asin(e.z / r) * 180) / Math.PI, (Math.atan2(e.y, e.x) * 180) / Math.PI]);
    const j = 3 * (track.length - 1);
    trackScene[j] = (e.x / r) * 1.003;
    trackScene[j + 1] = (e.z / r) * 1.003;
    trackScene[j + 2] = (-e.y / r) * 1.003;
  }
  sel.track = track;
  sel.orbitT = t;
  sel.period = P;
  return { eciScene: eci.subarray(0, 3 * ok), trackScene: trackScene.subarray(0, 3 * track.length) };
}

function select(i, opts = {}) {
  if (i == null || i < 0) { deselect(); return; }
  const rec = satrecAt(sat, cols, i);
  sel = { i, rec, passes: null, passesKey: '' };
  const t = simNow();
  if (rec && globe) globe.setOrbit(computeOrbit(i, t));
  else if (rec) computeOrbit(i, t);
  renderSelected();
  if (opts.tab !== false) showTab('selected');
  $('btn-follow').hidden = false;
  try { location.replace('#sat-' + cols.id[i]); } catch { /* ignore */ }
  if (globe && view === 'globe' && opts.fly !== false && sched.pos(i, scratch)) {
    const v = toScene(scratch.x, scratch.y, scratch.z, new THREE.Vector3());
    globe.flyTo(v, v.length() > 1.6 ? v.length() * 1.7 : 0);
  }
}
function deselect() {
  sel = null;
  follow = false;
  $('btn-follow').setAttribute('aria-pressed', 'false');
  $('btn-follow').hidden = true;
  if (globe) globe.setOrbit(null);
  renderSelected();
  try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
}

const STAR = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 2.2l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/></svg>';
let liveCells = null;
function renderSelected() {
  const body = $('sel-body');
  const empty = $('sel-empty');
  if (!sel) { body.hidden = true; empty.hidden = false; liveCells = null; return; }
  empty.hidden = true; body.hidden = false;
  const i = sel.i;
  const k = catKey[i];
  const id = cols.id[i];
  const shape = orbitShape(cols.mm[i], cols.ecc[i]);
  const epochAge = Date.now() - cols.epoch[i];
  const ageClass = epochAge > 7 * DAY ? 'stale' : epochAge > 2 * DAY ? 'aging' : 'fresh';
  const favBtn = h('button', {
    type: 'button', class: 'icon-btn', 'aria-pressed': String(favs.has(id)),
    'aria-label': favs.has(id) ? 'Remove star' : 'Star this object', title: 'Star this object',
    onclick(e) {
      if (favs.has(id)) favs.delete(id); else favs.add(id);
      store.set('favs', [...favs]);
      e.currentTarget.setAttribute('aria-pressed', String(favs.has(id)));
      if (filt.favs) applyFilters();
    },
  });
  favBtn.innerHTML = STAR;
  const cell = (label) => {
    const v = h('div', { class: 'v', text: '—' });
    return [h('div', null, h('div', { class: 'k', text: label }), v), v];
  };
  const [cLat, vLat] = cell('Latitude');
  const [cLon, vLon] = cell('Longitude');
  const [cAlt, vAlt] = cell('Altitude');
  const [cSpd, vSpd] = cell('Speed');
  const [cSun, vSun] = cell('Lighting');
  const [cSky, vSky] = cell(observer ? `From ${observer.name}` : 'From your location');
  liveCells = { vLat, vLon, vAlt, vSpd, vSun, vSky };
  const launch = cols.launch[i] ? new Date(launchMs(i)) : null;
  const site = cols.site[i] >= 0 ? tables.siteName[cols.site[i]] : '—';
  const rcs = cols.rcs[i] >= 0 ? `${fmt(cols.rcs[i], 2)} m²` : '—';
  const regime = tables.regime[cols.regime[i]];

  const passesBox = h('div', { class: 'section', id: 'passes-box' });
  body.replaceChildren(
    h('div', { class: 'section' },
      h('div', { class: 'sel-head' },
        h('div', { class: 'nm', text: cols.name[i] }),
        favBtn,
        h('div', { class: 'ids' },
          h('span', null, 'NORAD ', h('b', { text: String(id) })),
          h('span', null, 'COSPAR ', h('b', { text: cols.cospar[i] || '—' })))),
      h('div', { class: 'quick' },
        h('span', { class: 'tag' }, h('span', { class: 'swatch', style: `background: var(--c-${k})` }), CATEGORY_LABELS[k]),
        h('span', { class: 'tag', title: REGIME_LABELS[regime], text: regime }),
        h('span', { class: 'tag', text: tables.status[cols.status[i]] }))),
    sel.rec ? h('div', { class: 'readout', 'aria-live': 'off' }, cLat, cLon, cAlt, cSpd, cSun, cSky)
      : h('p', { class: 'note warn', text: 'This element set could not be propagated, so no live position is available.' }),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => toggleFollow() }, 'Follow'),
      h('button', { type: 'button', class: 'btn', onclick: () => { showTab('overhead'); if (!observer) $('city').focus(); } }, observer ? 'Overhead list' : 'Set your location'),
      h('button', { type: 'button', class: 'btn', onclick: () => deselect() }, 'Clear')),
    h('div', { class: 'section' },
      h('h3', { text: 'Orbit' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Regime' }), h('dd', { text: `${regime} · ${REGIME_LABELS[regime]}` }),
        h('dt', { text: 'Period' }), h('dd', { class: 'mono', text: shape.period > 180 ? `${fmt(shape.period / 60, 2)} h` : `${fmt(shape.period, 1)} min` }),
        h('dt', { text: 'Inclination' }), h('dd', { class: 'mono', text: `${fmt(cols.inc[i], 2)}°` }),
        h('dt', { text: 'Perigee × apogee' }), h('dd', { class: 'mono', text: `${fmtInt(shape.perigee)} × ${fmtInt(shape.apogee)} km` }),
        h('dt', { text: 'Eccentricity' }), h('dd', { class: 'mono', text: cols.ecc[i].toFixed(5) }))),
    h('div', { class: 'section' },
      h('h3', { text: 'Catalog' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Owner' }), h('dd', { text: `${tables.ownerName[cols.owner[i]]}${tables.ownerName[cols.owner[i]] !== tables.owner[cols.owner[i]] ? ` (${tables.owner[cols.owner[i]]})` : ''}` }),
        h('dt', { text: 'Launched' }), h('dd', { text: launch ? `${launch.getUTCDate()} ${MONTHS[launch.getUTCMonth()]} ${launch.getUTCFullYear()}` : '—' }),
        h('dt', { text: 'Launch site' }), h('dd', { text: site }),
        h('dt', { text: 'Object type' }), h('dd', { text: tables.type[cols.type[i]] }),
        h('dt', { text: 'Radar cross-section' }), h('dd', { class: 'mono', text: rcs }))),
    h('div', { class: 'section' },
      h('h3', { text: 'Element set' }),
      h('dl', { class: 'facts' },
        h('dt', { text: 'Epoch' }), h('dd', { class: 'mono', text: utcStamp(cols.epoch[i]) }),
        h('dt', { text: 'Age' }), h('dd', null, h('span', { class: `chip ${ageClass}`, text: `${ago(epochAge)} old` }))),
      epochAge > 7 * DAY ? h('p', { class: 'note warn', text: 'This element set is more than a week old, so the position may be off by tens of kilometres or more.' }) : null),
    passesBox,
  );
  updatePasses(true);
  updateSelectedLive();
}

function updateSelectedLive() {
  if (!sel || !liveCells || !sel.rec) return;
  const t = simNow();
  const e = ecfAt(sat, sel.rec, new Date(t));
  if (!e) { liveCells.vLat.textContent = 'no position'; return; }
  const g = ecfToGeodetic(e.x, e.y, e.z);
  liveCells.vLat.textContent = `${fmt(Math.abs(g.lat), 3)}° ${g.lat >= 0 ? 'N' : 'S'}`;
  liveCells.vLon.textContent = `${fmt(Math.abs(g.lon), 3)}° ${g.lon >= 0 ? 'E' : 'W'}`;
  liveCells.vAlt.textContent = `${fmtInt(g.alt)} km`;
  const v = Math.hypot(e.vel.x, e.vel.y, e.vel.z);
  liveCells.vSpd.textContent = `${fmt(v, 2)} km/s`;
  const sun = sunDirectionEcf(t).eci;
  const sf = shadowFraction(sun, e.eci);
  liveCells.vSun.textContent = sf < 0.01 ? 'Sunlit' : sf > 0.99 ? "In Earth's shadow" : 'Partial shadow';
  if (observer) {
    const la = lookAngles(observer.o, e.x, e.y, e.z);
    liveCells.vSky.textContent = la.el >= 0 ? `El ${fmt(la.el, 1)}° · ${compass(la.az)}` : `Below horizon`;
  } else liveCells.vSky.textContent = 'Not set';
  // refresh the drawn orbit every so often (perturbations, time jumps)
  if (globe && sel.period && Math.abs(t - sel.orbitT) > Math.min(sel.period / 6, 20 * 60000)) globe.setOrbit(computeOrbit(sel.i, t));
  else if (!globe && sel.period && Math.abs(t - sel.orbitT) > Math.min(sel.period / 6, 20 * 60000)) computeOrbit(sel.i, t);
}

function updatePasses(force) {
  const box = $('passes-box');
  if (!box || !sel) return;
  if (!observer) {
    box.replaceChildren(h('h3', { text: 'Passes' }), h('p', { class: 'note', text: 'Set your location in the Overhead tab to see when this object passes over you.' }));
    return;
  }
  if (!sel.rec) { box.replaceChildren(); return; }
  const t = simNow();
  const key = `${observer.lat},${observer.lon}`;
  const stale = !sel.passes || sel.passesKey !== key || (sel.passes.length && t > sel.passes[0].los) || Math.abs(t - sel.passesT) > DAY;
  if (!stale && !force) return;
  if (stale) {
    const shape = orbitShape(cols.mm[sel.i], cols.ecc[sel.i]);
    const hours = shape.period > 600 ? 72 : 48;
    sel.passes = findPasses(sat, sel.rec, observer.o, t, hours, 6, 0);
    sel.passesKey = key;
    sel.passesT = t;
    sel.passesHours = hours;
  }
  const passes = sel.passes;
  const head = h('div', { class: 'row-head' }, h('h3', { text: `Passes over ${observer.name}` }), h('span', { class: 'note', text: tzLabel() }));
  if (!passes.length) {
    const e = ecfAt(sat, sel.rec, new Date(t));
    const el = e ? lookAngles(observer.o, e.x, e.y, e.z).el : -90;
    box.replaceChildren(head, h('p', { class: 'note', text: el > 0
      ? `Above your horizon the whole time (elevation about ${fmt(el, 0)}°), as geosynchronous objects are.`
      : `No passes in the next ${sel.passesHours} hours from this location.` }));
    return;
  }
  const rows = passes.map((p, k) => h('tr', { class: k === 0 ? 'next' : null },
    h('td', { text: localTime(p.aos, true) }),
    h('td', { text: `${fmt(p.maxEl, 0)}°` }),
    h('td', { text: localTime(p.los) }),
    h('td', { text: `${Math.max(1, Math.round((p.los - p.aos) / 60000))} min` }),
    h('td', { text: `${compass(p.aosAz)} → ${compass(p.losAz)}` })));
  box.replaceChildren(head,
    h('div', { class: 'table-wrap' }, h('table', { class: 'passes' },
      h('thead', null, h('tr', null, ...['Rises', 'Max', 'Sets', 'Length', 'Path'].map((x) => h('th', { text: x })))),
      h('tbody', null, rows))),
    h('h3', { text: 'Next pass, sky view' }),
    skyPlot(passes[0]),
    h('p', { class: 'note', text: 'Centre is straight overhead, the outer ring is the horizon. North is up.' }));
}
function tzLabel() {
  const off = -new Date().getTimezoneOffset();
  const sign = off >= 0 ? '+' : '−';
  return `times in UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
function skyPlot(p) {
  const svg = s('svg', { viewBox: '-112 -112 224 224', class: 'skyplot', role: 'img', 'aria-label': `Sky track of the next pass, maximum elevation ${Math.round(p.maxEl)} degrees` });
  const line = 'stroke: var(--line); fill: none; stroke-width: 1';
  for (const el of [0, 30, 60]) svg.append(s('circle', { cx: 0, cy: 0, r: 90 * (90 - el) / 90, style: line }));
  svg.append(s('line', { x1: -90, y1: 0, x2: 90, y2: 0, style: line }), s('line', { x1: 0, y1: -90, x2: 0, y2: 90, style: line }));
  for (const [lbl, x, y] of [['N', 0, -98], ['E', 100, 3], ['S', 0, 105], ['W', -100, 3]]) svg.append(s('text', { x, y, 'text-anchor': 'middle', text: lbl }));
  svg.append(s('text', { x: 3, y: -58, text: '30°' }), s('text', { x: 3, y: -28, text: '60°' }));
  const xy = (az, el) => { const r = 90 * (90 - el) / 90, a = (az * Math.PI) / 180; return [r * Math.sin(a), -r * Math.cos(a)]; };
  const d = p.track.map((q, k) => { const [x, y] = xy(q.az, q.el); return `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`; }).join(' ');
  svg.append(s('path', { d, style: 'stroke: var(--accent); stroke-width: 2.5; fill: none; stroke-linecap: round' }));
  if (p.track.length) {
    const [ax, ay] = xy(p.track[0].az, p.track[0].el);
    const last = p.track[p.track.length - 1];
    const [lx, ly] = xy(last.az, last.el);
    svg.append(s('circle', { cx: ax, cy: ay, r: 4, style: 'fill: var(--panel); stroke: var(--accent); stroke-width: 2' }));
    svg.append(s('circle', { cx: lx, cy: ly, r: 4, style: 'fill: var(--accent)' }));
    svg.append(s('text', { x: ax + 6, y: ay - 6, text: localTime(p.aos) }));
    svg.append(s('text', { x: lx + 6, y: ly - 6, text: localTime(p.los) }));
  }
  return svg;
}

function toggleFollow(force) {
  follow = force ?? !follow;
  $('btn-follow').setAttribute('aria-pressed', String(follow));
  if (follow && sel && view === 'map') setView('globe');
}
$('btn-follow').onclick = () => toggleFollow();

// ------------------------------------------------------------------ search
let results = [];
let active = -1;
function runSearch(q) {
  q = q.trim();
  const box = $('search-results');
  if (!q) { box.hidden = true; $('search-box').setAttribute('aria-expanded', 'false'); results = []; return; }
  const ql = q.toLowerCase();
  const out = [];
  if (/^\d+$/.test(q)) {
    for (let i = 0; i < N && out.length < 40; i++) if (String(cols.id[i]).startsWith(q)) out.push(i);
    out.sort((a, b) => String(cols.id[a]).length - String(cols.id[b]).length || cols.id[a] - cols.id[b]);
  } else if (/^\d{4}-/.test(q)) {
    const qu = q.toUpperCase();
    for (let i = 0; i < N && out.length < 40; i++) if (cols.cospar[i].startsWith(qu)) out.push(i);
  } else {
    const starts = [], contains = [];
    for (let i = 0; i < N; i++) {
      const p = searchIndex[i].indexOf(ql);
      if (p === 0) starts.push(i); else if (p > 0) contains.push(i);
    }
    // well-known objects first, then shorter (closer) names
    const boost = (i) => (BOOST.has(cols.id[i]) ? BOOST.get(cols.id[i]) : 99);
    const byLen = (a, b) => boost(a) - boost(b) || searchIndex[a].length - searchIndex[b].length || searchIndex[a].localeCompare(searchIndex[b]);
    starts.sort(byLen); contains.sort(byLen);
    out.push(...starts.slice(0, 40), ...contains.slice(0, Math.max(0, 40 - starts.length)));
  }
  results = out;
  active = out.length ? 0 : -1;
  box.replaceChildren(...(out.length ? out.map((i, k) => h('li', {
    role: 'option', id: 'res-' + k, 'aria-selected': String(k === active),
    onmousedown(e) { e.preventDefault(); choose(k); },
  },
  h('span', { class: 'swatch', style: `background: var(--c-${catKey[i]})` }),
  h('span', { class: 'nm', text: cols.name[i] }),
  h('span', { class: 'id', text: String(cols.id[i]) }))) : [h('li', { class: 'empty', text: `No objects match “${q}”.` })]));
  box.hidden = false;
  $('search-box').setAttribute('aria-expanded', 'true');
}
function choose(k) {
  const i = results[k];
  if (i == null) return;
  $('search').value = cols.name[i];
  $('search-results').hidden = true;
  $('search-box').setAttribute('aria-expanded', 'false');
  // make sure the object is visible even if filters hide it
  if (!vis[i]) {
    filt.cats.add(catKey[i]); filt.regimes.add(tables.regime[cols.regime[i]]);
    filt.owner = ''; filt.favs = false; filt.recent = false;
    $('owner').value = ''; $('only-favs').checked = false; $('only-new').checked = false;
    for (const b of document.querySelectorAll('#cat-list button')) b.setAttribute('aria-pressed', String(filt.cats.has(b.dataset.cat)));
    for (const b of document.querySelectorAll('#regime-chips button')) b.setAttribute('aria-pressed', String(filt.regimes.has(b.firstChild.textContent)));
    applyFilters();
  }
  select(i);
}
function wireSearch() {
  const input = $('search');
  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('focus', () => { if (input.value) runSearch(input.value); });
  input.addEventListener('blur', () => setTimeout(() => { $('search-results').hidden = true; $('search-box').setAttribute('aria-expanded', 'false'); }, 120));
  input.addEventListener('keydown', (e) => {
    const box = $('search-results');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      for (const [k, li] of [...box.children].entries()) li.setAttribute('aria-selected', String(k === active));
      box.children[active]?.scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', 'res-' + active);
    } else if (e.key === 'Enter') {
      if (active >= 0) { e.preventDefault(); choose(active); input.blur(); }
    } else if (e.key === 'Escape') {
      box.hidden = true; input.blur();
    }
  });
}

// ------------------------------------------------------------------ observer & overhead
function setObserver(lat, lon, name, save = true) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  observer = { lat, lon, name: name || `${fmt(Math.abs(lat), 2)}°${lat >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lon), 2)}°${lon >= 0 ? 'E' : 'W'}`, o: makeObserver(lat, lon) };
  if (save) store.set('observer', { lat, lon, name: observer.name });
  $('obs-lat').value = lat.toFixed(4);
  $('obs-lon').value = lon.toFixed(4);
  $('obs-clear').hidden = false;
  $('over-section').hidden = false;
  $('obs-note').textContent = `Showing the sky over ${observer.name}.`;
  if (globe) globe.setObserver(observer);
  lastOverhead = 0;
  if (sel) renderSelected();
}
function clearObserver() {
  observer = null;
  store.set('observer', null);
  $('obs-lat').value = ''; $('obs-lon').value = ''; $('city').value = '';
  $('obs-clear').hidden = true;
  $('over-section').hidden = true;
  $('obs-note').textContent = "Your browser location isn't available inside this page, so choose a city, type coordinates or pick a point.";
  if (globe) globe.setObserver(null);
  if (sel) renderSelected();
}
function setPicking(on) {
  picking = on;
  $('obs-pick').setAttribute('aria-pressed', String(on));
  const b = $('banner');
  b.hidden = !on;
  b.textContent = 'Click the globe or map to set your location. Press Esc to cancel.';
}
function wireObserver() {
  const city = $('city');
  for (const [name, lat, lon] of CITIES) city.append(h('option', { value: name, text: name }));
  city.onchange = () => {
    const c = CITIES.find((x) => x[0] === city.value);
    if (c) setObserver(c[1], c[2], c[0]);
  };
  const fromInputs = () => {
    const lat = parseFloat($('obs-lat').value), lon = parseFloat($('obs-lon').value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { city.value = ''; setObserver(lat, lon); }
  };
  $('obs-lat').addEventListener('change', fromInputs);
  $('obs-lon').addEventListener('change', fromInputs);
  $('obs-pick').onclick = () => setPicking(!picking);
  $('obs-clear').onclick = clearObserver;
  const saved = store.get('observer', null);
  if (saved && Number.isFinite(saved.lat)) {
    setObserver(saved.lat, saved.lon, saved.name, false);
    const c = CITIES.find((x) => x[0] === saved.name);
    if (c) city.value = c[0];
  }
}
let lastOverhead = 0;
function updateOverhead() {
  if (!observer || $('panel-overhead').hidden || !sched.a) return;
  const now = performance.now();
  if (now - lastOverhead < 2000) return;
  lastOverhead = now;
  const la = {};
  const found = [];
  for (let i = 0; i < N; i++) {
    if (!vis[i] || !sched.pos(i, scratch)) continue;
    lookAngles(observer.o, scratch.x, scratch.y, scratch.z, la);
    if (la.el >= 10) found.push([i, la.el, la.az, la.range]);
  }
  found.sort((a, b) => b[1] - a[1]);
  $('over-title').textContent = `Above ${observer.name} · ${fmtInt(found.length)}`;
  $('over-time').textContent = utcStamp(simNow()).slice(-12);
  $('over-list').replaceChildren(...found.slice(0, 60).map(([i, el, az, range]) => h('li', null, h('button', { type: 'button', onclick: () => select(i) },
    h('span', { class: 'swatch', style: `background: var(--c-${catKey[i]})` }),
    h('span', { class: 'nm', text: cols.name[i] }),
    h('span', { class: 'v el', text: `${fmt(el, 0)}°` }),
    h('span', { class: 'v', text: `${compass(az)} · ${fmtInt(range)} km` })))));
  if (!found.length) $('over-list').replaceChildren(h('li', { class: 'note', text: 'Nothing that matches your filters is more than 10° above the horizon right now.' }));
}

// ------------------------------------------------------------------ stats
function buildStats() {
  const rc = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  for (let i = 0; i < N; i++) rc[tables.regime[cols.regime[i]]]++;
  $('regime-tiles').replaceChildren(...Object.entries(rc).map(([r, n]) => h('div', { title: REGIME_LABELS[r] },
    h('div', { class: 'k', text: r }), h('div', { class: 'v', text: fmtInt(n) }), h('div', { class: 's', text: `${fmt((100 * n) / N, 1)}%` }))));
  const bars = (el, entries, colorOf) => {
    const max = Math.max(...entries.map((e) => e[1]));
    el.replaceChildren(...entries.map(([lbl, n, key]) => h('li', null,
      h('span', { class: 'lbl', text: lbl, title: lbl }),
      h('span', { class: 'track' }, h('span', { class: 'fill', style: `width: ${Math.max(1, (100 * n) / max)}%; ${colorOf ? `background: ${colorOf(key)}` : ''}` })),
      h('span', { class: 'n', text: fmtInt(n) }))));
  };
  const cc = {};
  for (let i = 0; i < N; i++) cc[catKey[i]] = (cc[catKey[i]] || 0) + 1;
  bars($('cat-bars'), Object.entries(cc).sort((a, b) => b[1] - a[1]).map(([k, n]) => [CATEGORY_LABELS[k], n, k]), (k) => `var(--c-${k})`);
  const oc = new Map();
  for (let i = 0; i < N; i++) oc.set(cols.owner[i], (oc.get(cols.owner[i]) || 0) + 1);
  bars($('owner-bars'), [...oc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([idx, n]) => [tables.ownerName[idx], n]));

  // launch-year histogram
  const years = new Map();
  let minY = 9999, maxY = 0;
  for (let i = 0; i < N; i++) {
    const y = Math.floor(cols.launch[i] / 10000);
    if (!y) continue;
    years.set(y, (years.get(y) || 0) + 1);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const from = Math.max(minY, maxY - 29);
  const older = [...years.entries()].filter(([y]) => y < from).reduce((a, [, n]) => a + n, 0);
  const data = [];
  for (let y = from; y <= maxY; y++) data.push([y, years.get(y) || 0]);
  const svg = $('year-hist');
  const W = 340, H = 150, left = 34, bottom = 18, top = 8;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.replaceChildren();
  const max = Math.max(...data.map((d) => d[1]));
  const niceMax = Math.ceil(max / 1000) * 1000 || 10;
  const y = (v) => top + (H - top - bottom) * (1 - v / niceMax);
  const bw = (W - left - 4) / data.length;
  for (const v of [0, niceMax / 2, niceMax]) {
    svg.append(s('line', { x1: left, x2: W - 2, y1: y(v), y2: y(v), style: 'stroke: var(--line); stroke-width: 1' }));
    svg.append(s('text', { x: left - 4, y: y(v) + 3, 'text-anchor': 'end', text: fmtInt(v) }));
  }
  data.forEach(([yr, n], k) => {
    const bar = s('rect', { x: left + k * bw + 1, y: y(n), width: Math.max(1, bw - 2), height: Math.max(0, y(0) - y(n)), style: `fill: ${yr === maxY ? 'var(--accent)' : 'var(--muted)'}` });
    bar.append(s('title', { text: `${yr}: ${fmtInt(n)} active objects` }));
    svg.append(bar);
    if (yr % 5 === 0 || yr === maxY) svg.append(s('text', { x: left + k * bw + bw / 2, y: H - 5, 'text-anchor': 'middle', text: String(yr) }));
  });
  if (older) svg.append(s('text', { x: left + 4, y: top + 10, text: `+ ${fmtInt(older)} launched before ${from}` }));

  const fetched = new Date(catalog.fetchedAt).getTime();
  const [eMin, eMed] = catalog.epochRange;
  $('about').replaceChildren(
    h('p', null, `Orbital elements for ${fmtInt(N)} active objects were downloaded from CelesTrak on ${utcStamp(fetched)}. Half of the element sets were measured within ${ago(fetched - eMed)} of that; the oldest is from ${utcStamp(eMin).slice(0, -13)}.`),
    h('p', null, 'Each position is computed in your browser with the SGP4 model, the same method used by public tracking sites. Expect about a kilometre of error near an element set’s epoch, growing by a few kilometres a day. Satellites that manoeuvre often, such as Starlink, drift faster.'),
    h('p', null, 'The catalog covers objects the US Space Force publishes. Classified satellites are not included. Categories come from CelesTrak’s groups and object names, so a few objects may be in the wrong group.'),
    h('p', null, 'Orbital data: ', h('a', { href: 'https://celestrak.org', target: '_blank', rel: 'noopener', text: 'CelesTrak' }), ' (GP data and SATCAT). Borders: Natural Earth. Orbit maths: satellite.js. Rendering: three.js.'),
    h('p', { id: 'engine-note' }, `Positions are computed ${sched.provider?.kind === 'worker' ? 'in a background worker' : 'on the page’s main thread'}.`),
  );
}

// ------------------------------------------------------------------ time UI
const pauseIcon = $('icon-pause'), playIcon = $('icon-play');
let scrubbing = false;
function updateTimeUI(force) {
  const t = simNow();
  $('clock').textContent = utcStamp(t).replace(/^\d+ \w+ \d+ /, (m) => (window.innerWidth < 520 ? '' : m));
  $('clock').title = utcStamp(t);
  const off = t - Date.now();
  $('offset').textContent = offsetLabel(off);
  if (!scrubbing) $('scrub').value = String(Math.max(-2880, Math.min(2880, Math.round(off / 60000))));
  const chip = $('mode-chip');
  const live = isLive();
  chip.className = 'chip ' + (live ? 'live' : time.paused ? 'paused' : 'sim');
  $('mode-text').textContent = live ? 'Live' : time.paused ? 'Paused' : time.speed === 1 ? 'Replay' : `${time.speed}×`;
  $('btn-live').setAttribute('aria-pressed', String(live));
  pauseIcon.hidden = time.paused; playIcon.hidden = !time.paused;
  $('btn-play').setAttribute('aria-label', time.paused ? 'Play' : 'Pause');
  if (force) $('speed').value = String(time.speed);
}
function updateDataChip() {
  if (!catalog) return;
  const age = Date.now() - new Date(catalog.fetchedAt).getTime();
  const chip = $('data-chip');
  chip.className = 'chip data ' + (age > 3 * DAY ? 'stale' : age > DAY ? 'aging' : 'fresh');
  chip.textContent = `Data ${ago(age)} old`;
  chip.title = `Orbital data downloaded ${utcStamp(new Date(catalog.fetchedAt).getTime())}`;
}
function wireTime() {
  $('btn-play').onclick = () => { const t = simNow(); setSim(t, { paused: !time.paused }); };
  $('btn-back').onclick = () => setSim(simNow() - 3600000);
  $('btn-fwd').onclick = () => setSim(simNow() + 3600000);
  $('btn-live').onclick = () => setSim(Date.now(), { speed: 1, paused: false });
  $('speed').onchange = (e) => setSim(simNow(), { speed: Number(e.target.value), paused: false });
  const scrub = $('scrub');
  scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  scrub.addEventListener('input', () => { scrubbing = true; setSim(Date.now() + Number(scrub.value) * 60000); });
  scrub.addEventListener('change', () => { scrubbing = false; });
  window.addEventListener('pointerup', () => { scrubbing = false; });
}

// ------------------------------------------------------------------ views & pointer
function setView(v) {
  if (v === 'globe' && !globe) v = 'map';
  view = v;
  store.set('view', v);
  $('view-globe').setAttribute('aria-pressed', String(v === 'globe'));
  $('view-map').setAttribute('aria-pressed', String(v === 'map'));
  $('globe').hidden = v !== 'globe';
  $('map').hidden = v !== 'map';
  $('btn-home').hidden = v !== 'globe';
  if (v === 'map' && map) { map.regroup(); requestAnimationFrame(() => map.draw(simNow(), true)); }
}
function wirePointer(canvasEl, getRenderer) {
  let down = null;
  let lastMove = 0;
  canvasEl.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; if (follow && view === 'globe') toggleFollow(false); });
  canvasEl.addEventListener('pointerup', (e) => {
    if (!down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 6 || !quick) return;
    const r = getRenderer();
    if (picking) {
      const g = r.groundAt(e.clientX, e.clientY);
      if (g) { $('city').value = ''; setObserver(g.lat, g.lon); setPicking(false); showTab('overhead'); }
      return;
    }
    const i = r.pick(e.clientX, e.clientY, e.pointerType === 'touch' ? 22 : 12);
    if (i >= 0) select(i, { fly: false }); else if (sel) deselect();
  });
  canvasEl.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || down) return;
    const now = performance.now();
    if (now - lastMove < 60) return;
    lastMove = now;
    const r = getRenderer();
    const i = picking ? -1 : r.pick(e.clientX, e.clientY, 10);
    const tip = $('tip');
    canvasEl.style.cursor = picking ? 'crosshair' : i >= 0 ? 'pointer' : 'grab';
    if (i < 0) { tip.hidden = true; return; }
    const rect = $('stage').getBoundingClientRect();
    tip.replaceChildren(document.createTextNode(cols.name[i]), h('span', { class: 'id', text: String(cols.id[i]) }));
    tip.style.left = `${e.clientX - rect.left}px`;
    tip.style.top = `${e.clientY - rect.top}px`;
    tip.hidden = false;
  });
  canvasEl.addEventListener('pointerleave', () => { $('tip').hidden = true; });
}

// ------------------------------------------------------------------ loading UI
function loading(step, detail, pct) {
  $('load-step').textContent = step;
  $('load-detail').textContent = detail;
  $('load-bar').style.width = `${pct}%`;
}
function loadingError(step, detail) {
  $('loading').classList.add('error');
  loading(step, detail, 100);
  $('counter').textContent = 'No data';
}

// ------------------------------------------------------------------ main loop
let lastUi = 0, lastSel = 0, lastChip = 0;
function frame() {
  requestAnimationFrame(frame);
  const t = simNow();
  sched.update(t);
  if (sched.a) {
    if (view === 'globe' && globe) globe.render(t);
    else if (map) map.draw(t);
  }
  const now = performance.now();
  if (now - lastUi > 250) { lastUi = now; updateTimeUI(); }
  if (now - lastSel > 500) { lastSel = now; updateSelectedLive(); if (sel) updatePasses(false); }
  if (now - lastChip > 60000) { lastChip = now; updateDataChip(); }
  updateOverhead();
}

function applyHash() {
  const m = location.hash.match(/^#sat-(\d+)$/);
  if (!m) return;
  const i = cols.id.indexOf(Number(m[1]));
  if (i >= 0 && (!sel || sel.i !== i)) select(i);
}

function onThemeChange() {
  tokens = readTokens();
  if (globe) globe.applyTheme();
  if (map) { map.applyTheme(); map.draw(simNow(), true); }
}

async function boot() {
  updateTimeUI(true);
  wireTime();
  wireSearch();
  loading('Loading catalog', 'Fetching the latest element sets', 12);
  let res;
  try {
    res = await fetch('data/catalog.json');
    if (!res.ok) throw new Error(res.status);
    catalog = await res.json();
  } catch (e) {
    console.error(e);
    loadingError("Couldn't load the satellite catalog", 'Reload the page to try again.');
    return;
  }
  cols = catalog.cols; tables = catalog.tables; N = catalog.count;
  catKey = cols.cat.map((c) => tables.cat[c]);
  searchIndex = cols.name.map((n) => n.toLowerCase());
  vis = new Float32Array(N).fill(1);
  updateDataChip();
  $('brand-sub').textContent = `${fmtInt(N)} active objects · SGP4`;
  const worldP = fetch('data/world.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);

  loading('Preparing orbits', `Initialising ${fmtInt(N)} SGP4 models`, 40);
  sched = new Scheduler();
  const onSnap = (k, t, b) => sched.onSnap(k, t, b);
  try {
    sched.provider = await workerProvider(onSnap);
  } catch (e) {
    console.warn('Falling back to main-thread propagation:', e.message);
    sched.provider = await mainThreadProvider(onSnap);
  }

  try { globe = createGlobe($('globe')); } catch (e) { console.warn('WebGL unavailable', e); globe = null; }
  if (!globe) {
    $('view-globe').disabled = true;
    $('view-globe').title = 'The 3D globe needs WebGL, which this browser has turned off.';
    view = 'map';
  }
  map = createMap($('map'));
  buildFilterUI();
  applyFilters();
  wireObserver();
  setView(view);
  if (globe) {
    globe.applyTheme();
    globe.lookAtLatLon(22, observer ? observer.lon : -40);
  }
  wirePointer($('globe'), () => globe);
  wirePointer($('map'), () => map);
  $('view-globe').onclick = () => setView('globe');
  $('view-map').onclick = () => setView('map');
  $('btn-home').onclick = () => { toggleFollow(false); globe && globe.lookAtLatLon(22, observer ? observer.lon : -40); };

  const quick = $('quick-picks');
  for (const id of QUICK_PICKS) {
    const i = cols.id.indexOf(id);
    if (i >= 0) quick.append(h('button', { type: 'button', onclick: () => select(i) }, h('span', { class: 'swatch', style: `background: var(--c-${catKey[i]})` }), ' ', cols.name[i]));
  }

  loading('Computing positions', 'Propagating every orbit to the current time', 75);
  const t0 = performance.now();
  while (!sched.a && performance.now() - t0 < 20000) {
    sched.update(simNow());
    await new Promise((r) => setTimeout(r, 30));
  }
  $('loading').hidden = true;
  requestAnimationFrame(frame);
  buildStats();
  applyHash();
  window.addEventListener('hashchange', applyHash);

  world = await worldP;
  if (world) onThemeChange();

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onThemeChange);
  new MutationObserver(onThemeChange).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'Escape') { if (picking) setPicking(false); else if (sel && !typing) deselect(); }
    else if (e.key === ' ' && !typing && tag !== 'button') { e.preventDefault(); $('btn-play').click(); }
  });
}

boot();
