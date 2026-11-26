#!/usr/bin/env python3
"""Download orbital elements and catalog metadata from CelesTrak.

Writes raw files into data-raw/ (git-ignored). Respects CelesTrak's usage
policy: each file is downloaded at most once every 2 hours unless --force is
given, requests are spaced out, and a generic User-Agent is sent.

Usage (from the repo root):
    python3 -I scripts/fetch_catalog.py            # normal run
    python3 -I scripts/fetch_catalog.py --force    # ignore the 2-hour cache
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BASE = "https://celestrak.org"
USER_AGENT = "orbitwatch-data-pipeline/1.0"
MIN_AGE_SECONDS = 2 * 3600
PAUSE_SECONDS = 3.0

# CelesTrak "GP" groups used only to tag objects with a category.
# A group that does not exist simply comes back empty and is skipped.
GROUPS = [
    "stations", "last-30-days",
    "starlink", "oneweb", "kuiper", "qianfan", "hulianwang",
    "gnss", "sbas",
    "weather", "goes",
    "resource", "planet", "spire", "sarsat", "dmc", "argos",
    "iridium-NEXT", "orbcomm", "globalstar", "intelsat", "ses",
    "telesat", "x-comm", "other-comm", "amateur", "satnogs",
    "science", "geodetic", "engineering", "education",
    "military", "radar", "cubesat",
]


def sources():
    src = {
        "active.json": f"{BASE}/NORAD/elements/gp.php?GROUP=active&FORMAT=json",
        "satcat.csv": f"{BASE}/pub/satcat.csv",
    }
    for g in GROUPS:
        src[f"group-{g}.csv"] = f"{BASE}/NORAD/elements/gp.php?GROUP={g}&FORMAT=csv"
    return src


def looks_valid(name, body):
    text = body[:200].decode("utf-8", "replace").lstrip("﻿").strip()
    if name.endswith(".json"):
        return text.startswith("[")
    if name == "satcat.csv":
        return text.startswith("OBJECT_NAME")
    return text.startswith("OBJECT_NAME")


def fetch(url, attempts=4):
    """GET a URL, retrying dropped connections with exponential backoff."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return resp.read()
        except urllib.error.HTTPError:
            raise  # a real HTTP answer (e.g. 403/404): don't hammer the server
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            if attempt == attempts - 1:
                raise
            time.sleep(5 * 2 ** attempt)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", default="data-raw", help="output directory")
    ap.add_argument("--force", action="store_true", help="ignore the 2-hour cache")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    log_path = os.path.join(args.out, "fetch-log.json")
    try:
        with open(log_path) as f:
            log = json.load(f)
    except (OSError, ValueError):
        log = {}

    first = True
    failures = 0
    for name, url in sources().items():
        path = os.path.join(args.out, name)
        if not args.force and os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < MIN_AGE_SECONDS:
                print(f"cached  {name} ({age / 60:.0f} min old)")
                continue
        if not first:
            time.sleep(PAUSE_SECONDS)
        first = False
        try:
            body = fetch(url)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"FAILED  {name}: {e}", file=sys.stderr)
            failures += 1
            continue
        if not looks_valid(name, body):
            snippet = body[:80].decode("utf-8", "replace").strip()
            print(f"skipped {name}: no data ({snippet!r})")
            log[name] = {"url": url, "status": "empty",
                         "fetched_at": datetime.now(timezone.utc).isoformat()}
            if os.path.exists(path):
                os.remove(path)
            continue
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        log[name] = {"url": url, "status": "ok", "bytes": len(body),
                     "fetched_at": datetime.now(timezone.utc).isoformat()}
        print(f"fetched {name} ({len(body) / 1024:.0f} KB)")

    with open(log_path, "w") as f:
        json.dump(log, f, indent=2, sort_keys=True)

    if not os.path.exists(os.path.join(args.out, "active.json")):
        print("ERROR: active.json is missing; cannot build.", file=sys.stderr)
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
