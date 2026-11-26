# Plan: Live Global Satellite Tracker (Claude Artifact)

> Status: **planning only, no code yet.**
> Repo: `bexai/sat` · Branch: `claude/determined-fermi-04jpsw`
> Working title: **Orbitwatch** (placeholder, see Open Questions)
> Plan date: 2026-11-26

---

## 1. Goal

Build a website, published as a **Claude artifact** (a private-by-default page hosted on claude.ai that you can share), that **really tracks every publicly catalogued satellite in real time**. It should:

- Show every active satellite (and optionally debris and rocket bodies) moving live on a 3D globe and a 2D map.
- Compute each position in the browser from **real orbital data** (NORAD General Perturbations element sets) using the **SGP4** orbit model. That's the same method professional trackers use.
- Let anyone search, filter, click a satellite to see details, see its orbit and ground track, and see what's overhead at a chosen location.
- Refresh its orbital data on a schedule, so it doesn't drift away from reality.

### What "actually track" means

There's no live GPS feed from satellites. Every public tracker works the same way:

1. The US Space Force (18th/19th Space Defense Squadron) tracks objects with radar and optical sensors and publishes **element sets** (TLE / OMM). Each set is a snapshot of one orbit at a moment in time (the "epoch").
2. **CelesTrak** republishes these sets freely, updated several times a day.
3. The **SGP4** algorithm projects each element set forward to *now*, giving latitude, longitude, altitude and velocity.

Expected accuracy: about 1 km near the epoch, getting worse by roughly 1 to 3 km per day for typical LEO objects. It's faster for low, high-drag or maneuvering satellites (Starlink in particular), because their actual orbits move away from the published set. **So the data needs to be refreshed at least daily**, and the UI should show how old the data is.

### Honest scope limits (shown on the site's About panel)

- "All global satellites" means **all objects in the public catalog**. That's roughly 12,000 to 16,000 active payloads and 30,000+ tracked objects when debris is included. The real numbers are counted at build time.
- Classified objects the US doesn't publish won't appear.
- Positions are predictions from the latest element set, not live telemetry.

---

## 2. Constraints of a Claude artifact (these drive the design)

| Constraint | Impact on the design |
|---|---|
| The page is one HTML file plus optional **supporting files** (JS, JSON, images). Limit is 16 MB per text file and 15 MB per binary file. | Orbital data ships as supporting JSON files that the page loads. Keep each file well under the limit. |
| External **scripts** can load only from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm/`, `unpkg.com`, `cdn.tailwindcss.com` or `code.jquery.com`, and **must pin an exact version at least 2 weeks old**. | Libraries load from jsdelivr using exact versions (section 4). |
| Stylesheets can load only from Google Fonts. Everything else is inline or a supporting file. | Earth textures and country outlines ship as supporting files, not hot-linked from NASA etc. |
| **Runtime network calls to arbitrary sites (e.g. celestrak.org) are probably blocked** inside the artifact sandbox. | Data is fetched **outside** the page by Claude Code, bundled as supporting files, and republished to the same URL. A direct live fetch is a progressive enhancement, tested in Phase 0. |
| Browser storage is per viewer and can be unavailable. | Use it only for conveniences (favorites, last view, observer location), wrap every access in try/catch, and make sure the page works without it. |
| The design contract needs light/dark theme tokens on `:root`, an explicit `body` background, phone-width layout with a 16px gutter and no horizontal scroll, and a 2 to 4 word `<title>`. | Built in from Phase 2, not added at the end. |
| Optional runtime **capabilities** are available: `sample` (ask Claude), `downloads`, `db`, `user` and others. | Optional extras only (section 7.8). The core tracker needs no capabilities. |

### Environment finding (from this planning session)

- This cloud container's network proxy **blocks `celestrak.org`** (HTTP 403 at the proxy). Before Phase 1 we have to **add `celestrak.org` to this environment's allowed hosts** (Claude proposes it, you approve with one click). npm and package registries already work.

---

## 3. Data sources

| Source | What we use | Access | Notes |
|---|---|---|---|
| **CelesTrak GP data** (`celestrak.org/NORAD/elements/gp.php`) | Orbital elements for `GROUP=active`, plus named groups for categories (starlink, oneweb, gps-ops, glo-ops, galileo, beidou, geo, weather, stations, science, etc.) | Free, no login | Use the **OMM JSON or CSV format, not legacy TLE**: catalog numbers above 99999 don't fit in TLE. Respect their usage policy: don't re-download unchanged data, at most about every 2 hours, one request per group. |
| **CelesTrak SATCAT** | Metadata: owner/country, launch date, launch site, object type (payload/rocket body/debris), RCS size, decay status | Free | Joined by NORAD catalog number. |
| **CelesTrak debris groups** (optional layer) | e.g. `cosmos-1408-debris`, `fengyun-1c-debris`, `iridium-33-debris`, or the full catalog | Free | Could double the object count, so it's lazy-loaded behind a toggle. |
| Space-Track.org | Not used | Login required | Its user agreement limits redistribution, so we stick with CelesTrak. |
| **Earth imagery**: NASA Blue Marble | 2K or 4K equirectangular texture | Public domain | Compressed JPG/WebP, about 1 to 2 MB, bundled. |
| **Country outlines**: Natural Earth via `world-atlas` 110m TopoJSON | 2D map and globe borders | Public domain | About 100 KB, bundled. |

Attribution footer: "Orbital data: CelesTrak · Imagery: NASA · Borders: Natural Earth". No official agency logos and no imitation of any existing tracker's branding.

---

## 4. Tech stack (exact pins, all at least 2 weeks old as of plan date)

| Purpose | Library | Version | Load from |
|---|---|---|---|
| SGP4 propagation | `satellite.js` | **7.1.0** (released 2026-07-23) | `https://cdn.jsdelivr.net/npm/satellite.js@7.1.0/+esm`. It's ESM-only, so use jsdelivr's `+esm` bundle. |
| 3D rendering | `three` | **0.187.0** (released 2026-10-30) | `https://cdn.jsdelivr.net/npm/three@0.187.0/build/three.module.js` via an import map, plus `OrbitControls` from `three@0.187.0/examples/jsm/...` |
| Map projection (2D) | `d3-geo` + `topojson-client` | pin at build time | jsdelivr |
| UI | Plain HTML/CSS + vanilla JS modules | none | inline |

