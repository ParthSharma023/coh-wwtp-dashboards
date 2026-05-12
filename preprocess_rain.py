"""
preprocess_rain.py — Generate per-year and per-month rain JS files for WWTP dashboards.

Usage:
    python3 preprocess_rain.py --fid 0146 --gauge 1610

Reads 5-min rainfall parquet (partitioned by year) from S3.
Writes rain_<year>.js and rain_<year>_<month>_min.js to wwtp_dashboards/<slug>/data/
"""

import argparse
import calendar
import json
import math
import sys
from pathlib import Path

import pandas as pd

S3_BUCKET  = "aventdtlkps3stg01"
S3_5MIN    = f"s3://{S3_BUCKET}/processed/api_vendors/hcfcd/rainfall_5_min_partitioned"
OUTPUT_BASE = Path("wwtp_dashboards")

# FID → (slug, display_name)
PLANT_SLUGS = {
    "0146": ("northeast",    "Northeast WWTP"),
    "0400": ("69th_street",  "69th Street WWTP"),
    "0469": ("willowbrook",  "Willowbrook WWTP"),
    # add more as we expand rain coverage
}

def safe(v):
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    except Exception:
        return None


def get_plant_year_range(slug):
    meta_path = OUTPUT_BASE / slug / "data" / "meta.json"
    if not meta_path.exists():
        return None, None
    try:
        meta = json.loads(meta_path.read_text())
        years = meta.get("years") or []
        if not years:
            return None, None
        years = sorted(int(y) for y in years)
        return years[0], years[-1]
    except Exception:
        return None, None


def process_rain(fid, gauge_id, start_year=None, end_year=None):
    if fid not in PLANT_SLUGS:
        print(f"ERROR: FID {fid} not in PLANT_SLUGS — add it first.")
        sys.exit(1)

    slug, plant_name = PLANT_SLUGS[fid]
    out_dir = OUTPUT_BASE / slug / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"  {plant_name}  (FID {fid}, gauge {gauge_id})")
    print(f"{'='*60}")

    # Discover available years
    import s3fs
    fs = s3fs.S3FileSystem()
    partitions = fs.ls(f"{S3_BUCKET}/processed/api_vendors/hcfcd/rainfall_5_min_partitioned", detail=False)
    years = sorted([int(p.split("year=")[1]) for p in partitions if "year=" in p])
    print(f"  Available years: {years[0]}–{years[-1]}")

    meta_start, meta_end = get_plant_year_range(slug)
    if start_year is None:
        start_year = meta_start
    if end_year is None:
        end_year = meta_end

    if start_year is not None:
        years = [y for y in years if y >= start_year]
    if end_year is not None:
        years = [y for y in years if y <= end_year]
    if not years:
        print("ERROR: no years remain after filtering.")
        sys.exit(1)
    print(f"  Processing years: {years[0]}–{years[-1]}")

    all_5min = []

    for year in years:
        path = f"{S3_5MIN}/year={year}"
        print(f"  Reading {year}…", end=" ", flush=True)
        try:
            df = pd.read_parquet(
                path,
                filters=[("site_id", "==", str(gauge_id))],
                columns=["datetime", "site_id", "value"],
            )
        except Exception as e:
            print(f"SKIP ({e})")
            continue

        df["datetime"] = pd.to_datetime(df["datetime"])
        df = df[["datetime", "value"]].sort_values("datetime")
        all_5min.append(df)
        print(f"{len(df)} rows, {(df['value']>0).sum()} non-zero")

    if not all_5min:
        print("ERROR: no data found.")
        sys.exit(1)

    df_all = pd.concat(all_5min, ignore_index=True).sort_values("datetime")
    print(f"\n  Total rows: {len(df_all)}")

    # ── Hourly aggregation ────────────────────────────────────────────────────
    df_all = df_all.set_index("datetime")
    rain_h = df_all["value"].resample("1h").sum()

    all_years = sorted(rain_h.index.year.unique().tolist())
    print(f"  Years with data: {all_years}")

    print("  Writing yearly files…")
    for year in all_years:
        idx    = pd.date_range(f"{year}-01-01", f"{year}-12-31 23:00", freq="1h")
        rain_y = rain_h.reindex(idx, fill_value=0)

        out = {
            "plant": plant_name, "fid": fid, "gauge": gauge_id, "year": year,
            "timestamps": [ts.strftime("%Y-%m-%d %H:%M") for ts in idx],
            "rain": [safe(v) for v in rain_y.values],
        }
        p = out_dir / f"rain_{year}.js"
        with open(p, "w") as f:
            f.write(f"window.__wwtp_rain=window.__wwtp_rain||{{}};window.__wwtp_rain[{year}]={json.dumps(out, separators=(',', ':'))};")
        print(f"    {year}: {p.stat().st_size//1024} KB")

    # ── 5-min monthly files ───────────────────────────────────────────────────
    rain_5min = df_all["value"].resample("5min").sum()

    months_present = sorted(set(zip(rain_5min.index.year, rain_5min.index.month)))
    print(f"  Writing {len(months_present)} monthly 5-min files…")

    for year, month in months_present:
        days = calendar.monthrange(year, month)[1]
        idx  = pd.date_range(
            f"{year}-{month:02d}-01",
            f"{year}-{month:02d}-{days:02d} 23:55",
            freq="5min"
        )
        rain_m = rain_5min.reindex(idx, fill_value=0)

        out = {
            "year": year, "month": month,
            "gauge": gauge_id,
            "timestamps": [ts.strftime("%Y-%m-%d %H:%M") for ts in idx],
            "rain": [safe(v) for v in rain_m.values],
        }
        key = f"{year}_{month:02d}"
        p = out_dir / f"rain_{key}_min.js"
        with open(p, "w") as f:
            f.write(f"window.__wwtp_rain_min=window.__wwtp_rain_min||{{}};window.__wwtp_rain_min[\"{key}\"]={json.dumps(out, separators=(',', ':'))};")

    print("  Done.")


parser = argparse.ArgumentParser()
parser.add_argument("--fid",   required=True, help="Plant FID e.g. 0146")
parser.add_argument("--gauge", required=True, help="Rain gauge site_id e.g. 1610")
parser.add_argument("--start-year", type=int, help="Optional first year to process")
parser.add_argument("--end-year", type=int, help="Optional last year to process")
args = parser.parse_args()

process_rain(args.fid, args.gauge, args.start_year, args.end_year)
