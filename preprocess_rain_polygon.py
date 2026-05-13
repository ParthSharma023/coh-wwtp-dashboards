"""
preprocess_rain_polygon.py — Generate per-year rain JS files from wwar_rainfall_freq polygon parquet.

Usage:
    python3 preprocess_rain_polygon.py --fid 0006
    python3 preprocess_rain_polygon.py --all

Data source: DaaP/Rain_Frequency/wwar_Rain_Frequency/wwar_rainfall_freq.parquet
Each plant polygon has pre-computed daily rainfall: max_value_24h (inches) and
return_frequency_24h (return period in years). Only event days are written (sparse).

Output: rain_{year}.js per plant in wwtp_dashboards/<slug>/data/
"""

import argparse
import json
import math
import sys
from pathlib import Path

import pandas as pd

S3_PARQUET = "s3://aventdtlkps3stg01/DaaP/Rain_Frequency/wwar_Rain_Frequency/wwar_rainfall_freq.parquet"
OUTPUT_BASE = Path("wwtp_dashboards")

# FID → (slug, plant_display_name, polygon_id, gauge_id, gauge_label)
# gauge_id/gauge_label from US3 level sensor service area mapping; None if unmapped
PLANT_RAIN_CONFIG = {
    "0400": ("69th_street",              "69th Street WWTP",              "69th Street",       2240, "Buffalo Bayou @ Shepherd Drive"),
    "0006": ("almeda_sims",              "Almeda Sims WWTP",              "Almeda Sims",        380, "Sims Bayou @ Hiram-Clarke Road"),
    "0242": ("beltway",                  "Beltway WWTP",                  "Beltway",            470, "Brays Bayou @ Belle Park Drive"),
    "0244": ("cedar_bayou",              "Cedar Bayou WWTP",              "Cedar Bayou",       1940, "Luce Bayou @ FM"),
    "0039": ("chocolate_bayou",          "Chocolate Bayou WWTP",          "Chocolate Bayou",    360, "Sims Bayou @ Martin Luther King Road"),
    "0040": ("clinton_park",             "Clinton Park WWTP",             "Clinton Park",      2210, "Buffalo Bayou @ Turning Basin"),
    "0059": ("easthaven",                "Easthaven WWTP",                "Easthaven",          310, "Berry Bayou @ Nevada Avenue"),
    "0083": ("fwsd_23",                  "F.W.S.D. #23 WWTP",             "FWSD #23",          1675, "Halls Bayou @ Tidwell Road"),
    "0565": ("forest_cove",              "Forest Cove WWTP",              "Forest Cove",        755, "San Jacinto River @ Kingwood Country Club"),
    "0240": ("greenridge",               "Greenridge WWTP",               "Greenridge",         380, "Sims Bayou @ Hiram-Clarke Road"),
    "0107": ("homestead",                "Homestead WWTP",                "Homestead",         1675, "Halls Bayou @ Tidwell Road"),
    "0268": ("imperial_valley",          "Imperial Valley WWTP",          "Imperial Valley",   1660, "Greens Bayou @ Knobcrest Drive"),
    "0238": ("intercontinental_airport", "Intercontinental Airport WWTP", "Intercontinental",  None, None),
    "0250": ("keegans_bayou",            "Keegan's Bayou WWTP",           "Keegans Bayou",      465, "Brays Bayou @ Beltway 8"),
    "0451": ("mc_mud_48",                "MC MUD #48 WWTP",               "MC MUD #48",         None, None),
    "0243": ("mud_203",                  "M.U.D. #203 WWTP",              "MUD #203",           1660, "Greens Bayou @ Knobcrest Drive"),
    "0397": ("metro_central",            "Metro Central WWTP",            "Metro Central",      250, "Horsepen Creek @ Bay Area Boulevard"),
    "0252": ("northbelt",                "Northbelt WWTP",                "Northbelt",         1640, "Greens Bayou @ US 59"),
    "0146": ("northeast",                "Northeast WWTP",                "Northeast",         1610, "Greens Bayou @ Normandy Street"),
    "0270": ("northgate",                "Northgate WWTP",                "Northgate",         1660, "Greens Bayou @ Knobcrest Drive"),
    "0145": ("northwest",                "Northwest WWTP",                "Northwest",          582, "Brickhouse Gully @ Hollister"),
    "0245": ("park_ten",                 "Park Ten WWTP",                 "Park Ten",          2150, "South Mayde @ Greenhouse Road"),
    "0171": ("sagemont",                 "Sagemont WWTP",                 "Sagemont",           160, "Beamer Ditch @ Hughes Road"),
    "0183": ("sims_bayou",               "Sims Bayou WWTP",               "Sims Bayou",         405, "Brays Bayou @ Martin Luther King Blvd"),
    "0189": ("southeast",                "Southeast WWTP",                "Southeast",          175, "Clear Creek @ Pearland Pkwy"),
    "0190": ("southwest",                "Southwest WWTP",                "Southwest",          460, "Brays Bayou @ Gessner Road"),
    "0498": ("tidwell_timbers",          "Tidwell Timbers WWTP",          "Tidwell Timbers",   1685, "Greens Bayou @ Tidwell Road"),
    "0201": ("turkey_creek",             "Turkey Creek WWTP",             "Turkey Creek",      2290, "Buffalo Bayou @ Dairy Ashford Road"),
    "0286": ("upper_brays",              "Upper Brays WWTP",              "Upper Brays",       2265, "Buffalo Bayou @ Piney Point Rd"),
    "0279": ("wcid_111",                 "W.C.I.D. #111 WWTP",            "WCID #111",          490, "Keegans Bayou @ Keegan Road"),
    "0225": ("wcid_47",                  "W.C.I.D. #47 WWTP",             "WCID #47",           310, "Berry Bayou @ Nevada Avenue"),
    "0485": ("wcid_76",                  "W.C.I.D. #76 WWTP",             "WCID #76",          1640, "Greens Bayou @ US 59"),
    "0237": ("west_district",            "West District WWTP",            "West District",     2280, "Rummel Creek @ Brittmoore Road"),
    "0398": ("westway_mud",              "Westway MUD WWTP",              "Westway",           2253, "Buttermilk Creek @ Moorberry Lane"),
    "0274": ("white_oak",                "White Oak WWTP",                "White Oak",          540, "White Oak Bayou @ Alabonson Road"),
    "0469": ("willowbrook",              "Willowbrook WWTP",              "Willowbrook",       1150, "Cypress Creek @ SH 249"),
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
        years = sorted(int(y) for y in (meta.get("years") or []))
        return (years[0], years[-1]) if years else (None, None)
    except Exception:
        return None, None


def process_plant(fid, df_full, start_year=None, end_year=None):
    cfg = PLANT_RAIN_CONFIG.get(fid)
    if not cfg:
        print(f"ERROR: FID {fid} not in PLANT_RAIN_CONFIG.")
        return

    slug, plant_name, polygon_id, gauge_id, gauge_label = cfg
    out_dir = OUTPUT_BASE / slug / "data"

    print(f"\n{'='*60}")
    print(f"  {plant_name}  (FID {fid}, polygon '{polygon_id}')")
    print(f"{'='*60}")

    if not out_dir.exists():
        print(f"  SKIP: output dir does not exist ({out_dir})")
        return

    df = df_full[df_full["polygon_id"] == polygon_id].copy()
    if df.empty:
        print(f"  SKIP: no data for polygon '{polygon_id}'")
        return

    df["Timestamp"] = pd.to_datetime(df["Timestamp"])
    pivot = df.pivot_table(index="Timestamp", columns="Attribute", values="Value", aggfunc="first")

    if "max_value_24h" not in pivot.columns:
        print(f"  SKIP: max_value_24h missing")
        return

    rain_col = pivot["max_value_24h"]
    freq_col = pivot.get("return_frequency_24h")

    # Keep only days with measurable rainfall
    mask = rain_col.notna() & (rain_col > 0)
    rain_col = rain_col[mask]
    if freq_col is not None:
        freq_col = freq_col[mask]

    meta_start, meta_end = get_plant_year_range(slug)
    sy = start_year if start_year is not None else meta_start
    ey = end_year if end_year is not None else meta_end

    years = sorted(rain_col.index.year.unique().tolist())
    if sy is not None:
        years = [y for y in years if y >= sy]
    if ey is not None:
        years = [y for y in years if y <= ey]

    if not years:
        print(f"  SKIP: no data in year range {sy}–{ey}")
        return

    print(f"  Years: {years[0]}–{years[-1]}  |  Total event days: {len(rain_col)}")

    for year in years:
        mask_y = rain_col.index.year == year
        rain_y = rain_col[mask_y]
        freq_y = freq_col[mask_y] if freq_col is not None else None

        timestamps = [ts.strftime("%Y-%m-%d") for ts in rain_y.index]
        rain_vals  = [safe(v) for v in rain_y.values]
        freq_vals  = [safe(v) for v in freq_y.values] if freq_y is not None else [None] * len(timestamps)

        out = {
            "plant":   plant_name,
            "fid":     fid,
            "polygon": polygon_id,
            "year":    year,
            "timestamps": timestamps,
            "rain":    rain_vals,
            "freq":    freq_vals,
        }
        if gauge_id is not None:
            out["gauge"]      = gauge_id
            out["gaugeLabel"] = gauge_label

        p = out_dir / f"rain_{year}.js"
        with open(p, "w") as f:
            f.write(
                f"window.__wwtp_rain=window.__wwtp_rain||{{}};"
                f"window.__wwtp_rain[{year}]={json.dumps(out, separators=(',', ':'))};"
            )
        print(f"    {year}: {len(timestamps):3d} event days  ({p.stat().st_size:,} bytes)")

    print("  Done.")


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--fid",  help="Single plant FID e.g. 0006")
    group.add_argument("--all",  action="store_true", help="Process all plants")
    parser.add_argument("--start-year", type=int)
    parser.add_argument("--end-year",   type=int)
    args = parser.parse_args()

    print("Loading wwar_rainfall_freq parquet from S3…")
    df = pd.read_parquet(
        S3_PARQUET,
        columns=["Timestamp", "Attribute", "Value", "polygon_id"],
        filters=[("Attribute", "in", ["max_value_24h", "return_frequency_24h"])],
    )
    print(f"  Loaded {len(df):,} rows across {df['polygon_id'].nunique()} polygons\n")

    fids = [args.fid] if args.fid else sorted(PLANT_RAIN_CONFIG.keys())
    for fid in fids:
        process_plant(fid, df, args.start_year, args.end_year)


if __name__ == "__main__":
    main()
