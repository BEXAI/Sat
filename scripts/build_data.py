#!/usr/bin/env python3
"""Turn raw CelesTrak downloads into the compact files the website loads.

Inputs  (from scripts/fetch_catalog.py):  data-raw/active.json, satcat.csv, group-*.csv
          (from npm, see scripts/package.json): world-atlas countries-50m.json
Outputs: site/data/catalog.json   columnar orbital elements + metadata
         site/data/world.json     land polygons + country borders (lon/lat)

Usage (from the repo root):
    python3 -I scripts/build_data.py
"""
import argparse
import csv
import glob
import json
import math
import os
import re
import sys
from datetime import datetime, timezone

MU = 398600.4418          # km^3/s^2, Earth's gravitational parameter
EARTH_RADIUS = 6378.137   # km, WGS-84 equatorial radius
SCHEMA_VERSION = 1

# ---------------------------------------------------------------- categories
# First matching rule wins. Each rule: (category, CelesTrak groups, name regex)
CATEGORY_RULES = [
    ("stations",   {"stations"}, None),
    ("starlink",   {"starlink"}, r"^STARLINK"),
    ("oneweb",     {"oneweb"}, r"^ONEWEB"),
    ("kuiper",     {"kuiper"}, r"^KUIPER"),
    ("navigation", {"gnss", "sbas"},
     r"^(NAVSTAR|GPS |GALILEO|GSAT0|BEIDOU|COSMOS 2[45]\d\d \(GLONASS|GLONASS|QZS|IRNSS|NVS-)"),
    ("military",   {"military"}, r"^(YAOGAN|USA \d|NROL|SKYNET|SYRACUSE|SICRAL|MUOS|WGS |AEHF|SBIRS|COSMOS|TJS|SDA |MERIDIAN)"),
    ("weather",    {"weather", "goes"},
     r"^(NOAA|GOES|METEOSAT|METOP|HIMAWARI|FENGYUN|FY-|METEOR|GK-?2A|INSAT-3D|JPSS|DMSP|YUNHAI|"
     r"YUNYAO|TOMORROW)"),
    ("earth",      {"resource", "planet", "spire", "sarsat", "dmc", "argos"},
     r"^(FLOCK|SKYSAT|PELICAN|TANAGER|LEMUR|ICEYE|CAPELLA|UMBRA|SENTINEL|LANDSAT|WORLDVIEW|"
     r"JILIN|SUPERVIEW|GAOFEN|HJ-|PLEIADES|SPOT |KOMPSAT|CARTOSAT|RESURS|KANOPUS|SATELLOGIC|"
     r"NUSAT|BLACKSKY|GHOSTSAT|HAWK|ALOS|RADARSAT|TERRASAR|TANDEM|COSMO-SKYMED|SAR|IRIDE|PIESAT|"
     r"TIANHUI|BRO-|GRUS|QPS-|GHGSAT|STRIX|WILDFIRE|NEONSAT|FIRESAT|NORSAT|ORORATECH)"),
    ("comms",      {"iridium-NEXT", "orbcomm", "globalstar", "intelsat", "ses", "telesat",
                    "x-comm", "other-comm", "qianfan", "hulianwang"},
     r"^(SES|INTELSAT|IS-|EUTELSAT|ASTRA|TELKOM|CHINASAT|ZHONGXING|APSTAR|ARABSAT|TURKSAT|"
     r"YAHSAT|THURAYA|INMARSAT|VIASAT|ECHOSTAR|DIRECTV|SIRIUS|XM-|HISPASAT|AMAZONAS|ANIK|"
     r"NIMIQ|JCSAT|SUPERBIRD|KOREASAT|MEASAT|THAICOM|OPTUS|NBN|SKYNET|AMOS|AZERSPACE|BADR|"
     r"NILESAT|EXPRESS|YAMAL|LUCH|TIANLIAN|TIANTONG|O3B|IRIDIUM|ORBCOMM|GLOBALSTAR|SWARM|"
     r"LYNK|BLUEBIRD|SATELIOT|E-SPACE|GUOWANG|QIANFAN|HULIANWANG|TELESAT|GALAXY|TDRS|"
     r"SPACEWAY|HELLAS|KA-SAT|ASIASAT|ABS-|BULGARIASAT|EXPRESS-AM|TIANQI|GEESAT|SITRO|RASSVET|"
     r"GSAT|SPACEMOBILE|CONNECTA|FOSSASAT|GONETS|SXM|SKYKRAFT|ASTROCAST|KORSAT|BSAT|HYLAS)"),
    ("science",    {"science", "geodetic", "engineering", "education", "amateur",
                    "satnogs", "cubesat"},
     r"^(SHIYAN|SHIJIAN|SJ-|CHUANGXIN|PUNCH|THEMIS|STARLING|CALSPHERE|AEROCUBE|HERMES)"),
]
CATEGORY_ORDER = [r[0] for r in CATEGORY_RULES] + ["other"]