**Why not CesiumJS or globe.gl?** Cesium (1.147) is powerful but very large and expects its own asset server and tokens, which is awkward in an artifact. globe.gl (2.46.2) is convenient but adds overhead per object. A custom three.js `Points` cloud with a GPU shader is the most reliable way to animate **15k to 30k+ objects at 60 fps**. We keep globe.gl as a fallback if time is short.

---

## 5. Architecture

```
                     ┌──────────────────────── Claude Code session (cloud) ─────────────────────────┐
                     │                                                                              │
 celestrak.org ─────►│  scripts/fetch_catalog.py  ──►  scripts/build_data.py  ──►  site/data/*.json  │
 (GP + SATCAT)       │  (download, cache, respect      (join metadata, classify,   (compact, versioned)│
                     │   rate limits)                    validate, compact)                          │
                     │                                                    │                          │
                     │                                         Artifact publish (same URL)           │
                     └────────────────────────────────────────────────────┼─────────────────────────┘
                                                                          ▼
 ┌─────────────────────────────────────── Browser (claude.ai artifact) ─────────────────────────────────┐
 │ index.html                                                                                           │
 │  ├─ loads data/catalog-active.json (+ manifest.json with build time, counts, data epoch)             │
 │  ├─ propagate.worker.js  (Web Worker: satellite.js SGP4 for all objects every ~1 s,                  │
 │  │                        sends Float32Array positions back as a transferable buffer)                │
 │  ├─ Globe view (three.js): Earth sphere + points shader, interpolates between worker updates         │
 │  ├─ Map view (2D canvas): equirectangular, same position buffer                                      │
 │  ├─ Side panel: search, filters, details, overhead list, stats                                       │
 │  └─ localStorage (guarded): favorites, observer location, last view                                  │
 └──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Data pipeline (runs in Claude Code, Python standard library only)

1. **Fetch** `GROUP=active&FORMAT=json` (OMM), the category groups (to tag constellations), and SATCAT CSV. Cache the raw files in `data-raw/` (git-ignored) with a timestamp, and skip the download if the cache is less than 2 hours old.
2. **Join and classify** each object:
   - `category`: starlink / oneweb / kuiper / gnss / geo-comms / weather / earth-obs / science / crewed / other / debris / rocket-body
   - `regime`: LEO (< 2,000 km), MEO, GEO (period about 1,436 min, low inclination), HEO (high eccentricity), computed from mean motion and eccentricity
   - `country/owner`, `launchDate`, `objectType`, `rcsSize`
3. **Validate**: drop decayed objects and malformed sets. Flag sets whose epoch is more than 30 days old as "stale" (shown dimmed). Run SGP4 once per object at build time and drop any that error.
4. **Compact output** (target **3 MB or less** for active objects):
   - `site/data/manifest.json`: build timestamp, source timestamps, object counts, schema version
   - `site/data/catalog-active.json`: columnar arrays (one array per field) instead of one object per satellite. That's about 40 to 60% smaller and parses faster.
   - `site/data/catalog-debris.json`: optional layer, lazy-loaded
5. **Test**: a small known-answer test that propagates a few fixed element sets (e.g. the ISS) to fixed times and compares them with SGP4 reference vectors.

### 5.2 Propagation (browser)

- Initialize each object from its OMM data with satellite.js. **Phase 0 checks** whether 7.1.0 can read OMM JSON directly. If it can't, the pipeline also emits TLE lines for objects with catalog numbers up to 99999, using Alpha-5 for larger ones.
- A **Web Worker** propagates all objects for `t` and `t+1s`, then converts ECI to ECEF (Earth-fixed) using `gstime`. Output goes into one `Float32Array` (x, y, z per object), sent to the main thread as a transferable buffer.
- The main thread **interpolates** between the two snapshots every frame, so motion is smooth at 60 fps while SGP4 runs only once per second.
- **Fallback** if workers are blocked in the artifact sandbox: time-sliced propagation on the main thread (a fraction of the objects per frame).
- Objects whose propagation errors (e.g. decayed) are hidden and counted in Stats.

### 5.3 Rendering

- **Globe**: three.js sphere with the Blue Marble texture, a subtle atmosphere glow and a day/night terminator from the sun position.
- **Satellites**: one `THREE.Points` with a custom shader, color by category or regime, size scaled with zoom, selected and favorite objects highlighted.
- **Picking**: raycast against points (throttled on hover, exact on click) and a fixed tap radius on touch.
- **Selected object**: orbit line (one full period, about 180 samples), ground track on the 2D map, and a marker with a label.
- **2D map view**: canvas equirectangular map with country outlines, points from the same buffer, and the selected ground track. It's the default on low-power or no-WebGL devices.

---

## 6. Proposed repo layout

```
Sat/
├── plan.md                    ← this file
├── README.md                  ← how to rebuild data & republish
├── .gitignore                 ← data-raw/, scratch files
├── scripts/
│   ├── fetch_catalog.py       ← downloads CelesTrak GP + SATCAT (rate-limit aware)
│   ├── build_data.py          ← join, classify, validate, compact → site/data/
│   └── test_sgp4_vectors.py   ← known-answer checks
├── site/                      ← exactly what gets published as the artifact
│   ├── index.html             ← page (UI, styles, main module)
│   ├── propagate.worker.js    ← SGP4 worker
│   ├── data/
│   │   ├── manifest.json
│   │   ├── catalog-active.json
│   │   ├── catalog-debris.json   (optional)
│   │   └── world-110m.json
│   └── img/
│       └── earth-2k.jpg
└── data-raw/                  ← git-ignored download cache
```

---

## 7. Features (with priority)

### 7.1 Must have (MVP)
- [ ] Live 3D globe with **every active satellite** moving in real time
- [ ] Live clock (UTC + local) and **data age badge** ("Orbital data from 3 h ago"), turning amber after 3 days and red after 7
- [ ] **Search** by name, NORAD ID or COSPAR ID, with instant results
- [ ] **Click/tap a satellite** to open the details panel: name, NORAD/COSPAR ID, owner/country, launch date, type, category, regime, current lat/lon/alt, speed, period, inclination, apogee/perigee, element-set epoch and age
- [ ] Orbit path and ground track for the selected satellite
- [ ] **Filters**: category/constellation, regime (LEO/MEO/GEO/HEO), country/owner, object type
- [ ] Counts that update with filters ("Showing 9,412 of 14,980")
- [ ] Mobile layout: bottom sheet panel, touch rotate/zoom, 16px gutters, no horizontal scroll
- [ ] Light/dark theme via tokens
- [ ] About panel: data sources, accuracy limits, attribution

### 7.2 Should have
- [ ] **Time controls**: Live / Pause / speed (1×, 10×, 60×, 600×) and scrub ±7 days, with a warning when far from the data epoch
- [ ] **2D map view** toggle
- [ ] **Observer location** (manual lat/lon or pick on map, saved locally): "What's overhead now" list sorted by elevation
- [ ] **Pass predictions** for the selected satellite at the observer location (next 5 passes: rise/max/set times, max elevation, using satellite.js look angles)
- [ ] **Favorites** (saved locally) and a "Favorites only" filter
- [ ] Preset views: ISS & stations, GPS/GNSS, GEO belt, Starlink shells
- [ ] **Stats panel**: totals by regime, category and country, plus a simple chart of launches by year from SATCAT

### 7.3 Could have
- [ ] Debris and rocket-body layer (lazy-loaded)
- [ ] Sun-lit vs. in-shadow shading per satellite (visibility to the naked eye)
- [ ] Shareable deep link via URL hash (e.g. `#sat=25544`) where the artifact viewer allows it
- [ ] Keyboard shortcuts (`/` search, `space` pause, `f` favorite)

