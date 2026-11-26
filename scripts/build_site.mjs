// Build the publishable artifact into dist/.
//
//   dist/index.html            page with styles.css and the bundled app inlined
//   dist/propagate.worker.js   SGP4 worker (orbit-core bundled in)
//   dist/data/*.json           catalog and world outlines
//
// Page: libraries are NOT bundled. Imports of `three` and `satellite.js/...` are
// rewritten to exact-version jsDelivr URLs (versions read from node_modules), because
// the artifact sandbox only loads page scripts from a few CDNs. Small three.js add-ons
// (OrbitControls) are bundled so they share the CDN copy of three.
//
// Worker: satellite.js IS bundled into propagate.worker.js. Imports inside a module
// worker are governed by the sandbox's worker-src policy, which allows only the
// artifact's own files (and blob:), so a CDN import there is blocked.
//
// Usage (from the repo root):  node scripts/build_site.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const dist = path.join(root, 'dist');
const version = (name) => JSON.parse(readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

export const CDN = {
  three: `https://cdn.jsdelivr.net/npm/three@${version('three')}/build/three.module.js`,
  satellite: `https://cdn.jsdelivr.net/npm/satellite.js@${version('satellite.js')}/`,
};

const cdnPlugin = {
  name: 'cdn-externals',
  setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: CDN.three, external: true }));
    b.onResolve({ filter: /^satellite\.js\// }, (a) => ({ path: CDN.satellite + a.path.slice('satellite.js/'.length), external: true }));
  },
};

const localSatellitePlugin = {
  name: 'local-satellite',
  setup(b) {
    b.onResolve({ filter: /^satellite\.js\// }, (a) => ({ path: path.join(root, 'node_modules', a.path) }));
  },
};

async function bundle(entry, plugins) {
  const out = await build({
    entryPoints: [path.join(site, entry)],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    plugins,
    legalComments: 'inline',
    logLevel: 'warning',
  });
  return out.outputFiles[0].text;
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, 'data'), { recursive: true });

const app = await bundle('app.js', [cdnPlugin]);
const worker = await bundle('propagate.worker.js', [localSatellitePlugin]);
if (/from\s*["']https?:/.test(worker)) throw new Error('worker must not import from a CDN');
const css = readFileSync(path.join(site, 'styles.css'), 'utf8');
let html = readFileSync(path.join(site, 'index.html'), 'utf8');
if (!html.includes('/* @inline:styles */') || !html.includes('/* @inline:app */')) throw new Error('index.html is missing an @inline marker');
html = html
  .replace('/* @inline:styles */', () => css.replace(/<\/style/gi, '<\\/style'))
  .replace('/* @inline:app */', () => app.replace(/<\/script/gi, '<\\/script'));

writeFileSync(path.join(dist, 'index.html'), html);
writeFileSync(path.join(dist, 'propagate.worker.js'), worker);
for (const f of readdirSync(path.join(site, 'data'))) {
  if (f.endsWith('.json')) copyFileSync(path.join(site, 'data', f), path.join(dist, 'data', f));
}

const kb = (p) => `${(statSync(path.join(dist, p)).size / 1024).toFixed(0)} KB`;
console.log(`dist/index.html ${kb('index.html')} · propagate.worker.js ${kb('propagate.worker.js')} · data/catalog.json ${kb('data/catalog.json')} · data/world.json ${kb('data/world.json')}`);
console.log(`page CDN imports: ${CDN.three}\n                  ${CDN.satellite}dist/*.js (worker bundles satellite.js ${version('satellite.js')})`);
