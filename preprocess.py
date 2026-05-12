"""
preprocess.py — Generate per-year and per-month JSON files for WWTP dashboards.

Usage:
    python3 preprocess.py                    # process all plants in PLANTS list
    python3 preprocess.py --fid 0469         # process one plant by FID

Reads parquet files from LOCAL_DIR or S3 if USE_S3=True.
Writes JSON files to wwtp_dashboards/<slug>/data/
"""

import argparse
import calendar
import json
import math
import re
import sys
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq

# ── Config ────────────────────────────────────────────────────────────────────
LOCAL_DIR  = Path("/tmp")
OUTPUT_BASE = Path("wwtp_dashboards")
USE_S3     = True
S3_BUCKET  = "aventdtlkps3stg01"
S3_PREFIX  = "published/scada/summaries/archived/wwtp_wwl_pumpstatus_flow_consolidated/wwtp_flow_wwl_pumps_corrected"

# Plants with east/west split: separate wwl_east/wwl_west arrays are output alongside combined wwl.
# pump_groups defines which pump IDs belong to each side (matched against extracted PumpIDs).
EW_SPLIT = {
    "0006": {
        "east_pumps": ["AELS_DP1", "AELS_DP2", "AELS_WP1", "AELS_WP2", "AELS_WP3"],
        "west_pumps": ["ADP1", "ADP2", "AWP1", "AWP2", "AWP3"],
    },
}

# All plants: (fid, display_name, slug, pump_file_fid, pump_tag_fid, wwl_file_fid, secondary_fid)
# pump_file_fid:  overrides FID used to build the pumps parquet filename (None = same as fid)
# pump_tag_fid:   overrides FID string used to split pump tagnames (None = same as pump_file_fid or fid)
# wwl_file_fid:   overrides FID used to build the wwl parquet filename (None = same as fid)
# secondary_fid:  merges wwl + pumps from a second FID (concat before processing)
PLANTS = [
    # Priority
    ("0400", "69th Street WWTP",      "69th_street",      None,    "400",  None,   None),  # tagnames use "400" not "0400"
    ("0146", "Northeast WWTP",        "northeast",         None,    None,   None,   None),
    ("0006", "Almeda Sims WWTP",      "almeda_sims",      "0005",  "005",  None,   None),  # pump file under fid=0005; tagnames use "005"
    ("0083", "F.W.S.D. #23 WWTP",    "fwsd_23",           None,    None,   None,   None),
    ("0469", "Willowbrook WWTP",      "willowbrook",       None,    None,   None,   None),
    # Others
    ("0244", "Cedar Bayou WWTP",      "cedar_bayou",       None,    None,   None,   None),
    ("0039", "Chocolate Bayou WWTP",  "chocolate_bayou",   None,    None,   None,   None),
    ("0040", "Clinton Park WWTP",     "clinton_park",      None,    None,   None,   None),
    ("0171", "Sagemont WWTP",         "sagemont",          None,    None,   None,   None),
    ("0189", "Southeast WWTP",        "southeast",         None,    None,   None,   None),
    ("0190", "S.W. Treatment Plant",  "southwest",         None,    None,   None,   None),
    # Batch 2
    ("0183", "Sims Bayou WWTP",       "sims_bayou",        None,    None,   None,   None),
    ("0252", "Northbelt WWTP",        "northbelt",         None,    None,   None,   None),
    ("0145", "Northwest WWTP",        "northwest",         None,    None,   None,   None),
    ("0107", "Homestead WWTP",        "homestead",         None,    None,   None,   None),
    ("0059", "Easthaven WWTP",        "easthaven",         None,    None,   None,   None),
    ("0242", "Beltway WWTP",          "beltway",           None,    None,   None,   None),
    ("0237", "West District WWTP",    "west_district",     None,    None,   None,   None),
    ("0240", "Greenridge WWTP",       "greenridge",        None,    None,   None,   None),
    ("0397", "Metro Central WWTP",    "metro_central",     None,    None,   None,   None),
    ("0201", "Turkey Creek WWTP",     "turkey_creek",      None,    None,   None,   None),
    # Batch 3
    ("0268", "Imperial Valley WWTP",  "imperial_valley",   None,    None,   None,   None),
    ("0250", "Keegan's Bayou WWTP",   "keegans_bayou",     None,    None,   None,   None),
    ("0485", "W.C.I.D. #76 WWTP",    "wcid_76",           None,    None,   None,   None),
    ("0398", "Westway MUD WWTP",      "westway_mud",       None,    None,   None,   None),
    ("0451", "MC MUD #48 WWTP",       "mc_mud_48",         None,    None,   None,   None),
    # Batch 4
    ("0243", "M.U.D. #203 WWTP",     "mud_203",           None,    None,   None,   None),
    ("0274", "White Oak WWTP",        "white_oak",         None,    None,   None,   None),
    ("0245", "Park Ten WWTP",         "park_ten",          None,    None,   None,   None),
    ("0238", "Intercontinental Airport WWTP", "intercontinental_airport", None, None, None, None),
    ("0225", "W.C.I.D. #47 WWTP",    "wcid_47",           None,    None,   None,   None),
    # Batch 5
    ("0279", "W.C.I.D. #111 WWTP",   "wcid_111",          None,    None,   None,   None),
    ("0286", "Upper Brays WWTP",      "upper_brays",       None,    None,   None,   None),
    ("0270", "Northgate WWTP",        "northgate",         None,    None,   None,   None),
    ("0498", "Tidwell Timbers WWTP",  "tidwell_timbers",  "0499",  None,  "0499",  None),  # pump + wwl under FID 0499
    ("0283", "Sims Bayou-South WWTP", "sims_bayou_south",  None,    None,   None,   None),
    ("0565", "Forest Cove WWTP",      "forest_cove",       None,    None,   None,  "0566"),  # wwl + pumps split across 0565 + 0566
]
# ─────────────────────────────────────────────────────────────────────────────