### 7.8 Optional artifact capabilities (later, opt-in)
- **`sample`**: an "Explain this satellite" button that asks Claude for a plain-language summary of the selected object's mission, from its metadata. It's hidden if not granted.
- **`downloads`**: export the current filtered list or pass table as CSV.
- Not needed: `db`, `room`, `mcp`. The tracker is read-only for viewers.

---

## 8. UI / UX outline

```
Desktop                                           Phone
┌──────────────────────────────────────────┐      ┌──────────────────┐
│ Orbitwatch   [Search…]   UTC 12:04:31  ● │      │ Orbitwatch  [🔍] │
├──────────┬───────────────────────────────┤      │                  │
│ Filters  │                               │      │    3D globe /    │
│ Layers   │          3D GLOBE             │      │     2D map       │
│ Stats    │       (or 2D map toggle)      │      │                  │
│ Overhead │                               │      ├──────────────────┤
│──────────│                               │      │ ▔▔ bottom sheet  │
│ Details  │ [⏸] [1×▾] ──●──────── time    │      │ details/filters  │
└──────────┴───────────────────────────────┘      └──────────────────┘
```

- Space-dark default theme with a proper light theme, and a restrained color set per category (accessible contrast, not color alone: categories also listed by name in the legend).
- Loading state: progress through "Loading catalog → Initialising 14,980 orbits → Live".
- Empty and error states: no WebGL (falls back to 2D), data failed to load, all objects filtered out.
- Accessibility: keyboard reachable controls, ARIA labels, a reduced-motion option (pauses auto-rotate), and a text list alternative to the globe (search results/overhead list).