OBJECT_TYPES = {"PAY": "Payload", "R/B": "Rocket body", "DEB": "Debris", "UNK": "Unknown"}
OPS_STATUS = {
    "+": "Operational", "-": "Nonoperational", "P": "Partially operational",
    "B": "Backup / standby", "S": "Spare", "X": "Extended mission",
    "D": "Decayed", "?": "Unknown", "": "Unknown",
}
# CelesTrak SATCAT owner/source codes -> readable names (unknown codes show as-is)
OWNERS = {
    "US": "United States", "PRC": "China", "UK": "United Kingdom", "CIS": "Russia (CIS)",
    "JPN": "Japan", "TBD": "To be determined", "IT": "Italy", "IND": "India",
    "SKOR": "South Korea", "NKOR": "North Korea", "GER": "Germany", "FR": "France",
    "ESA": "European Space Agency", "SPN": "Spain", "CA": "Canada", "TURK": "Türkiye",
    "SES": "SES", "ITSO": "Intelsat", "O3B": "O3b (SES)", "AUS": "Australia",
    "ARGN": "Argentina", "ROC": "Taiwan", "FIN": "Finland", "EUTE": "Eutelsat",
    "GLOB": "Globalstar", "GREC": "Greece", "UAE": "United Arab Emirates", "NOR": "Norway",
    "ISRA": "Israel", "SAUD": "Saudi Arabia", "POL": "Poland", "BRAZ": "Brazil",
    "IM": "Inmarsat", "ORB": "ORBCOMM", "SING": "Singapore", "POR": "Portugal",
    "IRAN": "Iran", "LUXE": "Luxembourg", "EGYP": "Egypt", "BEL": "Belgium",
    "AB": "Arabsat", "INDO": "Indonesia", "NETH": "Netherlands", "EUME": "EUMETSAT",
    "SWTZ": "Switzerland", "MALA": "Malaysia", "PAKI": "Pakistan", "RWA": "Rwanda",
    "AC": "AsiaSat", "THAI": "Thailand", "ALG": "Algeria", "KAZ": "Kazakhstan",
    "DEN": "Denmark", "BUL": "Bulgaria", "ISS": "International Space Station",
    "ABS": "ABS", "MEX": "Mexico", "VTNM": "Vietnam", "AZER": "Azerbaijan",
    "BELA": "Belarus", "MA": "Morocco", "NZ": "New Zealand", "LTU": "Lithuania",
    "EST": "Estonia", "CZCH": "Czechia", "CZE": "Czechia", "HUN": "Hungary",
    "AUT": "Austria", "ASRA": "Austria", "SWED": "Sweden", "IRL": "Ireland",
    "UKR": "Ukraine", "SAFR": "South Africa", "NIG": "Nigeria", "KEN": "Kenya",
    "ETH": "Ethiopia", "GHA": "Ghana", "ANG": "Angola", "SDN": "Sudan", "TUN": "Tunisia",
    "PER": "Peru", "PERU": "Peru", "CHLE": "Chile", "COL": "Colombia", "ECU": "Ecuador",
    "BOL": "Bolivia", "URY": "Uruguay", "VENZ": "Venezuela", "PRY": "Paraguay",
    "CRI": "Costa Rica", "GUAT": "Guatemala", "QAT": "Qatar", "KWT": "Kuwait",
    "JOR": "Jordan", "BHR": "Bahrain", "OMN": "Oman", "IRAQ": "Iraq", "BGD": "Bangladesh",
    "NPL": "Nepal", "LKA": "Sri Lanka", "BHUT": "Bhutan", "MNG": "Mongolia",
    "MMR": "Myanmar", "LAOS": "Laos", "RP": "Philippines", "TMMC": "Turkmenistan",
    "UZB": "Uzbekistan", "KGZ": "Kyrgyzstan", "ROM": "Romania", "SVN": "Slovenia",
    "SVK": "Slovakia", "SLVK": "Slovakia", "CRO": "Croatia", "SRB": "Serbia",
    "LVA": "Latvia", "MDA": "Moldova", "ARM": "Armenia", "GEOR": "Georgia",
    "ISL": "Iceland", "MCO": "Monaco", "MALT": "Malta", "CYP": "Cyprus",
    "NATO": "NATO", "FRIT": "France/Italy", "FGER": "France/Germany",
    "CHBZ": "China/Brazil", "PRES": "China/ESA", "STCT": "Singapore/Taiwan",
    "USBZ": "United States/Brazil", "IRID": "Iridium", "RASC": "RascomStar-QAF",
    "SEAL": "Sea Launch", "NICO": "New ICO", "APTS": "APT Satellite", "SEA": "Sea Launch",
    "INTL": "International", "UNK": "Unknown",
    "BWA": "Botswana", "DJI": "Djibouti", "GRSA": "Greece/Saudi Arabia", "HRV": "Croatia",
    "MNE": "Montenegro",
}
LAUNCH_SITES = {
    "AFETR": "Cape Canaveral, USA", "AFWTR": "Vandenberg, USA", "JSC": "Jiuquan, China",
    "FRGUI": "Kourou, French Guiana", "VOSTO": "Vostochny, Russia",
    "TYMSC": "Baikonur, Kazakhstan", "TAISC": "Taiyuan, China", "WSC": "Wenchang, China",
    "XICLF": "Xichang, China", "PLMSC": "Plesetsk, Russia", "SRILR": "Sriharikota, India",
    "RLLB": "Mahia Peninsula, New Zealand", "YSLA": "Yellow Sea (sea launch), China",
    "STARB": "Starbase, USA", "DLS": "Dombarovsky (Yasny), Russia",
    "TANSC": "Tanegashima, Japan", "NSC": "Naro, South Korea", "SEAL": "Sea Launch platform",
    "SCSLA": "South China Sea (sea launch)", "ERAS": "Air launch (Eastern Range)",
    "KSCUT": "Uchinoura, Japan", "WLPIS": "Wallops Island, USA", "ANDSP": "Andøya, Norway",
    "WRAS": "Air launch (Western Range)", "KODAK": "Kodiak, USA", "SEMLS": "Semnan, Iran",
    "SMTS": "Shahroud, Iran", "YUN": "Sohae, North Korea", "KYMSC": "Kapustin Yar, Russia",
    "KWAJ": "Kwajalein, Marshall Islands", "SADOL": "Barents Sea (submarine launch)",
    "SVOB": "Svobodny, Russia", "HGSTR": "Hammaguira, Algeria", "SNMLP": "San Marco, Kenya",
    "PMRF": "Barking Sands, USA", "OREN": "Orenburg, Russia",
}