def safe(v):
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else round(f, 4)
    except Exception:
        return None


def extract_pump_id(tagname, fid):
    parts = tagname.split(fid, 1)
    if len(parts) < 2:
        return tagname
    return parts[1].lstrip("_").replace(".F_CV", "").replace("_RUN", "").strip()


def parquet_path(fid, kind):
    fname = f"fid={fid}_wwtp_historical_combined_{kind}.parquet"
    if USE_S3:
        return f"s3://{S3_BUCKET}/{S3_PREFIX}/{fname}"
    return str(LOCAL_DIR / fname)


def read_parquet(fid, kind):
    path = parquet_path(fid, kind)
    try:
        df = pq.read_table(path).to_pandas()
    except Exception:
        # Some plants (e.g. Almeda Sims) split into _east/_west files
        east = pq.read_table(parquet_path(fid, kind + "_east")).to_pandas()
        west = pq.read_table(parquet_path(fid, kind + "_west")).to_pandas()
        df = pd.concat([east, west], ignore_index=True)
    df["Timestamp"] = pd.to_datetime(df["Timestamp"], utc=False).dt.tz_localize(None)
    return df


def read_parquet_sides(fid, kind):
    """Read east and west parquet files separately. Returns (df_east, df_west)."""
    def load(suffix):
        df = pq.read_table(parquet_path(fid, kind + suffix)).to_pandas()
        df["Timestamp"] = pd.to_datetime(df["Timestamp"], utc=False).dt.tz_localize(None)
        return df
    return load("_east"), load("_west")


