"""
update_plant_html.py — Batch-upgrade simple plant dashboards.
Adds: stats table, pill legend container, rain config, chart-sep-rain panel.

Usage:
    python3 update_plant_html.py
"""

import re
from pathlib import Path

BASE = Path("wwtp_dashboards")

# slug, fid, gauge_id, gauge_label
BATCH = [
    ("69th_street",     "0400", 2240, "Buffalo Bayou @ Shepherd Drive"),
    ("beltway",         "0242",  470, "Brays Bayou @ Belle Park Drive"),
    ("cedar_bayou",     "0244", 1940, "Luce Bayou @ FM"),
    ("chocolate_bayou", "0039",  360, "Sims Bayou @ Martin Luther King Road"),
    ("clinton_park",    "0040", 2210, "Buffalo Bayou @ Turning Basin"),
    ("easthaven",       "0059",  310, "Berry Bayou @ Nevada Avenue"),
    ("homestead",       "0107", 1675, "Halls Bayou @ Tidwell Road"),
    ("keegans_bayou",   "0250",  465, "Brays Bayou @ Beltway 8"),
    ("northwest",       "0145",  582, "Brickhouse Gully @ Hollister"),
    ("sagemont",        "0171",  160, "Beamer Ditch @ Hughes Road"),
]

# ── CSS blocks to add ─────────────────────────────────────────────────────────

OLD_FILTER_BAR_CSS = """\
    .filter-bar {
      display: flex; align-items: center; gap: 14px;
      padding: 14px 26px;
      border-bottom: 1px solid rgba(122,156,199,0.12);
      flex-wrap: wrap;
    }"""

NEW_FILTER_BAR_CSS = """\
    .filter-bar {
      display: flex; align-items: center;
      padding: 14px 26px;
      border-bottom: 1px solid rgba(122,156,199,0.12);
      gap: 0;
    }
    .filter-controls {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
    }
    .filter-stats {
      display: flex; align-items: center; gap: 16px;
      padding-left: 24px; margin-left: auto; flex-shrink: 0;
      border-left: 1px solid rgba(122,156,199,0.14);
    }
    .fstat-group { display: flex; flex-direction: column; gap: 5px; }
    .fstat-label {
      font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; color: #48d0c9;
    }
    .fstat-table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
    .fstat-table thead th {
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
      padding: 0 8px 3px; text-align: right;
    }
    .fstat-table thead th:first-child { text-align: left; padding-left: 0; }
    .fstat-table tbody th {
      font-size: 11px; font-weight: 600; color: var(--muted);
      padding: 1px 8px 1px 0; text-align: left; white-space: nowrap;
    }
    .fstat-table tbody td {
      font-size: 13px; color: var(--text);
      padding: 1px 8px; text-align: right;
    }
    .fstat-divider {
      width: 1px; height: 52px; align-self: center;
      background: rgba(122,156,199,0.14);
    }"""

# ── Filter bar HTML ───────────────────────────────────────────────────────────

OLD_FILTER_HTML = """\
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
  </div>"""

NEW_FILTER_HTML = """\
  <div class="filter-bar">
    <div class="filter-controls">
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
    <div class="filter-stats" id="filter-stats">
      <div class="fstat-group">
        <div class="fstat-label">Flow, MGD</div>
        <table class="fstat-table">
          <thead><tr><th></th><th>Min</th><th>Avg</th><th>Max</th></tr></thead>
          <tbody>
            <tr><th>Daily</th><td id="stat-flow-d-min">—</td><td id="stat-flow-d-mean">—</td><td id="stat-flow-d-max">—</td></tr>
            <tr><th>Weekly</th><td id="stat-flow-w-min">—</td><td id="stat-flow-w-mean">—</td><td id="stat-flow-w-max">—</td></tr>
          </tbody>
        </table>
      </div>
      <div class="fstat-divider"></div>
      <div class="fstat-group">
        <div class="fstat-label">WWL, ft</div>
        <table class="fstat-table">
          <thead><tr><th></th><th>Min</th><th>Avg</th><th>Max</th></tr></thead>
          <tbody>
            <tr><th>Daily</th><td id="stat-wwl-d-min">—</td><td id="stat-wwl-d-mean">—</td><td id="stat-wwl-d-max">—</td></tr>
            <tr><th>Weekly</th><td id="stat-wwl-w-min">—</td><td id="stat-wwl-w-mean">—</td><td id="stat-wwl-w-max">—</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>"""

# ── Chart panel snippets ──────────────────────────────────────────────────────

OLD_FLOW_PANEL = """\
      <div class="chart-panel">
        <div class="chart-panel-title">Pumps Status vs. Flow, MGD</div>
        <div id="chart-flow" class="chart-el" style="height:300px;"></div>
      </div>"""

NEW_FLOW_PANEL = """\
      <div class="chart-panel">
        <div class="chart-panel-title">Pumps Status vs. Flow, MGD</div>
        <div id="chart-flow-legend"></div>
        <div id="chart-flow" class="chart-el" style="height:280px;"></div>
      </div>"""

OLD_SEP_END = """\
      <div class="chart-panel">
        <div class="chart-panel-title">Effluent Flow, MGD</div>
        <div id="chart-sep-flow" class="chart-el" style="height:220px;"></div>
      </div>
    </div>
  </div>"""

NEW_SEP_END = """\
      <div class="chart-panel">
        <div class="chart-panel-title">Effluent Flow, MGD</div>
        <div id="chart-sep-flow" class="chart-el" style="height:220px;"></div>
      </div>
      <div class="chart-panel">
        <div class="chart-panel-title">Rainfall, in</div>
        <div id="chart-sep-rain" class="chart-el" style="height:140px;"></div>
      </div>
    </div>
  </div>"""


def add_rain_config(html, gauge, label):
    return html.replace(
        '      dataDir: "./data/",\n    };',
        f'      dataDir: "./data/",\n      rain: {{\n        gauge: {gauge},\n        label: "{label}",\n      }},\n    }};',
    )


def transform(html, gauge, label):
    assert OLD_FILTER_BAR_CSS in html,   "filter-bar CSS not found"
    assert OLD_FILTER_HTML    in html,   "filter-bar HTML not found"
    assert OLD_FLOW_PANEL     in html,   "flow panel not found"
    assert OLD_SEP_END        in html,   "sep-end not found"
    assert '      dataDir: "./data/",\n    };' in html, "PLANT_CONFIG end not found"

    html = html.replace(OLD_FILTER_BAR_CSS, NEW_FILTER_BAR_CSS)
    html = html.replace(OLD_FILTER_HTML,    NEW_FILTER_HTML)
    html = html.replace(OLD_FLOW_PANEL,     NEW_FLOW_PANEL)
    html = html.replace(OLD_SEP_END,        NEW_SEP_END)
    html = add_rain_config(html, gauge, label)
    return html


def main():
    for slug, fid, gauge, label in BATCH:
        path = BASE / slug / "index.html"
        if not path.exists():
            print(f"SKIP {slug} — index.html not found")
            continue

        original = path.read_text()

        # Skip if already updated
        if "filter-controls" in original:
            print(f"SKIP {slug} — already updated")
            continue

        try:
            updated = transform(original, gauge, label)
            path.write_text(updated)
            print(f"  OK  {slug}  (gauge {gauge})")
        except AssertionError as e:
            print(f"FAIL {slug} — {e}")


if __name__ == "__main__":
    main()
