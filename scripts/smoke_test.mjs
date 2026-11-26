// Local smoke test of dist/ in headless Chromium (Playwright is pre-installed in
// Claude Code cloud sessions; elsewhere run `npm i -g playwright` first).
//
// It wraps dist/index.html the way claude.ai does (doctype + head skeleton) and adds a
// Content-Security-Policy like the artifact sandbox's, serves dist/ locally, and
// answers jsDelivr requests from node_modules so it works offline.
//
// Usage (from the repo root, after `node scripts/build_site.mjs`):
//   node scripts/smoke_test.mjs            -> screenshots + report in test-output/
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'test-output');
mkdirSync(out, { recursive: true });

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://code.jquery.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
].join('; ');
const skeleton = (body) => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${CSP}"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${body}</body></html>`;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(dist, rel);
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  let body = readFileSync(file);
  if (rel === 'index.html') body = skeleton(body.toString());
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const report = [];
const log = (...a) => { const line = a.join(' '); report.push(line); console.log(line); };

async function newPage(browser, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await ctx.route(/^https:\/\/cdn\.jsdelivr\.net\/npm\/([^@]+)@([^/]+)\/(.*)$/, (route) => {
    const [, name, , p] = route.request().url().match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/([^@]+)@([^/]+)\/(.*)$/);
    const file = path.join(root, 'node_modules', name, p);
    if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(file) });
  });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  return { ctx, page, errors };
}

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // ---- desktop, light
  const d = await newPage(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light' });
  const t0 = Date.now();
  await d.page.goto(base);
  await d.page.waitForSelector('#loading', { state: 'hidden', timeout: 90000 });
  log(`desktop: live after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await d.page.waitForTimeout(2500);
  log('counter:', await d.page.textContent('#counter'));
  log('engine:', await d.page.evaluate(() => document.getElementById('engine-note')?.textContent));
  log('data chip:', await d.page.textContent('#data-chip'));
  await d.page.screenshot({ path: path.join(out, 'desktop-light.png') });

  await d.page.fill('#search', 'ISS');
  await d.page.waitForTimeout(200);
  log('search "ISS" first result:', await d.page.textContent('#search-results li:first-child .nm'));
  await d.page.press('#search', 'Enter');
  await d.page.waitForTimeout(1500);
  log('selected:', await d.page.textContent('.sel-head .nm'), '| hash:', await d.page.evaluate(() => location.hash));
  log('readout:', (await d.page.$$eval('.readout .v', (els) => els.map((e) => e.textContent))).join(' | '));
  await d.page.click('#tab-overhead');
  await d.page.selectOption('#city', 'London');
  await d.page.waitForTimeout(2500);
  log('overhead:', await d.page.textContent('#over-title'), '| rows:', await d.page.$$eval('#over-list li', (l) => l.length));
  await d.page.click('#tab-selected');
  await d.page.waitForTimeout(800);
  log('passes rows:', await d.page.$$eval('.passes tbody tr', (l) => l.length), '| first:', await d.page.$$eval('.passes tbody tr:first-child td', (t) => t.map((x) => x.textContent).join(' ')));
  await d.page.screenshot({ path: path.join(out, 'desktop-selected.png') });
  await d.page.click('#view-map');
  await d.page.click('#speed');
  await d.page.selectOption('#speed', '300');
  await d.page.waitForTimeout(2000);
  log('mode chip at 300x:', await d.page.textContent('#mode-chip'));
  await d.page.screenshot({ path: path.join(out, 'desktop-map.png') });
  await d.page.click('#tab-stats');
  await d.page.waitForTimeout(300);
  await d.page.screenshot({ path: path.join(out, 'desktop-stats.png') });
  log('desktop console:', d.errors.length ? '\n  ' + d.errors.join('\n  ') : 'clean');
  await d.ctx.close();

  // ---- phone, dark
  const m = await newPage(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', isMobile: true, hasTouch: true });
  await m.page.goto(base + '#sat-25544');
  await m.page.waitForSelector('#loading', { state: 'hidden', timeout: 90000 });
  await m.page.waitForTimeout(2500);
  const overflow = await m.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  log(`phone: horizontal overflow ${overflow}px · selected from hash: ${await m.page.textContent('.sel-head .nm').catch(() => 'none')}`);
  await m.page.screenshot({ path: path.join(out, 'phone-dark.png') });
  log('phone console:', m.errors.length ? '\n  ' + m.errors.join('\n  ') : 'clean');
  await m.ctx.close();
} finally {
  await browser.close();
  server.close();
  writeFileSync(path.join(out, 'smoke-report.txt'), report.join('\n') + '\n');
}