def group_membership(raw_dir):
    groups = {}
    for path in glob.glob(os.path.join(raw_dir, "group-*.csv")):
        name = os.path.basename(path)[len("group-"):-len(".csv")]
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                try:
                    groups.setdefault(int(row["NORAD_CAT_ID"]), set()).add(name)
                except (KeyError, ValueError):
                    pass
    return groups


def classify(name, groups):
    compiled = classify.compiled
    for cat, gset, rx in compiled:
        if groups & gset:
            return cat
    for cat, gset, rx in compiled:
        if rx is not None and rx.search(name):
            return cat
    return "other"


classify.compiled = [(c, g, re.compile(r) if r else None) for c, g, r in CATEGORY_RULES]


def orbit_shape(mean_motion, ecc):
    """Return (semi-major axis km, perigee alt km, apogee alt km, period min)."""
    n = mean_motion * 2 * math.pi / 86400.0
    a = (MU / (n * n)) ** (1 / 3)
    return a, a * (1 - ecc) - EARTH_RADIUS, a * (1 + ecc) - EARTH_RADIUS, 1440.0 / mean_motion


def regime(mean_motion, ecc, perigee, apogee):
    if ecc >= 0.25:
        return "HEO"
    if abs(mean_motion - 1.0027) < 0.03 and ecc < 0.05:
        return "GEO"
    if (perigee + apogee) / 2 < 2000:
        return "LEO"
    return "MEO"


def sig(x, digits):
    """Round to significant digits, keeping JSON short."""
    if x == 0:
        return 0
    return float(f"{x:.{digits}g}")


def parse_epoch_ms(s):
    s = s.rstrip("Z")
    dt = datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%f" if "." in s else "%Y-%m-%dT%H:%M:%S")
    return round(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)


class Table:
    """Interns repeated strings so the JSON stores small integers."""

    def __init__(self, initial=()):
        self.items, self.index = [], {}
        for v in initial:
            self.add(v)

    def add(self, value):
        if value not in self.index:
            self.index[value] = len(self.items)
            self.items.append(value)
        return self.index[value]


