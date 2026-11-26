#!/usr/bin/env python3
"""Independent SGP4 reference positions for verify_catalog.mjs.

Uses the `sgp4` Python package (a port of Vallado's official SGP4 code) and the
*raw, full-precision* CelesTrak data, so the comparison checks both the
browser's SGP4 library and the rounding done by build_data.py.

Setup (once, in a virtual environment):  pip install sgp4
Usage (from the repo root):
    python scripts/reference_positions.py --time 2026-11-27T00:00:00Z > test-output/reference.json
"""
import argparse
import json
import sys
from datetime import datetime, timezone

from sgp4 import omm
from sgp4.api import Satrec, jday


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default="data-raw/active.json")
    ap.add_argument("--time", required=True, help="UTC time, e.g. 2026-11-27T00:00:00Z")
    ap.add_argument("--every", type=int, default=40, help="sample every Nth object")
    args = ap.parse_args()

    t = datetime.fromisoformat(args.time.replace("Z", "+00:00")).astimezone(timezone.utc)
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond / 1e6)

    with open(args.raw, encoding="utf-8") as f:
        records = json.load(f)
    wanted = {25544, 48274, 20580}  # ISS, Tiangong (CSS Tianhe), Hubble
    out = {"time": args.time, "positions": {}}
    for k, rec in enumerate(records):
        nid = int(rec["NORAD_CAT_ID"])
        if k % args.every and nid not in wanted:
            continue
        sat = Satrec()
        omm.initialize(sat, {key: str(v) for key, v in rec.items()})
        err, r, _v = sat.sgp4(jd, fr)
        if err == 0:
            out["positions"][str(nid)] = [round(c, 4) for c in r]
    json.dump(out, sys.stdout)
    print(f"reference: {len(out['positions'])} objects", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