def process_plant(fid, plant_name, slug, pump_file_fid=None, pump_tag_fid=None, wwl_file_fid=None, secondary_fid=None):
    out_dir = OUTPUT_BASE / slug / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    pfid  = pump_file_fid or fid           # FID used for the pumps parquet filename
    ptfid = pump_tag_fid  or pfid          # FID string used to split pump tagnames
    wfid  = wwl_file_fid  or fid           # FID used for the wwl parquet filename

    print(f"\n{'='*60}")
    print(f"  {plant_name}  (FID {fid})")
    print(f"{'='*60}")

    ew = EW_SPLIT.get(fid)

    print("  Reading parquet files…")
    df_flow  = read_parquet(fid,  "flow").rename(columns={"Value": "Flow_MGD"})
    df_pumps = read_parquet(pfid, "pumps").rename(columns={"Value": "Pumps_status"})
    df_pumps["PumpID"] = df_pumps["Tagname"].apply(lambda t: extract_pump_id(t, ptfid))
    df_wwl   = read_parquet(wfid, "wwl").rename(columns={"Value": "WWL_ft"})

    if ew:
        df_wwl_east, df_wwl_west = read_parquet_sides(wfid, "wwl")
        df_wwl_east = df_wwl_east.rename(columns={"Value": "WWL_ft"})
        df_wwl_west = df_wwl_west.rename(columns={"Value": "WWL_ft"})

    if secondary_fid:
        df_pumps2 = read_parquet(secondary_fid, "pumps").rename(columns={"Value": "Pumps_status"})
        df_pumps2["PumpID"] = df_pumps2["Tagname"].apply(lambda t: extract_pump_id(t, secondary_fid))
        df_pumps = pd.concat([df_pumps, df_pumps2], ignore_index=True)
        try:
            df_wwl2 = read_parquet(secondary_fid, "wwl").rename(columns={"Value": "WWL_ft"})
            df_wwl = pd.concat([df_wwl, df_wwl2], ignore_index=True)
        except Exception:
            pass

    # Pumps: deduplicate
    df_pumps = df_pumps.sort_values("Tagname").drop_duplicates(
        subset=["Timestamp", "PumpID"], keep="last"
    )

    # ── Hourly series ─────────────────────────────────────────────────────────
    flow_h = df_flow.set_index("Timestamp")["Flow_MGD"].resample("1h").mean()
    wwl_h  = df_wwl.set_index("Timestamp")["WWL_ft"].resample("1h").mean()
    if ew:
        wwl_east_h = df_wwl_east.set_index("Timestamp")["WWL_ft"].resample("1h").mean()
        wwl_west_h = df_wwl_west.set_index("Timestamp")["WWL_ft"].resample("1h").mean()

    pump_pivot   = df_pumps.pivot_table(
        index="Timestamp", columns="PumpID", values="Pumps_status", aggfunc="sum"
    )
    pump_pivot_h = pump_pivot.resample("1h").max()
    pump_ids     = sorted(pump_pivot_h.columns.tolist())
    print(f"  Pump IDs: {pump_ids}")

    all_years = sorted(set(
        flow_h.index.year.tolist()
        + wwl_h.index.year.tolist()
        + pump_pivot_h.index.year.tolist()
    ))
    print(f"  Years: {all_years}")

    # ── Per-year JS ───────────────────────────────────────────────────────────
    print("  Writing yearly files…")
    for year in all_years:
        idx    = pd.date_range(f"{year}-01-01", f"{year}-12-31 23:00", freq="1h")
        flow_y = flow_h.reindex(idx)
        wwl_y  = wwl_h.reindex(idx)
        pump_y = pump_pivot_h.reindex(idx)

        pump_data = {}
        for pid in pump_ids:
            col = pump_y[pid] if pid in pump_y.columns else pd.Series([None] * len(idx))
            pump_data[pid] = [safe(v) for v in col.values]

        out = {
            "plant": plant_name, "fid": fid, "year": year,
            "pumps": pump_ids,
            "timestamps": [ts.strftime("%Y-%m-%d %H:%M") for ts in idx],
            "flow": [safe(v) for v in flow_y.values],
            "wwl":  [safe(v) for v in wwl_y.values],
            "pump_status": pump_data,
        }
        if ew:
            out["wwl_east"] = [safe(v) for v in wwl_east_h.reindex(idx).values]
            out["wwl_west"] = [safe(v) for v in wwl_west_h.reindex(idx).values]
        p = out_dir / f"{year}.js"
        with open(p, "w") as f:
            f.write(f"window.__wwtp_year=window.__wwtp_year||{{}};window.__wwtp_year[{year}]={json.dumps(out, separators=(',', ':'))};")
        print(f"    {year}: {p.stat().st_size//1024} KB")

    # ── Minute-level series ───────────────────────────────────────────────────
    flow_min = df_flow.set_index("Timestamp")["Flow_MGD"].resample("1min").mean()
    wwl_min  = df_wwl.set_index("Timestamp")["WWL_ft"].resample("1min").mean()
    if ew:
        wwl_east_min = df_wwl_east.set_index("Timestamp")["WWL_ft"].resample("1min").mean()
        wwl_west_min = df_wwl_west.set_index("Timestamp")["WWL_ft"].resample("1min").mean()
    pump_min = df_pumps.pivot_table(
        index="Timestamp", columns="PumpID", values="Pumps_status", aggfunc="last"
    ).resample("1min").last()

    # ── Per-month minute JS ───────────────────────────────────────────────────
    print("  Writing monthly minute files…")
    months_present = sorted(set(
        zip(pump_min.index.year, pump_min.index.month)
    ))
    for year, month in months_present:
        days = calendar.monthrange(year, month)[1]
        idx  = pd.date_range(
            f"{year}-{month:02d}-01",
            f"{year}-{month:02d}-{days:02d} 23:59",
            freq="1min"
        )
        flow_m = flow_min.reindex(idx)
        wwl_m  = wwl_min.reindex(idx)
        pump_m = pump_min.reindex(idx)

        active = [
            p for p in pump_m.columns
            if pump_m[p].notna().any() and (pump_m[p] > 0).any()
        ]

        out = {
            "year": year, "month": month, "pumps": active,
            "timestamps": [ts.strftime("%Y-%m-%d %H:%M") for ts in idx],
            "flow": [safe(v) for v in flow_m.values],
            "wwl":  [safe(v) for v in wwl_m.values],
            "pump_status": {p: [safe(v) for v in pump_m[p].values] for p in active},
        }
        if ew:
            out["wwl_east"] = [safe(v) for v in wwl_east_min.reindex(idx).values]
            out["wwl_west"] = [safe(v) for v in wwl_west_min.reindex(idx).values]
        key = f"{year}_{month:02d}"
        p = out_dir / f"{key}_min.js"
        with open(p, "w") as f:
            f.write(f"window.__wwtp_min=window.__wwtp_min||{{}};window.__wwtp_min[\"{key}\"]={json.dumps(out, separators=(',', ':'))};")

    print(f"  Monthly files: {len(months_present)}")

    # ── meta.js + meta.json (meta.json kept for preprocess.py's landing page) ──
    meta = {"plant": plant_name, "fid": fid, "years": all_years, "pumps": pump_ids}
    if ew:
        meta["pump_groups"] = {"east": ew["east_pumps"], "west": ew["west_pumps"]}
    with open(out_dir / "meta.json", "w") as f:
        json.dump(meta, f, indent=2)
    with open(out_dir / "meta.js", "w") as f:
        f.write(f"window.__wwtp_meta={json.dumps(meta, separators=(',', ':'))};")

    print(f"  Done.")
    return {"fid": fid, "name": plant_name, "slug": slug, "years": all_years}