def build_catalog(raw_dir):
    with open(os.path.join(raw_dir, "active.json"), encoding="utf-8") as f:
        omm = json.load(f)
    satcat = {}
    with open(os.path.join(raw_dir, "satcat.csv"), encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            try:
                satcat[int(row["NORAD_CAT_ID"])] = row
            except (KeyError, ValueError):
                pass
    groups = group_membership(raw_dir)
    try:
        with open(os.path.join(raw_dir, "fetch-log.json")) as f:
            fetched_at = json.load(f).get("active.json", {}).get("fetched_at")
    except (OSError, ValueError):
        fetched_at = None
    if not fetched_at:
        mtime = os.path.getmtime(os.path.join(raw_dir, "active.json"))
        fetched_at = datetime.fromtimestamp(mtime, timezone.utc).isoformat()

    cats = Table(CATEGORY_ORDER)
    regimes = Table(["LEO", "MEO", "GEO", "HEO"])
    owners, sites = Table(), Table()
    types = Table(OBJECT_TYPES.values())
    status = Table(dict.fromkeys(OPS_STATUS.values()))

    cols = {k: [] for k in [
        "id", "name", "cospar", "epoch", "mm", "ecc", "inc", "raan", "argp", "ma",
        "bstar", "ndot", "nddot", "cat", "regime", "owner", "type", "status",
        "launch", "site", "rcs",
    ]}
    seen, dropped = set(), {"duplicate": 0, "bad_elements": 0, "decayed": 0}
    for o in omm:
        try:
            nid = int(o["NORAD_CAT_ID"])
            mm, ecc = float(o["MEAN_MOTION"]), float(o["ECCENTRICITY"])
            epoch = parse_epoch_ms(o["EPOCH"])
        except (KeyError, ValueError, TypeError):
            dropped["bad_elements"] += 1
            continue
        if nid in seen:
            dropped["duplicate"] += 1
            continue
        if not (0 < mm < 20) or not (0 <= ecc < 1):
            dropped["bad_elements"] += 1
            continue
        sc = satcat.get(nid, {})
        if sc.get("DECAY_DATE"):
            dropped["decayed"] += 1
            continue
        seen.add(nid)
        name = (o.get("OBJECT_NAME") or sc.get("OBJECT_NAME") or f"NORAD {nid}").strip()
        _, perigee, apogee, _ = orbit_shape(mm, ecc)
        owner_code = sc.get("OWNER", "") or "UNK"
        site_code = sc.get("LAUNCH_SITE", "")
        launch = sc.get("LAUNCH_DATE", "")
        rcs = sc.get("RCS", "")

        cols["id"].append(nid)
        cols["name"].append(name)
        cols["cospar"].append(o.get("OBJECT_ID") or sc.get("OBJECT_ID") or "")
        cols["epoch"].append(epoch)
        cols["mm"].append(round(mm, 8))
        cols["ecc"].append(round(ecc, 8))
        cols["inc"].append(round(float(o["INCLINATION"]), 4))
        cols["raan"].append(round(float(o["RA_OF_ASC_NODE"]), 4))
        cols["argp"].append(round(float(o["ARG_OF_PERICENTER"]), 4))
        cols["ma"].append(round(float(o["MEAN_ANOMALY"]), 4))
        cols["bstar"].append(sig(float(o.get("BSTAR", 0) or 0), 6))
        cols["ndot"].append(sig(float(o.get("MEAN_MOTION_DOT", 0) or 0), 6))
        cols["nddot"].append(sig(float(o.get("MEAN_MOTION_DDOT", 0) or 0), 6))
        cols["cat"].append(cats.add(classify(name.upper(), groups.get(nid, set()))))
        cols["regime"].append(regimes.add(regime(mm, ecc, perigee, apogee)))
        cols["owner"].append(owners.add(owner_code))
        cols["type"].append(types.add(OBJECT_TYPES.get(sc.get("OBJECT_TYPE", "UNK"), "Unknown")))
        cols["status"].append(status.add(OPS_STATUS.get(sc.get("OPS_STATUS_CODE", ""), "Unknown")))
        cols["launch"].append(int(launch.replace("-", "")) if re.fullmatch(r"\d{4}-\d\d-\d\d", launch) else 0)
        cols["site"].append(sites.add(site_code) if site_code else -1)
        try:
            cols["rcs"].append(round(float(rcs), 2) if rcs else -1)
        except ValueError:
            cols["rcs"].append(-1)

    if not cols["id"]:
        raise SystemExit("ERROR: no usable objects in active.json")

    epochs = sorted(cols["epoch"])
    catalog = {
        "schema": SCHEMA_VERSION,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fetchedAt": fetched_at,
        "source": "CelesTrak GP (GROUP=active, OMM) + SATCAT",
        "count": len(cols["id"]),
        "epochRange": [epochs[0], epochs[len(epochs) // 2], epochs[-1]],
        "dropped": dropped,
        "tables": {
            "cat": cats.items,
            "regime": regimes.items,
            "owner": owners.items,
            "ownerName": [OWNERS.get(c, c) for c in owners.items],
            "type": types.items,
            "status": status.items,
            "site": sites.items,
            "siteName": [LAUNCH_SITES.get(c, c) for c in sites.items],
        },
        "cols": cols,
    }
    return catalog


# ------------------------------------------------------------------ world map
def decode_topology(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((round(x * sx + tx, 2), round(y * sy + ty, 2)))
        arcs.append(pts)
    return arcs


def ring_from_arcs(arc_ids, arcs):
    ring = []
    for i in arc_ids:
        pts = arcs[i] if i >= 0 else arcs[~i][::-1]
        ring.extend(pts if not ring else pts[1:])
    return ring


def flat(points, tol=0.04):
    """Flatten [(lon, lat)] to [lon, lat, ...], dropping points closer than tol degrees."""
    out, last = [], None
    for k, p in enumerate(points):
        if last is not None and k != len(points) - 1 and \
                abs(p[0] - last[0]) < tol and abs(p[1] - last[1]) < tol:
            continue
        out.extend(p)
        last = p
    return out


def unwrap_ring(points):
    """Make a [(lon, lat)] ring continuous across the antimeridian.

    Longitudes may then run past +/-180 (the page draws such rings twice, shifted by
    360 degrees). A ring that winds around a pole (Antarctica) is closed along that pole.
    """
    if not points:
        return points
    out = [points[0]]
    for lon, lat in points[1:]:
        prev = out[-1][0]
        d = lon - (prev - 360 * round(prev / 360))
        if d > 180:
            d -= 360
        elif d < -180:
            d += 360
        out.append((round(prev + d, 2), lat))
    net = out[-1][0] - out[0][0]
    if abs(net) > 180:
        pole = -90.0 if sum(p[1] for p in out) / len(out) < 0 else 90.0
        out += [(out[-1][0], pole), (out[0][0], pole)]
    return out


def polygons_of(geom):
    if geom["type"] == "Polygon":
        return [geom["arcs"]]
    if geom["type"] == "MultiPolygon":
        return geom["arcs"]
    return []


def build_world(topo_path):
    with open(topo_path, encoding="utf-8") as f:
        topo = json.load(f)
    arcs = decode_topology(topo)
    land = []
    for geom in topo["objects"]["land"]["geometries"]:
        for poly in polygons_of(geom):
            for ring_ids in poly:
                ring = flat(unwrap_ring(ring_from_arcs(ring_ids, arcs)))
                if len(ring) >= 8:
                    land.append(ring)
    # Borders = arcs shared by two different countries (like topojson.mesh(a !== b)).
    users = {}
    for gi, geom in enumerate(topo["objects"]["countries"]["geometries"]):
        for poly in polygons_of(geom):
            for ring_ids in poly:
                for i in ring_ids:
                    users.setdefault(i if i >= 0 else ~i, set()).add(gi)
    borders = [flat(arcs[i]) for i, g in sorted(users.items()) if len(g) > 1]
    borders = [b for b in borders if len(b) >= 4]
    return {"source": "Natural Earth 1:50m via world-atlas 2.0.2", "land": land, "borders": borders}


def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)
    return os.path.getsize(path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--raw", default="data-raw")
    ap.add_argument("--out", default="site/data")
    ap.add_argument("--world", default="node_modules/world-atlas/countries-50m.json")
    args = ap.parse_args()

    catalog = build_catalog(args.raw)
    size = write_json(os.path.join(args.out, "catalog.json"), catalog)
    t = catalog["tables"]
    counts = {}
    for c in catalog["cols"]["cat"]:
        counts[t["cat"][c]] = counts.get(t["cat"][c], 0) + 1
    print(f"catalog.json: {catalog['count']} objects, {size / 1e6:.2f} MB")
    print("  by category:", dict(sorted(counts.items(), key=lambda kv: -kv[1])))
    print("  dropped:", catalog["dropped"])
    unknown = sorted({c for c in t["owner"] if c not in OWNERS})
    if unknown:
        print("  owner codes without a readable name:", ", ".join(unknown))

    if os.path.exists(args.world):
        world = build_world(args.world)
        size = write_json(os.path.join(args.out, "world.json"), world)
        print(f"world.json: {len(world['land'])} land rings, {len(world['borders'])} borders, {size / 1e6:.2f} MB")
    else:
        print(f"world.json skipped: {args.world} not found (run: npm ci)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
