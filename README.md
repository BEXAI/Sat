# Orbitwatch

A live tracker for every publicly catalogued active satellite (about 17,000 objects),
published as a Claude artifact:

**https://claude.ai/artifact/1a2uYoYTueUGGG9me11esF** (private until you share it from the page's Share menu)

Positions are computed in the viewer's browser with SGP4 from CelesTrak's orbital
element sets. The page includes a 3D globe and a 2D map, search, filters, a details panel,
the orbit and ground track, an overhead list and pass predictions for any location,
time travel (±48 h, up to 900×) and catalog statistics.

See [plan.md](plan.md) for the full plan and progress log.

## How it fits together

```
CelesTrak ──► scripts/fetch_catalog.py ──► data-raw/ (not committed)
                                             │
              scripts/build_data.py  ◄───────┘
                     │
                     ▼
              site/data/catalog.json, world.json   (committed snapshot)
                     │
site/*.html|css|js ──┴─► scripts/build_site.mjs ──► dist/ ──► published artifact
```

| Path | What it is |
|---|---|
| `site/index.html`, `site/styles.css`, `site/app.js` | The page (inlined into one HTML file at build time) |
| `site/orbit-core.js` | Orbit maths shared by the page, the worker and the checks |
| `site/propagate.worker.js` | Web Worker that runs SGP4 for the whole catalog |
| `site/data/` | Latest data snapshot the page loads |
| `scripts/fetch_catalog.py` | Downloads CelesTrak data (at most once every 2 hours) |
| `scripts/build_data.py` | Builds the compact catalog and map files |
| `scripts/verify_catalog.mjs` | Checks every orbit propagates and positions look right |
| `scripts/reference_positions.py` | Optional independent SGP4 cross-check (needs `pip install sgp4`) |
| `scripts/build_site.mjs` | Builds `dist/` for publishing |
| `scripts/smoke_test.mjs` | Loads `dist/` in headless Chromium and takes screenshots |

## Refreshing the data

The page shows how old its data is. To refresh it, open a Claude Code session on this
repository and ask:

> Refresh the Orbitwatch satellite data, run the checks, and republish it to
> https://claude.ai/artifact/1a2uYoYTueUGGG9me11esF

Claude runs the steps below and republishes to the same link. The cloud environment
must allow `celestrak.org` (already added to this environment's allowed hosts).

The same steps by hand, from the repository folder:

```bash
cd ~/Sat
npm ci
python3 -I scripts/fetch_catalog.py
npm run build
node scripts/smoke_test.mjs
```

`npm run build` rebuilds the data files, verifies them and builds `dist/`.
Publishing `dist/` as the artifact is done by Claude with its Artifact tool.

## Credits

Orbital data: [CelesTrak](https://celestrak.org) (GP data and SATCAT). Borders: Natural Earth
via world-atlas. Orbit maths: satellite.js. Rendering: three.js.