def make_plant_html(fid, plant_name, slug):
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{plant_name} Dashboard</title>
  <link rel="stylesheet" href="../styles.css" />
  <style>
    .filter-bar {{
      display: flex; align-items: center; gap: 14px;
      padding: 14px 26px;
      border-bottom: 1px solid rgba(122,156,199,0.12);
      flex-wrap: wrap;
    }}
    .filter-bar label {{
      display: flex; align-items: center; gap: 8px;
      color: var(--muted); font-size: 14px; font-weight: 600;
    }}
    .filter-bar select {{
      height: 36px; border-radius: 8px;
      border: 1px solid rgba(108,143,186,0.36);
      background: #102032; color: var(--text);
      padding: 0 10px; font: inherit; font-size: 14px; min-width: 110px;
    }}
    .multi-select {{ position: relative; display: inline-block; }}
    .ms-trigger {{
      height: 36px; border-radius: 8px;
      border: 1px solid rgba(108,143,186,0.36);
      background: #102032; color: var(--text);
      padding: 0 10px; font: inherit; font-size: 14px; min-width: 110px;
      cursor: pointer; text-align: left; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 180px;
    }}
    .ms-trigger:hover {{ border-color: rgba(108,143,186,0.6); }}
    .ms-panel {{
      display: none; position: absolute; top: calc(100% + 2px); left: 0;
      min-width: 100%; max-height: 200px; overflow-y: auto;
      background: #102032; border: 1px solid rgba(108,143,186,0.36);
      border-radius: 8px; padding: 4px 0; z-index: 200;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    }}
    .multi-select.open .ms-panel {{ display: block; }}
    .ms-item {{
      padding: 6px 12px; cursor: pointer; font-size: 14px; color: var(--text);
      white-space: nowrap; user-select: none;
    }}
    .ms-item:hover {{ background: rgba(93,168,255,0.1); }}
    .ms-item.ms-sel {{ color: #48d0c9; }}
    .ms-item.ms-sel::before {{ content: "✓  "; }}
    .ms-sep {{ height: 1px; background: rgba(122,156,199,0.2); margin: 3px 8px; }}
    .filter-bar .reset-btn {{
      height: 36px; padding: 0 16px; margin-top: 0;
      width: auto; border-radius: 8px; font-size: 13px;
    }}
    .charts-wrap {{
      padding: 16px 18px 24px;
      display: flex; flex-direction: column; gap: 14px;
    }}
    .chart-panel {{
      background: linear-gradient(180deg, rgba(26,39,57,0.96), rgba(20,31,47,0.96));
      border: 1px solid var(--border); border-radius: 16px;
      padding: 12px 14px 10px; box-shadow: var(--shadow);
    }}
    .chart-panel-title {{
      font-size: 14px; font-weight: 700;
      color: rgba(221,232,244,0.9); margin-bottom: 6px;
    }}
    .chart-el {{ width: 100%; display: block; }}
    #loading-msg, #status-msg {{
      display: none; padding: 18px 26px;
      color: var(--muted); font-size: 14px;
    }}
    .back-link {{
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--muted); font-size: 13px; text-decoration: none;
      padding: 0 26px 12px;
    }}
    .back-link:hover {{ color: var(--text); }}
  </style>