---

## 9. Performance budget

| Metric | Target |
|---|---|
| First paint (UI shell) | < 1 s |
| Catalog loaded and live | < 4 s on broadband |
| Frame rate (desktop / phone) | 60 fps / 30+ fps with about 15k objects |
| Full SGP4 pass in worker | < 150 ms per second of wall time |
| Total download (active layer) | ≤ 6 MB including Earth texture |
| Memory | < 300 MB |

Techniques: columnar data, typed arrays, one draw call for all points, transferable buffers, interpolation instead of per-frame SGP4, lazy debris layer, devicePixelRatio cap of 2.

---

## 10. Keeping data fresh (the "actually tracking" part)

1. **Manual refresh (always available)**: ask Claude in this repo: *"Refresh the satellite data and republish."* Claude runs the two scripts and republishes to the **same artifact URL**. Anyone with the link sees the new data on reload.
2. **Automatic refresh (Phase 7)**: a **scheduled task** that starts a fresh Claude Code session every day (or every 12 hours), runs the pipeline, commits the new `site/data/` to the branch, and republishes the artifact.
3. **In-page live fetch (only if Phase 0 shows it's allowed)**: the page tries CelesTrak directly on load and falls back silently to the bundled snapshot.
4. The UI always shows data age, so stale data is never silently shown as live.

---

## 11. Phases & acceptance criteria

| Phase | Work | Done when |
|---|---|---|
| **0. Feasibility spike** | Allow `celestrak.org` in the environment. Publish a tiny throwaway test artifact that checks: import map from jsdelivr works, `satellite.js@7.1.0/+esm` loads, a **module Web Worker** from a supporting file works, a supporting JSON file loads, WebGL works, and whether `fetch('https://celestrak.org/…')` is blocked. Check OMM support in satellite.js 7.1.0. | A short findings table appended to this plan, with the final data and worker approach decided. |
| **1. Data pipeline** | `fetch_catalog.py`, `build_data.py`, known-answer tests, `manifest.json`. | Running both scripts produces `site/data/` under the size budget. Tests pass. Object counts look right (cross-checked against CelesTrak's published group counts). |
| **2. Live globe MVP** | Earth, all active objects moving, data age badge, theme tokens, responsive shell. | Published artifact shows every active object moving smoothly. ISS position matches a reference within a few km. 60 fps on desktop. |
| **3. Interaction** | Search, select, details panel, orbit and ground track. | Find "ISS" or "25544" in under 2 keystrokes after typing, tap to see correct details on phone and desktop. |
| **4. Filters & views** | Category/regime/country/type filters, counts, 2D map, presets, time controls. | Filters update in < 100 ms. Time scrub moves everything consistently. 2D and 3D views agree. |
| **5. Observer features** | Location picker, overhead list, pass predictions, favorites. | Pass times for the ISS at a test location match an independent SGP4 calculation within about a minute. |
| **6. Polish & QA** | Design pass, accessibility pass, error and empty states, About panel, performance tuning. | Headless Playwright screenshots at 390px and 1440px in light and dark, no horizontal scroll, keyboard navigation works, performance budget met. |
| **7. Auto-refresh** | Scheduled task, README with refresh steps. | Data age resets daily without manual action. |
| **8. Extras (optional)** | Debris layer, "Explain this satellite" (`sample`), CSV export (`downloads`), sunlit shading. | Each extra is optional, and the page works fully without it. |

Every phase ends with a commit and push to `claude/determined-fermi-04jpsw` and a republish to the same artifact URL.

---

## 12. Testing & verification

- **Orbit math**: known-answer SGP4 tests in the pipeline. Spot-check ISS, a GPS satellite and a GEO satellite against independent reference positions.
- **Data**: schema validation, no duplicate NORAD IDs, counts per group within the expected range, stale-epoch report.
- **UI**: headless Chromium (Playwright, already installed in the container) loads the built `site/` locally. It takes screenshots, checks the console for errors, measures FPS and checks there's no horizontal scroll at phone width.
- **Manual**: open the published artifact on a phone and a laptop before calling each phase done.

---

## 13. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Artifact sandbox blocks runtime fetch to CelesTrak | High | Bundle data as supporting files and refresh by republishing (section 10). |
| Web Workers blocked in the sandbox | Medium | Time-sliced main-thread propagation fallback. |
| `+esm` bundle of satellite.js misbehaves | Low/Med | Pin a different jsdelivr path, or vendor the built file as a supporting file. |
| Catalog grows past the size budget (Starlink + Kuiper growth) | Medium | Columnar format, drop unused fields, split files by layer. Each file stays far under 16 MB. |
| Catalog numbers > 99999 break TLE-based code | Medium | Use OMM throughout, with Alpha-5 TLE only as a fallback. |
| CelesTrak rate-limits or changes endpoints | Low/Med | Cache, back off, at most one download per group per 2 hours, keep the last good snapshot. |
| Accuracy questioned for maneuvering satellites | Certain | Show data age and an accuracy note. Refresh daily. |
| Low-end phones struggle with WebGL + 15k points | Medium | Auto-switch to 2D map, cap pixel ratio, reduce point size and labels. |
| Scheduled task session lacks network access or publish rights | Medium | Test once in Phase 7. Manual refresh stays available. |

---

## 14. Open questions for you

1. **Name**: keep "Orbitwatch" or choose another?
2. **Debris**: include debris and rocket bodies (more complete, about double the objects) or active satellites only for v1?
3. **Default view**: 3D globe (more impressive) or 2D map (lighter on phones)?
4. **Refresh cadence**: daily automatic refresh, twice daily, or manual only?
5. **Sharing**: just for you, or will you share the link publicly? This affects whether we add the optional Claude-powered "Explain" button, which only works for signed-in claude.ai viewers.

---

## 15. Next step

Answer the open questions (or say "use your defaults": Orbitwatch, active only, 3D with 2D fallback, daily refresh, private), then start **Phase 0**. Claude will first ask you to approve adding `celestrak.org` to this environment's network allowlist.
