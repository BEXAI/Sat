// propagate.worker.js: runs SGP4 for the whole catalog off the main thread.
//
// Protocol
//   main -> worker  {type: 'init', cols}            numeric orbital-element columns
//   worker -> main  {type: 'ready', count, failed}
//   main -> worker  {type: 'prop', key, time}       time in ms since 1970 (UTC)
//   worker -> main  {type: 'pos', key, time, buf}   Float32Array of ECF km (x, y, z per object; 0 = unknown)
import { json2satrec } from 'satellite.js/dist/io.js';
import { propagate, gstime } from 'satellite.js/dist/propagation.js';
import { buildSatrecs, propagateRange } from './orbit-core.js';

const sat = { json2satrec, propagate, gstime };
let satrecs = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    satrecs = buildSatrecs(sat, msg.cols);
    let failed = 0;
    for (const r of satrecs) if (!r) failed++;
    self.postMessage({ type: 'ready', count: satrecs.length, failed });
  } else if (msg.type === 'prop' && satrecs) {
    const buf = new Float32Array(satrecs.length * 3);
    propagateRange(sat, satrecs, new Date(msg.time), buf, 0, satrecs.length, 0);
    self.postMessage({ type: 'pos', key: msg.key, time: msg.time, buf }, [buf.buffer]);
  }
};

self.postMessage({ type: 'loaded' });