</head>
<body>

  <div class="topbar">
    <div>
      <h1 id="plant-title">{plant_name}</h1>
      <p id="plant-fid" style="margin:4px 0 0; color:var(--muted); font-size:15px;">FID: {fid} · WWLevel, Effluent Flow &amp; Pump Status</p>
    </div>
    <div class="topbar-actions">
      <span class="version-pill"><span class="pill-dot"></span>SCADA Historical</span>
    </div>
  </div>

  <a class="back-link" href="../index.html">← All Plants</a>

  <div class="filter-bar">
    <label>Year
      <div class="multi-select" id="ms-year">
        <button class="ms-trigger" type="button">Year ▾</button>
        <div class="ms-panel"></div>
      </div>
    </label>
    <label>Month
      <div class="multi-select" id="ms-month">
        <button class="ms-trigger" type="button">All Months ▾</button>
        <div class="ms-panel"></div>
      </div>
    </label>
    <label>Day
      <div class="multi-select" id="ms-day">
        <button class="ms-trigger" type="button">All Days ▾</button>
        <div class="ms-panel"></div>
      </div>
    </label>
    <label>Week
      <div class="multi-select" id="ms-week">
        <button class="ms-trigger" type="button">All Weeks ▾</button>
        <div class="ms-panel"></div>
      </div>
    </label>
    <button id="btn-reset" class="reset-btn">Reset</button>
  </div>

  <div class="subtabs">
    <button class="subtab active" data-tab="combined">Combined</button>
    <button class="subtab" data-tab="separate">Separate</button>
  </div>

  <div id="loading-msg">Loading data…</div>
  <div id="status-msg"></div>

  <div id="tab-combined" class="tab-pane active">
    <div class="charts-wrap">
      <div class="chart-panel">
        <div class="chart-panel-title">Pumps Status vs. Flow, MGD</div>
        <div id="chart-flow" class="chart-el" style="height:300px;"></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Pumps Status vs. Wet Well Level, ft</div>
        <div id="chart-wwl" class="chart-el" style="height:300px;"></div>
      </div>
    </div>
  </div>

  <div id="tab-separate" class="tab-pane">
    <div class="charts-wrap">
      <div class="chart-panel">
        <div class="chart-panel-title">Pump Status</div>
        <div id="chart-sep-pumps" class="chart-el" style="height:280px;"></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Wet Well Level, ft</div>
        <div id="chart-sep-wwl" class="chart-el" style="height:220px;"></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Effluent Flow, MGD</div>
        <div id="chart-sep-flow" class="chart-el" style="height:220px;"></div>
      </div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  <script>
    const PLANT_CONFIG = {{
      name:    "{plant_name}",
      fid:     "{fid}",
      dataDir: "./data/",
    }};
  </script>
  <script src="../dashboard.js"></script>
</body>
</html>
"""
    plant_dir = OUTPUT_BASE / slug
    plant_dir.mkdir(parents=True, exist_ok=True)
    (plant_dir / "data").mkdir(exist_ok=True)
    with open(plant_dir / "index.html", "w") as f:
        f.write(html)


NO_DATA_PLANTS = [
    {"fid": "0518", "name": "Kingwood Central WWTP",  "reason": "No pump or wet well level data available in SCADA."},
    {"fid": "0627", "name": "West Lake Houston TP",    "reason": "No pump or wet well level data available in SCADA."},
]


def make_landing_page(plant_infos):
    cards = ""
    for p in plant_infos:
        year_range = f"{p['years'][0]}–{p['years'][-1]}" if p['years'] else "N/A"
        cards += f"""
      <a class="plant-card" href="./{p['slug']}/index.html">
        <div class="plant-card-fid">FID {p['fid']}</div>
        <div class="plant-card-name">{p['name']}</div>
        <div class="plant-card-meta">{year_range}</div>
      </a>"""

    no_data_cards = ""
    for p in NO_DATA_PLANTS:
        no_data_cards += f"""
      <div class="plant-card plant-card--no-data">
        <div class="plant-card-fid">FID {p['fid']}</div>
        <div class="plant-card-name">{p['name']}</div>
        <div class="plant-card-meta">{p['reason']}</div>
      </div>"""

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Houston WWTP Dashboards</title>
  <link rel="stylesheet" href="./styles.css" />
  <style>
    .landing-header {{
      padding: 32px 32px 24px;
      border-bottom: 1px solid rgba(122,156,199,0.12);
    }}
    .landing-header h1 {{ margin: 0; font-size: 32px; font-weight: 700; }}
    .landing-header p  {{ margin: 8px 0 0; color: var(--muted); font-size: 15px; }}
    .plant-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 16px;
      padding: 28px 32px;
    }}
    .plant-card {{
      display: block; text-decoration: none;
      background: linear-gradient(180deg, rgba(26,39,57,0.96), rgba(20,31,47,0.96));
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 22px 22px 18px;
      box-shadow: var(--shadow);
      transition: border-color 0.18s, transform 0.18s;
    }}
    .plant-card:hover {{
      border-color: rgba(72,208,201,0.5);
      transform: translateY(-2px);
    }}
    .plant-card--no-data {{
      opacity: 0.45;
      cursor: default;
    }}
    .plant-card--no-data:hover {{
      border-color: var(--border);
      transform: none;
    }}
    .plant-card-fid {{
      font-size: 12px; font-weight: 700; letter-spacing: 0.06em;
      color: #48d0c9; margin-bottom: 8px; text-transform: uppercase;
    }}
    .plant-card-name {{
      font-size: 18px; font-weight: 700; color: var(--text); margin-bottom: 10px;
    }}
    .plant-card-meta {{
      font-size: 13px; color: var(--muted);
    }}
    .no-data-section {{
      padding: 0 32px 32px;
    }}
    .no-data-section h2 {{
      font-size: 13px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
      margin: 0 0 14px; padding-top: 8px;
      border-top: 1px solid rgba(122,156,199,0.12);
    }}
  </style>
</head>
<body>
  <div class="landing-header">
    <h1>Houston WWTP Dashboards</h1>
    <p>SCADA Historical · WWLevel, Effluent Flow &amp; Pump Status</p>
  </div>
  <div class="plant-grid">{cards}
  </div>
  <div class="no-data-section">
    <h2>No SCADA Data Available</h2>
    <div class="plant-grid" style="padding:0;">{no_data_cards}
    </div>
  </div>
</body>
</html>
"""
    with open(OUTPUT_BASE / "index.html", "w") as f:
        f.write(html)


# ── Main ──────────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--fid", help="Process only this FID")
args = parser.parse_args()

plants_to_run = [p for p in PLANTS if not args.fid or p[0] == args.fid]

results = []
for fid, name, slug, pump_file_fid, pump_tag_fid, wwl_file_fid, secondary_fid in plants_to_run:
    make_plant_html(fid, name, slug)
    try:
        info = process_plant(fid, name, slug, pump_file_fid=pump_file_fid, pump_tag_fid=pump_tag_fid, wwl_file_fid=wwl_file_fid, secondary_fid=secondary_fid)
        results.append(info)
    except Exception as e:
        print(f"  ERROR processing {name}: {e}")
        results.append({"fid": fid, "name": name, "slug": slug, "years": []})

# Rebuild landing page with all known plants
all_plant_meta = []
for fid, name, slug, pump_file_fid, pump_tag_fid, wwl_file_fid, secondary_fid in PLANTS:
    meta_path = OUTPUT_BASE / slug / "data" / "meta.json"
    if meta_path.exists():
        with open(meta_path) as f:
            m = json.load(f)
        all_plant_meta.append({"fid": fid, "name": name, "slug": slug, "years": m["years"]})
    else:
        all_plant_meta.append({"fid": fid, "name": name, "slug": slug, "years": []})

make_landing_page(all_plant_meta)
print("\nLanding page written.")
print("Done.")
