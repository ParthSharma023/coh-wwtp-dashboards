/* dashboard.js — shared WWTP chart logic
 * Requires PLANT_CONFIG = { name, fid, dataDir } defined before this script.
 * Requires ECharts 5 loaded before this script.
 */
(function () {
  "use strict";

  const PUMP_COLORS = [
    "#5da8ff", "#66bb6a", "#e6a52e", "#d46b2d",
    "#cf4336", "#9b7fd4", "#74c6ea", "#6fd9cb",
    "#f4c26b", "#e89c76",
  ];
  const FLOW_COLOR = "#f1f5fb";
  const FLOW_MAX_COLOR = "rgba(241,245,251,0.72)";
  const WWL_COLOR = "#6ee7a0";
  const WWL_MAX_COLOR = "rgba(110,231,160,0.78)";
  const RAIN_COLOR = "#48d0c9";
  const AXIS_COLOR = "rgba(180,192,208,0.45)";
  const SPLIT_COLOR = "rgba(180,192,208,0.07)";
  const TIP_BG = "#17273a";
  const TIP_BORDER = "rgba(122,156,199,0.28)";
  const DASHED_LINE = [6, 4];

  let meta = null;
  let yearData = null;
  let rainYearData = null;
  let minuteCache = {};
  let rainMinuteCache = {};
  let charts = {};
  let legendState = null;
  let selectedRainGauge = null;
  let selectedSide = PLANT_CONFIG.pumpGroups ? "east" : null;

  const sel = { years: [], months: [], days: [], weeks: [], gauges: [], includeRain: false };
  let msYear = null;
  let msMonth = null;
  let msDay = null;
  let msWeek = null;
  let msGauge = null;

  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function createMultiSelect(id, placeholder, onChange, opts) {
    opts = opts || {};
    const showAll = opts.showAll || false;
    const minSelected = opts.minSelected || 0;

    const el = document.getElementById(id);
    if (!el) return null;
    const trigger = el.querySelector(".ms-trigger");
    const panel = el.querySelector(".ms-panel");
    let selected = [];
    let options = [];

    trigger.addEventListener("click", e => {
      e.stopPropagation();
      document.querySelectorAll(".multi-select.open").forEach(ms => {
        if (ms !== el) ms.classList.remove("open");
      });
      el.classList.toggle("open");
    });
    document.addEventListener("click", () => el.classList.remove("open"));

    function renderTrigger() {
      const arrow = " ▾";
      if (!selected.length) {
        trigger.textContent = placeholder + arrow;
      } else if (selected.length <= 2) {
        trigger.textContent = selected.map(v => (options.find(o => o.value === v) || {}).label || v).join(", ") + arrow;
      } else {
        trigger.textContent = selected.length + " selected" + arrow;
      }
    }

    function renderPanel() {
      panel.innerHTML = "";

      if (showAll) {
        const allItem = document.createElement("div");
        allItem.className = "ms-item" + (!selected.length ? " ms-sel" : "");
        allItem.textContent = "All";
        allItem.addEventListener("click", e => {
          e.stopPropagation();
          selected = [];
          el.classList.remove("open");
          renderPanel();
          onChange(selected);
        });
        panel.appendChild(allItem);
        const sep = document.createElement("div");
        sep.className = "ms-sep";
        panel.appendChild(sep);
      }

      options.forEach(opt => {
        const isSel = selected.includes(opt.value);
        const item = document.createElement("div");
        item.className = "ms-item" + (isSel ? " ms-sel" : "");
        item.textContent = opt.label;
        item.addEventListener("click", e => {
          e.stopPropagation();
          const nowSel = selected.includes(opt.value);
          if (e.ctrlKey || e.metaKey) {
            if (nowSel && selected.length <= minSelected) return;
            selected = nowSel ? selected.filter(v => v !== opt.value) : [...selected, opt.value];
          } else {
            selected = (nowSel && selected.length === 1) ? [] : [opt.value];
            el.classList.remove("open");
          }
          renderPanel();
          onChange(selected);
        });
        panel.appendChild(item);
      });
      renderTrigger();
    }

    return {
      setOptions(nextOptions) {
        options = nextOptions;
        selected = selected.filter(v => options.some(opt => opt.value === v));
        renderPanel();
      },
      setSelected(vals) {
        selected = vals;
        renderPanel();
      },
      getSelected() {
        return [...selected];
      },
      clear() {
        selected = [];
        renderPanel();
      },
    };
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const avg = arr => {
    const vals = arr.filter(v => v != null);
    return vals.length ? vals.reduce((sum, value) => sum + value, 0) / vals.length : null;
  };

  const sum = arr => {
    const vals = arr.filter(v => v != null);
    return vals.length ? vals.reduce((total, value) => total + value, 0) : null;
  };

  const maxVal = arr => {
    const vals = arr.filter(v => v != null);
    return vals.length ? Math.max(...vals) : null;
  };

  const minVal = arr => {
    const vals = arr.filter(v => v != null);
    return vals.length ? Math.min(...vals) : null;
  };

  function stablePumpColor(pump) {
    const ref = PLANT_CONFIG.pumpGroups
      ? (PLANT_CONFIG.pumpGroups[selectedSide] || (yearData && yearData.pumps) || [])
      : ((yearData && yearData.pumps) || []);
    const idx = ref.indexOf(pump);
    return PUMP_COLORS[(idx >= 0 ? idx : 0) % PUMP_COLORS.length];
  }

  const hasRain = () => !!(PLANT_CONFIG.rain && (PLANT_CONFIG.rain.gauges || PLANT_CONFIG.rain.polygon || PLANT_CONFIG.rain.gauge));
  const isMultiGauge = () => !!(PLANT_CONFIG.rain && PLANT_CONFIG.rain.gauges);
  const isPolygonRain = () => !!(PLANT_CONFIG.rain && PLANT_CONFIG.rain.polygon);
  const rainEnabled = () => isPolygonRain()
    ? sel.includeRain
    : (!hasRain() || isMultiGauge() || sel.gauges.includes(PLANT_CONFIG.rain.gauge));
  const showRainOverlay = () => hasRain() && sel.includeRain;
  const hasSingleYear = () => sel.years.length === 1;

  function isoWeek(ts) {
    const d = new Date(ts.length === 10 ? ts + "T00:00" : ts.replace(" ", "T"));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - y) / 86400000) + 1) / 7);
  }

  function isoWeekInfo(ts) {
    const d = new Date(ts.length === 10 ? ts + "T00:00" : ts.replace(" ", "T"));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const isoYear = d.getUTCFullYear();
    const y = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((d - y) / 86400000) + 1) / 7);
    return {
      year: isoYear,
      week,
      key: `${isoYear}-W${String(week).padStart(2, "0")}`,
    };
  }

  function fmtLabel(ts, granularity) {
    const month = +ts.substring(5, 7) - 1;
    const day = +ts.substring(8, 10);
    if (granularity === "daily") return `${MO[month]} ${day}`;
    return `${MO[month]} ${day} ${ts.substring(11, 16)}`;
  }

  function fmtAxisValue(value, granularity) {
    if (typeof value === "string") return fmtLabel(value, granularity || "hourly");
    return String(value);
  }

  function floorToFiveMinute(ts) {
    if (!ts || ts.length < 16) return ts;
    const prefix = ts.substring(0, 14);
    const minute = +ts.substring(14, 16);
    return prefix + String(Math.floor(minute / 5) * 5).padStart(2, "0");
  }

  function normalizeYearDataset(dataset) {
    if (!dataset) return null;
    const norm = {
      plant: dataset.plant,
      fid: dataset.fid,
      year: dataset.year,
      pumps: dataset.pumps || [],
      timestamps: dataset.timestamps || [],
      flow_mean: dataset.flow_mean || dataset.flow || [],
      flow_min: dataset.flow_min || dataset.flow || [],
      flow_max: dataset.flow_max || dataset.flow || [],
      flow_count: dataset.flow_count || (dataset.flow || []).map(v => (v == null ? 0 : 1)),
      wwl_mean: dataset.wwl_mean || dataset.wwl || [],
      wwl_min: dataset.wwl_min || dataset.wwl || [],
      wwl_max: dataset.wwl_max || dataset.wwl || [],
      wwl_count: dataset.wwl_count || (dataset.wwl || []).map(v => (v == null ? 0 : 1)),
      pump_status: dataset.pump_status || {},
    };

    if (dataset.wwl_east_mean || dataset.wwl_east || dataset.wwl_east_max) {
      norm.wwl_east_mean = dataset.wwl_east_mean || dataset.wwl_east || [];
      norm.wwl_east_min = dataset.wwl_east_min || dataset.wwl_east || [];
      norm.wwl_east_max = dataset.wwl_east_max || dataset.wwl_east || [];
      norm.wwl_east_count = dataset.wwl_east_count || norm.wwl_east_mean.map(v => (v == null ? 0 : 1));
      norm.wwl_west_mean = dataset.wwl_west_mean || dataset.wwl_west || [];
      norm.wwl_west_min = dataset.wwl_west_min || dataset.wwl_west || [];
      norm.wwl_west_max = dataset.wwl_west_max || dataset.wwl_west || [];
      norm.wwl_west_count = dataset.wwl_west_count || norm.wwl_west_mean.map(v => (v == null ? 0 : 1));
    }

    return norm;
  }

  function mergeMetricSeries(datasets, key) {
    return datasets.flatMap(d => d[key] || new Array(d.timestamps.length).fill(null));
  }

  function mergeYearData(years) {
    const datasets = years
      .map(year => window.__wwtp_year && window.__wwtp_year[year])
      .filter(Boolean)
      .map(normalizeYearDataset);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];

    const allPumps = [...new Set(datasets.flatMap(d => d.pumps))].sort();
    const merged = {
      plant: datasets[0].plant,
      fid: datasets[0].fid,
      pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow_mean: mergeMetricSeries(datasets, "flow_mean"),
      flow_min: mergeMetricSeries(datasets, "flow_min"),
      flow_max: mergeMetricSeries(datasets, "flow_max"),
      flow_count: mergeMetricSeries(datasets, "flow_count"),
      wwl_mean: mergeMetricSeries(datasets, "wwl_mean"),
      wwl_min: mergeMetricSeries(datasets, "wwl_min"),
      wwl_max: mergeMetricSeries(datasets, "wwl_max"),
      wwl_count: mergeMetricSeries(datasets, "wwl_count"),
      pump_status: Object.fromEntries(
        allPumps.map(pump => [
          pump,
          datasets.flatMap(d => d.pump_status[pump] || new Array(d.timestamps.length).fill(null)),
        ])
      ),
    };

    if (datasets.some(d => d.wwl_east_mean)) {
      merged.wwl_east_mean = mergeMetricSeries(datasets, "wwl_east_mean");
      merged.wwl_east_min = mergeMetricSeries(datasets, "wwl_east_min");
      merged.wwl_east_max = mergeMetricSeries(datasets, "wwl_east_max");
      merged.wwl_east_count = mergeMetricSeries(datasets, "wwl_east_count");
      merged.wwl_west_mean = mergeMetricSeries(datasets, "wwl_west_mean");
      merged.wwl_west_min = mergeMetricSeries(datasets, "wwl_west_min");
      merged.wwl_west_max = mergeMetricSeries(datasets, "wwl_west_max");
      merged.wwl_west_count = mergeMetricSeries(datasets, "wwl_west_count");
    }

    return merged;
  }

  function mergeRainYears(years) {
    const datasets = years.map(year => window.__wwtp_rain && window.__wwtp_rain[year]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return {
      ...datasets[0],
      timestamps: datasets.flatMap(d => d.timestamps),
      rain:       datasets.flatMap(d => d.rain),
      freq:       datasets[0].freq ? datasets.flatMap(d => d.freq || []) : null,
    };
  }

  async function loadRainYears(years) {
    if (!hasRain()) {
      rainYearData = null;
      return;
    }
    if (isMultiGauge()) {
      const gauge = selectedRainGauge || PLANT_CONFIG.rain.gauges[0].id;
      const ns = `__wwtp_rain_g${gauge}`;
      for (const year of years) {
        if (!window[ns] || !window[ns][year]) {
          try {
            await loadScript(PLANT_CONFIG.dataDir + `rain_g${gauge}_${year}.js`);
          } catch (e) {}
        }
      }
      rainYearData = mergeRainYearsGauge(years, ns);
    } else {
      for (const year of years) {
        if (!window.__wwtp_rain || !window.__wwtp_rain[year]) {
          try {
            await loadScript(PLANT_CONFIG.dataDir + "rain_" + year + ".js");
          } catch (e) {}
        }
      }
      rainYearData = mergeRainYears(years);
    }
  }

  function mergeRainYearsGauge(years, ns) {
    const datasets = years.map(year => window[ns] && window[ns][year]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return {
      ...datasets[0],
      timestamps: datasets.flatMap(d => d.timestamps),
      rain:       datasets.flatMap(d => d.rain),
    };
  }

  async function loadYears(years) {
    setLoading(true);
    hideStatus();
    try {
      for (const year of years) {
        if (!window.__wwtp_year || !window.__wwtp_year[year]) {
          await loadScript(PLANT_CONFIG.dataDir + year + ".js");
        }
      }
      const data = mergeYearData(years);
      if (!data) throw new Error("No yearly data found");
      yearData = data;
      legendState = null;
      await loadRainYears(years);
      sel.months = [];
      sel.days = [];
      sel.weeks = [];
      if (msMonth) msMonth.clear();
      if (msDay) msDay.clear();
      if (msWeek) msWeek.clear();
      populateMonths();
      updateDayOptions([], [], false);
      populateWeeks([]);
      renderActive();
    } catch (e) {
      setStatus("No data for selected years");
    } finally {
      setLoading(false);
    }
  }

  async function loadMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2, "0")}`;
    if (minuteCache[key]) return minuteCache[key];
    if (minuteCache[key + "_loading"]) return null;
    minuteCache[key + "_loading"] = true;
    try {
      await loadScript(PLANT_CONFIG.dataDir + key + "_min.js");
      const data = window.__wwtp_min && window.__wwtp_min[key];
      if (data) minuteCache[key] = data;
      return data || null;
    } catch (e) {
      return null;
    } finally {
      delete minuteCache[key + "_loading"];
    }
  }

  async function loadRainMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2, "0")}`;
    if (rainMinuteCache[key]) return rainMinuteCache[key];
    if (rainMinuteCache[key + "_loading"]) return null;
    rainMinuteCache[key + "_loading"] = true;
    try {
      if (isMultiGauge()) {
        const gauge = selectedRainGauge || PLANT_CONFIG.rain.gauges[0].id;
        const ns = `__wwtp_rain_g${gauge}_min`;
        await loadScript(PLANT_CONFIG.dataDir + `rain_g${gauge}_${key}_min.js`);
        const data = window[ns] && window[ns][key];
        if (data) rainMinuteCache[key] = data;
        return data || null;
      }
      await loadScript(PLANT_CONFIG.dataDir + "rain_" + key + "_min.js");
      const data = window.__wwtp_rain_min && window.__wwtp_rain_min[key];
      if (data) rainMinuteCache[key] = data;
      return data || null;
    } catch (e) {
      return null;
    } finally {
      delete rainMinuteCache[key + "_loading"];
    }
  }

  function mergeMinuteData(keys) {
    const datasets = keys.map(key => minuteCache[key]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];

    const allPumps = [...new Set(datasets.flatMap(d => d.pumps || []))].sort();
    const merged = {
      year: datasets[0].year,
      month: null,
      pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow: datasets.flatMap(d => d.flow),
      wwl: datasets.flatMap(d => d.wwl),
      pump_status: Object.fromEntries(
        allPumps.map(pump => [
          pump,
          datasets.flatMap(d => d.pump_status[pump] || new Array(d.timestamps.length).fill(null)),
        ])
      ),
    };

    if (datasets.some(d => d.wwl_east)) {
      merged.wwl_east = datasets.flatMap(d => d.wwl_east || new Array(d.timestamps.length).fill(null));
      merged.wwl_west = datasets.flatMap(d => d.wwl_west || new Array(d.timestamps.length).fill(null));
    }

    return merged;
  }

  function mergeRainMinuteData(keys) {
    const datasets = keys.map(key => rainMinuteCache[key]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return {
      gauge: datasets[0].gauge,
      timestamps: datasets.flatMap(d => d.timestamps),
      rain: datasets.flatMap(d => d.rain),
    };
  }

  function setLoading(on) {
    const el = document.getElementById("loading-msg");
    if (el) el.style.display = on ? "block" : "none";
  }

  function setStatus(msg) {
    const el = document.getElementById("status-msg");
    if (!el) return;
    el.textContent = msg;
    el.style.display = "block";
  }

  function hideStatus() {
    const el = document.getElementById("status-msg");
    if (el) el.style.display = "none";
  }

  function getResolutionMode() {
    if (hasSingleYear() && sel.days.length && sel.months.length) return "minute";
    if (hasSingleYear() && sel.weeks.length) return "minute";
    if (sel.months.length) return "hourly";
    return "daily";
  }

  function selectedMinuteKeys() {
    if (!hasSingleYear() || !yearData) return [];
    const year = sel.years[0];

    if (sel.days.length) {
      if (!sel.months.length) return [];
      return sel.months
        .slice()
        .sort((a, b) => a - b)
        .map(month => `${year}_${String(month).padStart(2, "0")}`);
    }

    if (!sel.weeks.length) return [];

    const months = [...new Set(
      yearData.timestamps
        .filter(ts => {
          if (sel.months.length && !sel.months.includes(+ts.substring(5, 7))) return false;
          return sel.weeks.includes(isoWeek(ts));
        })
        .map(ts => +ts.substring(5, 7))
    )].sort((a, b) => a - b);

    return months.map(month => `${year}_${String(month).padStart(2, "0")}`);
  }

  function filterSeriesSlice(src, matcher) {
    const mask = src.timestamps.map(matcher);
    const fi = arr => (arr ? arr.filter((_, index) => mask[index]) : null);

    const out = {
      timestamps: fi(src.timestamps),
      pumps: src.pumps || [],
    };

    [
      "flow", "flow_mean", "flow_min", "flow_max", "flow_count",
      "wwl", "wwl_mean", "wwl_min", "wwl_max", "wwl_count",
      "wwl_east", "wwl_east_mean", "wwl_east_min", "wwl_east_max", "wwl_east_count",
      "wwl_west", "wwl_west_mean", "wwl_west_min", "wwl_west_max", "wwl_west_count",
      "rain",
    ].forEach(key => {
      if (src[key]) out[key] = fi(src[key]);
    });

    if (src.pump_status) {
      out.pump_status = Object.fromEntries(
        out.pumps.map(pump => [pump, fi(src.pump_status[pump] || [])])
      );
    }

    if (src.granularity) out.granularity = src.granularity;
    return out;
  }

  function filterHourlySlice(src) {
    return filterSeriesSlice(src, ts => !sel.months.length || sel.months.includes(+ts.substring(5, 7)));
  }

  function filterMinuteSlice(src) {
    return filterSeriesSlice(src, ts => {
      if (sel.months.length && !sel.months.includes(+ts.substring(5, 7))) return false;
      if (sel.days.length && !sel.days.includes(+ts.substring(8, 10))) return false;
      if (sel.weeks.length && !sel.weeks.includes(isoWeek(ts))) return false;
      return true;
    });
  }

  function weightedMean(values, counts) {
    let weightedTotal = 0;
    let totalCount = 0;
    values.forEach((value, index) => {
      const count = counts[index] || 0;
      if (value == null || !count) return;
      weightedTotal += value * count;
      totalCount += count;
    });
    return totalCount ? weightedTotal / totalCount : null;
  }

  function aggregateDailyMetric(timestamps, meanValues, minValues, maxValues, countValues) {
    const buckets = {};
    timestamps.forEach((ts, index) => {
      const day = ts.substring(0, 10);
      if (!buckets[day]) {
        buckets[day] = { means: [], mins: [], maxes: [], counts: [] };
      }
      if (meanValues[index] != null) buckets[day].means.push(meanValues[index]);
      if (minValues[index] != null) buckets[day].mins.push(minValues[index]);
      if (maxValues[index] != null) buckets[day].maxes.push(maxValues[index]);
      const count = countValues[index] || 0;
      if (count) buckets[day].counts.push(count);
      else if (meanValues[index] != null) buckets[day].counts.push(1);
    });

    const days = Object.keys(buckets).sort();
    return {
      timestamps: days,
      mean: days.map(day => weightedMean(buckets[day].means, buckets[day].counts)),
      min: days.map(day => minVal(buckets[day].mins)),
      max: days.map(day => maxVal(buckets[day].maxes)),
      count: days.map(day => sum(buckets[day].counts) || 0),
    };
  }

  function aggregateDailyRain(timestamps, rain) {
    const buckets = {};
    timestamps.forEach((ts, index) => {
      const day = ts.substring(0, 10);
      if (!buckets[day]) buckets[day] = [];
      if (rain[index] != null) buckets[day].push(rain[index]);
    });
    const days = Object.keys(buckets).sort();
    return {
      timestamps: days,
      rain: days.map(day => sum(buckets[day]) || 0),
      granularity: "daily",
    };
  }

  function aggregateDailySlice(src) {
    const flow = aggregateDailyMetric(src.timestamps, src.flow_mean, src.flow_min, src.flow_max, src.flow_count);
    const wwl = aggregateDailyMetric(src.timestamps, src.wwl_mean, src.wwl_min, src.wwl_max, src.wwl_count);

    const buckets = {};
    src.timestamps.forEach((ts, index) => {
      const day = ts.substring(0, 10);
      if (!buckets[day]) buckets[day] = {};
      src.pumps.forEach(pump => {
        if (!buckets[day][pump]) buckets[day][pump] = [];
        const value = src.pump_status[pump][index];
        if (value != null) buckets[day][pump].push(value);
      });
    });

    const days = flow.timestamps;
    const out = {
      timestamps: days,
      pumps: src.pumps,
      flow_mean: flow.mean,
      flow_min: flow.min,
      flow_max: flow.max,
      flow_count: flow.count,
      wwl_mean: wwl.mean,
      wwl_min: wwl.min,
      wwl_max: wwl.max,
      wwl_count: wwl.count,
      pump_status: Object.fromEntries(
        src.pumps.map(pump => [pump, days.map(day => maxVal((buckets[day] && buckets[day][pump]) || []))])
      ),
      granularity: "daily",
    };

    if (src.wwl_east_mean) {
      const east = aggregateDailyMetric(src.timestamps, src.wwl_east_mean, src.wwl_east_min, src.wwl_east_max, src.wwl_east_count);
      const west = aggregateDailyMetric(src.timestamps, src.wwl_west_mean, src.wwl_west_min, src.wwl_west_max, src.wwl_west_count);
      out.wwl_east_mean = east.mean;
      out.wwl_east_min = east.min;
      out.wwl_east_max = east.max;
      out.wwl_east_count = east.count;
      out.wwl_west_mean = west.mean;
      out.wwl_west_min = west.min;
      out.wwl_west_max = west.max;
      out.wwl_west_count = west.count;
    }

    return out;
  }

  function filterActivePumps(vd) {
    const activePumps = (vd.pumps || []).filter(pump =>
      (vd.pump_status[pump] || []).some(value => value != null && value > 0)
    );
    return {
      ...vd,
      pumps: activePumps,
      pump_status: Object.fromEntries(activePumps.map(pump => [pump, vd.pump_status[pump]])),
    };
  }

  function applySideFilter(vd) {
    if (!vd || !selectedSide || !PLANT_CONFIG.pumpGroups) return vd;
    const pumpIds = PLANT_CONFIG.pumpGroups[selectedSide] || [];
    const out = {
      ...vd,
      pumps: (vd.pumps || []).filter(pump => pumpIds.includes(pump)),
      pump_status: Object.fromEntries(
        (vd.pumps || [])
          .filter(pump => pumpIds.includes(pump))
          .map(pump => [pump, vd.pump_status[pump]])
      ),
    };

    if (selectedSide === "east" && vd.wwl_east_mean) {
      out.wwl_mean = vd.wwl_east_mean;
      out.wwl_min = vd.wwl_east_min;
      out.wwl_max = vd.wwl_east_max;
      out.wwl_count = vd.wwl_east_count;
    } else if (selectedSide === "west" && vd.wwl_west_mean) {
      out.wwl_mean = vd.wwl_west_mean;
      out.wwl_min = vd.wwl_west_min;
      out.wwl_max = vd.wwl_west_max;
      out.wwl_count = vd.wwl_west_count;
    }

    if (selectedSide === "east" && vd.wwl_east) {
      out.wwl = vd.wwl_east;
    } else if (selectedSide === "west" && vd.wwl_west) {
      out.wwl = vd.wwl_west;
    }

    return out;
  }

  function getMinuteViewSlice() {
    const keys = selectedMinuteKeys();
    if (!keys.length) return null;
    const missing = keys.filter(key => !minuteCache[key]);
    if (missing.length) return null;
    const merged = mergeMinuteData(keys);
    if (!merged) return null;
    return { ...filterMinuteSlice(merged), granularity: "minute" };
  }

  function getActiveViewData() {
    if (!yearData) return null;
    const resolution = getResolutionMode();
    if (resolution === "minute") {
      const minute = getMinuteViewSlice();
      return minute ? filterActivePumps(applySideFilter(minute)) : null;
    }
    if (resolution === "hourly") {
      return filterActivePumps(applySideFilter({ ...filterHourlySlice(yearData), granularity: "hourly" }));
    }
    return filterActivePumps(applySideFilter(aggregateDailySlice(yearData)));
  }

  function getRainViewData() {
    if (!rainYearData) return null;

    if (isPolygonRain()) {
      // Daily sparse data — just month-filter the event days
      if (!sel.months.length) return rainYearData;
      const mask = rainYearData.timestamps.map(ts => sel.months.includes(+ts.substring(5, 7)));
      const fi = arr => arr ? arr.filter((_, i) => mask[i]) : null;
      return {
        ...rainYearData,
        timestamps: fi(rainYearData.timestamps),
        rain:       fi(rainYearData.rain),
        freq:       rainYearData.freq ? fi(rainYearData.freq) : null,
      };
    }

    // Legacy hourly gauge path
    const resolution = getResolutionMode();
    if (resolution === "minute") {
      const keys = selectedMinuteKeys();
      const missing = keys.filter(key => !rainMinuteCache[key]);
      if (missing.length) return null;
      const merged = mergeRainMinuteData(keys);
      if (!merged) return null;
      return {
        ...filterSeriesSlice({ ...merged, pumps: [], granularity: "5min" }, ts => {
          if (sel.months.length && !sel.months.includes(+ts.substring(5, 7))) return false;
          if (sel.days.length && !sel.days.includes(+ts.substring(8, 10))) return false;
          if (sel.weeks.length && !sel.weeks.includes(isoWeek(ts))) return false;
          return true;
        }),
        granularity: "5min",
      };
    }

    const hourly = filterSeriesSlice({ ...rainYearData, pumps: [], granularity: "hourly" }, ts =>
      !sel.months.length || sel.months.includes(+ts.substring(5, 7))
    );

    if (resolution === "hourly") return hourly;
    return aggregateDailyRain(hourly.timestamps, hourly.rain);
  }

  function alignRainToTimestamps(targetTimestamps, rainVd) {
    if (!rainVd) return null;

    // Polygon rain: daily sparse timestamps ("YYYY-MM-DD") — match by date prefix
    if (rainVd.polygon || (rainVd.timestamps.length && rainVd.timestamps[0].length === 10)) {
      const lookup = {};
      rainVd.timestamps.forEach((ts, i) => {
        lookup[ts] = { rain: rainVd.rain[i], freq: rainVd.freq ? rainVd.freq[i] : null };
      });
      return {
        data: targetTimestamps.map(ts => {
          const entry = lookup[ts.substring(0, 10)];
          return entry ? entry.rain : null;
        }),
        freqByDate: lookup,
        granularity: "daily",
      };
    }

    // Legacy hourly / 5-min gauge path
    const lookup = Object.fromEntries(rainVd.timestamps.map((ts, index) => [ts, rainVd.rain[index]]));
    return {
      data: targetTimestamps.map(ts => {
        if (Object.prototype.hasOwnProperty.call(lookup, ts)) return lookup[ts];
        if (rainVd.granularity === "5min") {
          const floored = floorToFiveMinute(ts);
          return Object.prototype.hasOwnProperty.call(lookup, floored) ? lookup[floored] : null;
        }
        return null;
      }),
      lookup,
      granularity: rainVd.granularity,
    };
  }

  function tooltip(opts) {
    opts = opts || {};
    const granularity = opts.granularity || "hourly";
    const bucketStats = opts.bucketStats || null;
    return {
      trigger: "axis",
      backgroundColor: TIP_BG,
      borderColor: TIP_BORDER,
      textStyle: { color: "#eff5fb", fontSize: 12 },
      axisPointer: { type: "shadow" },
      formatter: params => {
        const axisTs = params[0] ? params[0].axisValue : "";
        let out = `<div style="margin-bottom:4px;font-weight:600">${fmtAxisValue(axisTs, granularity)}</div>`;
        params.forEach(p => {
          if (p.value == null || p.value === "-") return;
          const raw = Array.isArray(p.value) ? p.value[1] : p.value;
          if (raw == null) return;
          const value = typeof raw === "number"
            ? (Number.isInteger(raw) ? raw : +raw.toFixed(2))
            : raw;
          out += `${p.marker} ${p.seriesName}&nbsp;&nbsp;<b>${value}</b><br/>`;
        });
        if (bucketStats && granularity !== "minute" && granularity !== "5min") {
          const stats = bucketStats[axisTs];
          if (stats) {
            if (stats.min != null) {
              out += `<span style="display:inline-block;margin-right:6px;border-radius:50%;width:8px;height:8px;background:#7f8ea3;"></span>${stats.label} Min&nbsp;&nbsp;<b>${(+stats.min).toFixed(2)}</b><br/>`;
            }
          }
        }
        return out;
      },
    };
  }

  function legend(names) {
    return {
      data: names,
      textStyle: { color: "#b4c0d0", fontSize: 11 },
      top: 4,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 7,
    };
  }

  function xAxisOpt(timestamps, granularity) {
    const count = timestamps.length;
    const interval = Math.max(0, Math.floor(count / 10) - 1);
    return {
      type: "category",
      data: timestamps,
      axisLabel: {
        color: "#b4c0d0",
        fontSize: 11,
        margin: 12,
        interval,
        formatter: ts => fmtLabel(ts, granularity),
        rotate: count > 200 ? 30 : 0,
      },
      axisLine: { lineStyle: { color: AXIS_COLOR } },
      axisTick: { lineStyle: { color: AXIS_COLOR } },
      splitLine: { show: false },
    };
  }

  function chartBottomPadding(granularity) {
    if (granularity === "daily") return 34;
    if (granularity === "minute" || granularity === "5min") return 50;
    return 44;
  }

  function yAxisLeft(name) {
    return {
      type: "value",
      name,
      min: 0,
      nameTextStyle: { color: "#b4c0d0", fontSize: 11 },
      axisLabel: { color: "#b4c0d0", fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: SPLIT_COLOR } },
    };
  }

  function yAxisRight(name) {
    return { ...yAxisLeft(name), position: "right", splitLine: { show: false } };
  }

  function yAxisRain(maxVal) {
    return {
      type: "value",
      min: 0,
      max: maxVal > 0 ? maxVal * 2 : 2,
      inverse: true,
      position: "right",
      offset: 58,
      axisLabel: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      name: "",
    };
  }

  function extremaMarkPoint(timestamps, values, color, opts) {
    opts = opts || {};
    const points = values
      .map((value, index) => ({ value, index }))
      .filter(point => point.value != null);
    if (!points.length) return null;

    const leftThreshold = Math.max(3, Math.floor(values.length * 0.12));
    const minSpacing = Math.max(4, Math.floor(values.length * 0.08));

    function labelPlacement(pointType, index) {
      if (index < leftThreshold) return { position: "right", distance: 10 };
      return pointType === "min" ? { position: "bottom", distance: 8 } : { position: "top", distance: 8 };
    }

    function localExtrema(kind) {
      const out = [];
      for (let index = 1; index < values.length - 1; index += 1) {
        const prev = values[index - 1];
        const curr = values[index];
        const next = values[index + 1];
        if (prev == null || curr == null || next == null) continue;
        const isPeak = (curr >= prev && curr > next) || (curr > prev && curr >= next);
        const isValley = (curr <= prev && curr < next) || (curr < prev && curr <= next);
        if ((kind === "max" && isPeak) || (kind === "min" && isValley)) {
          out.push({ index, value: curr, type: kind });
        }
      }
      return out;
    }

    function addSpaced(selected, candidates, limit) {
      for (const point of candidates) {
        if (selected.length >= limit) break;
        const tooClose = selected.some(existing => Math.abs(existing.index - point.index) < minSpacing);
        if (tooClose) continue;
        selected.push(point);
      }
    }

    let selectedPoints;
    if (opts.multi) {
      selectedPoints = [];
      const peaks = localExtrema("max").sort((a, b) => b.value - a.value);
      const valleys = localExtrema("min").sort((a, b) => a.value - b.value);
      addSpaced(selectedPoints, peaks, opts.maxPeaks || 2);
      addSpaced(selectedPoints, valleys, (opts.maxValleys == null ? 1 : opts.maxValleys) + selectedPoints.length);
      if (!selectedPoints.length) {
        const peak = points.reduce((best, point) => (best == null || point.value > best.value ? point : best), null);
        selectedPoints = [{ ...peak, type: "max" }];
      }
      selectedPoints = selectedPoints.sort((a, b) => a.index - b.index);
    } else {
      const peak = points.reduce((best, point) => (best == null || point.value > best.value ? point : best), null);
      selectedPoints = [{ ...peak, type: "max" }];
    }

    return {
      symbol: "circle",
      symbolSize: 10,
      itemStyle: {
        color: color,
        borderColor: color,
        borderWidth: 0,
      },
      label: {
        color: "#eff5fb",
        fontSize: 10,
        backgroundColor: hasRain() ? "rgba(12,21,34,0.55)" : "rgba(12,21,34,0.96)",
        borderColor: color,
        borderWidth: 1,
        borderRadius: 6,
        padding: [3, 6],
        formatter: params => {
          const value = Array.isArray(params.value) ? params.value[1] : params.value;
          return value == null ? "" : (+value).toFixed(2);
        },
      },
      data: selectedPoints.map(point => {
        const placement = labelPlacement(point.type, point.index);
        return {
          name: point.type === "min" ? "Valley" : "Peak",
          coord: [timestamps[point.index], point.value],
          value: point.value,
          label: placement,
        };
      }),
    };
  }

  function makeMixedComboOption(vd, metricKey, metricLabel, metricColor, metricMaxColor, rainVd) {
    const rain = rainVd ? alignRainToTimestamps(vd.timestamps, rainVd) : null;
    const isBucketed = !!vd[metricKey + "_mean"];
    const mainData = isBucketed ? vd[metricKey + "_mean"] : vd[metricKey];
    const minData = isBucketed ? vd[metricKey + "_min"] : null;
    const maxData = isBucketed ? vd[metricKey + "_max"] : null;
    const bucketStats = isBucketed
      ? Object.fromEntries(vd.timestamps.map((ts, index) => [ts, { label: metricLabel, min: minData[index], max: maxData[index] }]))
      : null;
    const legendNames = [...vd.pumps];
    if (rain) legendNames.push("Rain, in");
    legendNames.push(isBucketed ? `${metricLabel} Mean` : metricLabel);
    if (maxData) legendNames.push(`${metricLabel} Max`);
    const rainMax = rain
      ? Math.max(...rain.data.filter(v => v != null && v > 0), 0.1)
      : 0;
    const yAxes = [yAxisLeft("Pump Status (0/1)"), yAxisRight(metricLabel)];
    if (rain) yAxes.push(yAxisRain(rainMax));

    const usePillLegend = !!document.getElementById("chart-flow-legend");
    const legendSelected = {};
    legendNames.forEach(n => { legendSelected[n] = isLegendActive(n); });

    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity: vd.granularity, bucketStats }),
      legend: usePillLegend
        ? { show: false, data: legendNames, selected: legendSelected }
        : { ...legend(legendNames), selected: legendSelected },
      grid: { left: 70, right: 70, top: usePillLegend ? 30 : 44, bottom: chartBottomPadding(vd.granularity), containLabel: true },
      xAxis: xAxisOpt(vd.timestamps, vd.granularity),
      yAxis: yAxes,
      series: [
        ...vd.pumps.map((pump, index) => ({
          name: pump,
          type: "bar",
          stack: "pumps",
          yAxisIndex: 0,
          itemStyle: { color: stablePumpColor(pump) },
          data: vd.pump_status[pump],
          barMaxWidth: vd.granularity === "minute" ? 6 : 24,
          z: 1,
        })),
        ...(rain ? [{
          name: "Rain, in",
          type: "bar",
          yAxisIndex: 2,
          data: rain.data,
          barMaxWidth: vd.granularity === "minute" ? 6 : 12,
          itemStyle: { color: "rgba(72,208,201,0.70)" },
          emphasis: { itemStyle: { color: "rgba(72,208,201,0.90)" } },
          z: 4,
        }] : []),
        {
          name: isBucketed ? `${metricLabel} Mean` : metricLabel,
          type: "line",
          yAxisIndex: 1,
          data: mainData,
          lineStyle: { width: 2.5, color: metricColor },
          itemStyle: { color: metricColor },
          symbol: "none",
          connectNulls: false,
          z: 10,
          markPoint: !maxData ? extremaMarkPoint(vd.timestamps, mainData, metricColor) : null,
        },
        ...(maxData ? [{
          name: `${metricLabel} Max`,
          type: "line",
          yAxisIndex: 1,
          data: maxData,
          lineStyle: { width: 1.8, color: metricMaxColor, type: "dashed", dashOffset: 0 },
          itemStyle: { color: metricMaxColor },
          symbol: "none",
          connectNulls: false,
          z: 9,
          markPoint: extremaMarkPoint(vd.timestamps, maxData, metricMaxColor, { multi: true, maxPeaks: 2, maxValleys: 1 }),
        }] : []),
      ],
    };
  }

  function makePumpsSepOption(vd) {
    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity: vd.granularity }),
      legend: legend(vd.pumps),
      grid: { left: 70, right: 20, top: 36, bottom: chartBottomPadding(vd.granularity), containLabel: true },
      xAxis: xAxisOpt(vd.timestamps, vd.granularity),
      yAxis: yAxisLeft("Pump Status (0/1)"),
      series: vd.pumps.map((pump, index) => ({
        name: pump,
        type: "bar",
        stack: "pumps",
        itemStyle: { color: PUMP_COLORS[index % PUMP_COLORS.length] },
        data: vd.pump_status[pump],
        barMaxWidth: vd.granularity === "minute" ? 6 : 24,
      })),
    };
  }

  function makeMetricOption(vd, metricKey, label, color, maxColor) {
    const isBucketed = !!vd[metricKey + "_mean"];
    const mainData = isBucketed ? vd[metricKey + "_mean"] : vd[metricKey];
    const minData = isBucketed ? vd[metricKey + "_min"] : null;
    const maxData = isBucketed ? vd[metricKey + "_max"] : null;
    const bucketStats = isBucketed
      ? Object.fromEntries(vd.timestamps.map((ts, index) => [ts, { label, min: minData[index], max: maxData[index] }]))
      : null;
    const legendNames = [isBucketed ? `${label} Mean` : label];
    if (maxData) legendNames.push(`${label} Max`);

    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity: vd.granularity, bucketStats }),
      legend: legend(legendNames),
      grid: { left: 70, right: 20, top: 36, bottom: chartBottomPadding(vd.granularity), containLabel: true },
      xAxis: xAxisOpt(vd.timestamps, vd.granularity),
      yAxis: { ...yAxisLeft(label), min: undefined },
      series: [
        {
          name: isBucketed ? `${label} Mean` : label,
          type: "line",
          data: mainData,
          lineStyle: { width: 2.5, color },
          itemStyle: { color },
          symbol: "none",
          connectNulls: false,
          markPoint: !maxData ? extremaMarkPoint(vd.timestamps, mainData, color) : null,
        },
        ...(maxData ? [{
          name: `${label} Max`,
          type: "line",
          data: maxData,
          lineStyle: { width: 1.8, color: maxColor, type: "dashed", dashOffset: 0 },
          itemStyle: { color: maxColor },
          symbol: "none",
          connectNulls: false,
          markPoint: extremaMarkPoint(vd.timestamps, maxData, maxColor, { multi: true, maxPeaks: 2, maxValleys: 1 }),
        }] : []),
      ],
    };
  }

  function colorWithAlpha(color, alpha) {
    if (color.startsWith("#")) {
      const r = parseInt(color.slice(1, 3), 16);
      const g = parseInt(color.slice(3, 5), 16);
      const b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    return color.replace(/[\d.]+\)$/, `${alpha})`);
  }

  function isLegendActive(name) {
    if (legendState === null || !(name in legendState)) {
      return name !== "Rain, in";
    }
    return legendState[name];
  }

  function buildPillLegend(containerId, items, chart) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.style.cssText = [
      "display:flex", "flex-wrap:wrap", "gap:4px",
      "padding:4px 14px 8px", "align-items:center", "justify-content:center",
    ].join(";");

    function render() {
      container.innerHTML = "";
      items.forEach(({ name, color, label }) => {
        const active = isLegendActive(name);
        const pill = document.createElement("button");
        pill.type = "button";

        const border = active ? color : "rgba(108,143,186,0.2)";
        const text   = active ? color : "rgba(180,192,208,0.38)";
        const bg     = active ? colorWithAlpha(color, 0.07) : "transparent";

        pill.style.cssText = [
          "display:inline-flex", "align-items:center", "gap:5px",
          "padding:3px 9px 3px 7px", "border-radius:12px",
          `border:1px solid ${border}`, `background:${bg}`, `color:${text}`,
          "cursor:pointer", "font-size:11px", "font-weight:600",
          "font-family:inherit", "transition:opacity 0.15s",
          "user-select:none", "line-height:1.3",
          active ? "" : "text-decoration:line-through",
        ].join(";");

        const swatch = document.createElement("span");
        swatch.style.cssText = [
          "width:8px", "height:4px", "border-radius:2px", "flex-shrink:0",
          `background:${active ? color : "rgba(180,192,208,0.12)"}`,
        ].join(";");

        const txt = document.createElement("span");
        txt.textContent = label || name;

        pill.appendChild(swatch);
        pill.appendChild(txt);

        pill.addEventListener("mouseenter", () => { pill.style.opacity = "0.78"; });
        pill.addEventListener("mouseleave", () => { pill.style.opacity = "1"; });

        pill.addEventListener("click", () => {
          if (!legendState) legendState = {};
          legendState[name] = !isLegendActive(name);
          if (name === "Rain, in") sel.includeRain = legendState[name];
          chart.dispatchAction({ type: "legendToggleSelect", name });
          render();
        });

        container.appendChild(pill);
      });
    }

    render();
  }

  function rainFreqColor(freq) {
    if (freq == null || freq <= 0) return RAIN_COLOR;
    if (freq < 2)   return RAIN_COLOR;
    if (freq < 5)   return "#f4c26b";
    if (freq < 10)  return "#e6a52e";
    if (freq < 25)  return "#d46b2d";
    if (freq < 100) return "#cf4336";
    return "#9b7fd4";
  }

  function makeRainOption(vd) {
    const hasFreq = Array.isArray(vd.freq) && vd.freq.some(v => v != null && v > 0);
    const barData = hasFreq
      ? vd.timestamps.map((_, i) => ({
          value: vd.rain[i],
          itemStyle: { color: rainFreqColor(vd.freq[i]) },
        }))
      : vd.rain;

    const granularity = vd.granularity || (vd.polygon ? "daily" : "hourly");

    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity }),
      grid: { left: 70, right: 20, top: 16, bottom: chartBottomPadding(vd.granularity), containLabel: true },
      xAxis: xAxisOpt(vd.timestamps, granularity),
      yAxis: { ...yAxisLeft("Rainfall, in"), inverse: true },
      series: [{
        name: "Rainfall, in",
        type: "bar",
        data: barData,
        barMaxWidth: 24,
      }],
    };
  }

  function groupedRawStats(timestamps, values, keyFn) {
    const buckets = {};
    timestamps.forEach((ts, index) => {
      const value = values[index];
      if (value == null) return;
      const key = keyFn(ts);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(value);
    });
    return Object.keys(buckets).sort().map(key => {
      const vals = buckets[key];
      return {
        min: Math.min(...vals),
        mean: avg(vals),
        max: Math.max(...vals),
      };
    });
  }

  function groupedBucketStats(timestamps, meanValues, minValues, maxValues, countValues, keyFn) {
    const buckets = {};
    timestamps.forEach((ts, index) => {
      const meanValue = meanValues[index];
      const minValue = minValues[index];
      const maxValue = maxValues[index];
      const countValue = countValues[index] || 0;
      if (meanValue == null && minValue == null && maxValue == null && !countValue) return;
      const key = keyFn(ts);
      if (!buckets[key]) {
        buckets[key] = { mins: [], maxes: [], weightedTotal: 0, count: 0 };
      }
      if (minValue != null) buckets[key].mins.push(minValue);
      if (maxValue != null) buckets[key].maxes.push(maxValue);
      if (meanValue != null && countValue) {
        buckets[key].weightedTotal += meanValue * countValue;
        buckets[key].count += countValue;
      } else if (meanValue != null) {
        buckets[key].weightedTotal += meanValue;
        buckets[key].count += 1;
      }
    });
    return Object.keys(buckets).sort().map(key => ({
      min: minVal(buckets[key].mins),
      mean: buckets[key].count ? buckets[key].weightedTotal / buckets[key].count : null,
      max: maxVal(buckets[key].maxes),
    })).filter(stat => stat.mean != null || stat.min != null || stat.max != null);
  }

  function summarizeGroupedStats(statsByGroup) {
    if (!statsByGroup.length) return { min: null, mean: null, max: null };
    return {
      min: minVal(statsByGroup.map(stat => stat.min)),
      mean: avg(statsByGroup.map(stat => stat.mean)),
      max: maxVal(statsByGroup.map(stat => stat.max)),
    };
  }

  function renderStatisticsPanel(slice) {
    const fmt = value => (value == null ? "—" : value.toFixed(2));
    const set = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = fmt(value);
    };

    const daily = ts => ts.substring(0, 10);
    const weekly = ts => isoWeekInfo(ts).key;
    const isBucketed = !!slice.flow_mean;

    const flowDaily = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.flow_mean, slice.flow_min, slice.flow_max, slice.flow_count, daily))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.flow, daily));
    const flowWeekly = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.flow_mean, slice.flow_min, slice.flow_max, slice.flow_count, weekly))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.flow, weekly));

    set("stat-flow-d-min", flowDaily.min);
    set("stat-flow-d-mean", flowDaily.mean);
    set("stat-flow-d-max", flowDaily.max);
    set("stat-flow-w-min", flowWeekly.min);
    set("stat-flow-w-mean", flowWeekly.mean);
    set("stat-flow-w-max", flowWeekly.max);

    const wwlDaily = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.wwl_mean, slice.wwl_min, slice.wwl_max, slice.wwl_count, daily))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.wwl, daily));
    const wwlWeekly = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.wwl_mean, slice.wwl_min, slice.wwl_max, slice.wwl_count, weekly))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.wwl, weekly));

    set("stat-wwl-d-min", wwlDaily.min);
    set("stat-wwl-d-mean", wwlDaily.mean);
    set("stat-wwl-d-max", wwlDaily.max);
    set("stat-wwl-w-min", wwlWeekly.min);
    set("stat-wwl-w-mean", wwlWeekly.mean);
    set("stat-wwl-w-max", wwlWeekly.max);
  }

  function initChart(id, groupName) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (charts[id]) {
      charts[id].dispose();
      delete charts[id];
    }
    charts[id] = echarts.init(el, null, { renderer: "canvas" });
    if (groupName) {
      charts[id].group = groupName;
      echarts.connect(groupName);
    }
    return charts[id];
  }

  function renderRainChart(id, rainVd) {
    const chart = initChart(id, "wwtp-rain");
    if (!chart) return;
    if (!rainVd) {
      chart.clear();
      return;
    }
    chart.setOption(makeRainOption(rainVd));
  }

  function renderCombined(vd, rainVd) {
    const hasCombinedRainEl = !!document.getElementById("chart-combined-rain");
    if (hasCombinedRainEl) {
      renderRainChart("chart-combined-rain", rainVd);
    }

    const overlayRain = hasCombinedRainEl ? null : rainVd;

    const flowChart = initChart("chart-flow", "wwtp");
    if (flowChart) {
      flowChart.setOption(makeMixedComboOption(vd, "flow", "Flow, MGD", FLOW_COLOR, FLOW_MAX_COLOR, overlayRain));

      if (document.getElementById("chart-flow-legend")) {
        const isBucketed = !!vd.flow_mean;
        const pillItems = [
          ...vd.pumps.map(pump => ({ name: pump, color: stablePumpColor(pump) })),
          ...(overlayRain ? [{ name: "Rain, in", color: RAIN_COLOR }] : []),
          { name: isBucketed ? "Flow, MGD Mean" : "Flow, MGD", color: FLOW_COLOR,
            label: isBucketed ? "Flow Mean" : "Flow, MGD" },
          ...(isBucketed ? [{ name: "Flow, MGD Max", color: FLOW_MAX_COLOR, label: "Flow Max" }] : []),
        ];
        buildPillLegend("chart-flow-legend", pillItems, flowChart);
      }

      flowChart.on("legendselectchanged", params => {
        if ("Rain, in" in params.selected) {
          sel.includeRain = params.selected["Rain, in"];
          if (legendState) legendState["Rain, in"] = sel.includeRain;
          syncGaugeFilterUI();
        }
      });
    }

    const wwlChart = initChart("chart-wwl", "wwtp");
    if (wwlChart) {
      wwlChart.setOption(makeMixedComboOption(vd, "wwl", "WWL, ft", WWL_COLOR, WWL_MAX_COLOR, overlayRain));
    }
  }

  function renderSeparate(vd, rainVd) {
    const pumpsChart = initChart("chart-sep-pumps", "wwtp");
    if (pumpsChart) pumpsChart.setOption(makePumpsSepOption(vd));

    const wwlChart = initChart("chart-sep-wwl", "wwtp");
    if (wwlChart) wwlChart.setOption(makeMetricOption(vd, "wwl", "WWL, ft", WWL_COLOR, WWL_MAX_COLOR));

    const flowChart = initChart("chart-sep-flow", "wwtp");
    if (flowChart) flowChart.setOption(makeMetricOption(vd, "flow", "Flow, MGD", FLOW_COLOR, FLOW_MAX_COLOR));

    renderRainChart("chart-sep-rain", rainVd);
  }

  function renderActive() {
    const slice = getActiveViewData();
    if (!slice) return;
    hideStatus();
    renderStatisticsPanel(slice);
    const rainVd = getRainViewData();
    const active = document.querySelector(".tab-pane.active");
    if (!active) return;
    if (active.id === "tab-combined") renderCombined(slice, rainVd);
    else renderSeparate(slice, rainVd);
  }

  function populateMonths() {
    if (!yearData || !msMonth) return;
    const months = [...new Set(yearData.timestamps.map(ts => +ts.substring(5, 7)))].sort((a, b) => a - b);
    msMonth.setOptions(months.map(month => ({ value: month, label: MO[month - 1] })));
  }

  function updateDayOptions(months, weeks, preserveSelection) {
    if (!msDay || !yearData) return;
    if (!hasSingleYear()) {
      sel.days = [];
      msDay.setOptions([]);
      msDay.clear();
      return;
    }
    let source = yearData.timestamps;
    if (months.length) {
      source = source.filter(ts => months.includes(+ts.substring(5, 7)));
    }
    if (weeks.length) {
      source = source.filter(ts => weeks.includes(isoWeek(ts)));
    }
    const days = [...new Set(source.map(ts => +ts.substring(8, 10)))].sort((a, b) => a - b);
    const validDays = preserveSelection ? sel.days.filter(day => days.includes(day)) : [];
    sel.days = validDays;
    msDay.setOptions(days.map(day => ({ value: day, label: String(day) })));
    if (validDays.length) msDay.setSelected(validDays);
  }

  function populateWeeks(months) {
    if (!msWeek || !yearData) return;
    if (!hasSingleYear()) {
      sel.weeks = [];
      msWeek.setOptions([]);
      msWeek.clear();
      return;
    }
    const source = months.length
      ? yearData.timestamps.filter(ts => months.includes(+ts.substring(5, 7)))
      : yearData.timestamps;
    const weeks = [...new Set(source.map(ts => isoWeek(ts)))].sort((a, b) => a - b);
    msWeek.setOptions(weeks.map(week => ({ value: week, label: "Week " + week })));
  }

  function syncGaugeFilterUI() {
    const el = document.getElementById("ms-gauge-rain");
    if (!el) return;
    const label = el.closest("label");
    if (label) label.style.display = (isMultiGauge() && sel.includeRain) ? "" : "none";
  }

  function updateRainToggleUI() {
    const btn = document.getElementById("btn-rain-toggle");
    if (btn) {
      const enabled = rainEnabled();
      btn.disabled = !enabled;
      btn.classList.toggle("is-on", enabled && sel.includeRain);
      btn.setAttribute("aria-pressed", enabled && sel.includeRain ? "true" : "false");
    }
    syncGaugeFilterUI();
  }

  async function preloadSelectedDetailData() {
    const keys = [...new Set(selectedMinuteKeys())];
    if (!keys.length) return { failures: [] };

    const loads = await Promise.all(
      keys.map(async key => {
        const [year, month] = key.split("_");
        const data = await loadMinuteData(+year, +month);
        return { key, ok: !!data };
      })
    );

    if (hasRain() && !isPolygonRain() && (isMultiGauge() || sel.gauges.length)) {
      await Promise.all(keys.map(async key => {
        const [year, month] = key.split("_");
        await loadRainMinuteData(+year, +month);
      }));
    }

    return { failures: loads.filter(load => !load.ok).map(load => load.key) };
  }

  async function refreshActiveView() {
    hideStatus();
    const resolution = getResolutionMode();
    if (resolution !== "minute") {
      renderActive();
      return;
    }

    setLoading(true);
    const detail = await preloadSelectedDetailData();
    setLoading(false);
    if (detail.failures.length) {
      setStatus("Minute data unavailable for the selected period.");
    }
    renderActive();
  }

  async function init() {
    const title = document.getElementById("plant-title");
    if (title) title.textContent = PLANT_CONFIG.name;

    try {
      await loadScript(PLANT_CONFIG.dataDir + "meta.js");
      meta = window.__wwtp_meta || null;
      if (!meta) throw new Error("Missing meta");
    } catch (e) {
      setStatus("Could not load meta.js — run preprocess.py first.");
      return;
    }

    msYear = createMultiSelect("ms-year", "All Years", async years => {
      sel.years = years;
      minuteCache = {};
      rainMinuteCache = {};
      await loadYears(years.length ? years : meta.years);
    }, { showAll: true });

    msMonth = createMultiSelect("ms-month", "All Months", async months => {
      sel.months = months;
      sel.days = [];
      sel.weeks = [];
      if (msDay) msDay.clear();
      if (msWeek) msWeek.clear();
      updateDayOptions(months, [], false);
      populateWeeks(months);
      await refreshActiveView();
    }, { showAll: true });

    msDay = createMultiSelect("ms-day", "All Days", async days => {
      sel.days = days;
      await refreshActiveView();
    }, { showAll: true });

    msWeek = createMultiSelect("ms-week", "All Weeks", async weeks => {
      sel.weeks = weeks;
      sel.days = [];
      if (msDay) msDay.clear();
      updateDayOptions(sel.months, weeks, false);
      await refreshActiveView();
    }, { showAll: true });

    if (isMultiGauge()) {
      const gauges = PLANT_CONFIG.rain.gauges;
      selectedRainGauge = gauges[0].id;

      const msGaugeRain = createMultiSelect("ms-gauge-rain", "Gauge", async selected => {
        if (!selected.length) return;
        const gauge = selected[selected.length - 1];
        if (gauge === selectedRainGauge) return;
        selectedRainGauge = gauge;
        rainYearData = null;
        rainMinuteCache = {};
        setLoading(true);
        await loadRainYears(sel.years.length ? sel.years : meta.years);
        setLoading(false);
        await refreshActiveView();
      }, { minSelected: 1 });

      if (msGaugeRain) {
        const shortLabel = lbl => lbl.replace(/ (Road|Street|Drive|Boulevard|Avenue|Lane)$/i, "");
        msGaugeRain.setOptions(gauges.map(g => ({
          value: g.id,
          label: `${g.id} · ${shortLabel(g.label)}`,
        })));
        msGaugeRain.setSelected([gauges[0].id]);
      }
      syncGaugeFilterUI();
    } else if (hasRain() && !isPolygonRain()) {
      msGauge = createMultiSelect("ms-gauge", "Gauge", async gauges => {
        sel.gauges = gauges;
        updateRainToggleUI();
        await refreshActiveView();
      });
      if (msGauge) {
        const gaugeLabel = PLANT_CONFIG.rain.label
          ? `${PLANT_CONFIG.rain.gauge} · ${PLANT_CONFIG.rain.label}`
          : `Gauge ${PLANT_CONFIG.rain.gauge}`;
        msGauge.setOptions([{ value: PLANT_CONFIG.rain.gauge, label: gaugeLabel }]);
        sel.gauges = [PLANT_CONFIG.rain.gauge];
        msGauge.setSelected(sel.gauges);
      } else {
        // No gauge dropdown in HTML — auto-enable the configured gauge silently
        sel.gauges = [PLANT_CONFIG.rain.gauge];
      }
    }

    const rainToggleBtn = document.getElementById("btn-rain-toggle");
    if (rainToggleBtn) {
      rainToggleBtn.addEventListener("click", async () => {
        if (!rainEnabled()) return;
        sel.includeRain = !sel.includeRain;
        updateRainToggleUI();
        renderActive();
      });
      updateRainToggleUI();
    }

    const sortedYears = meta.years.slice().sort((a, b) => b - a);
    msYear.setOptions(sortedYears.map(year => ({ value: year, label: String(year) })));
    const defaultYear = meta.years.includes(2026) ? 2026 : meta.years[meta.years.length - 1];
    sel.years = [defaultYear];
    msYear.setSelected([defaultYear]);
    await loadYears([defaultYear]);

    const defaultMonth = defaultYear === 2026 && meta.years.includes(2026) ? 5 : 1;
    sel.months = [defaultMonth];
    if (msMonth) msMonth.setSelected([defaultMonth]);
    populateWeeks([defaultMonth]);
    updateDayOptions([defaultMonth], [], false);
    await refreshActiveView();

    document.querySelectorAll(".side-btn[data-side]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".side-btn").forEach(node => node.classList.remove("active"));
        btn.classList.add("active");
        selectedSide = btn.dataset.side;
        renderActive();
      });
    });

    const resetBtn = document.getElementById("btn-reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", async () => {
        sel.months = [];
        sel.days = [];
        sel.weeks = [];
        if (msMonth) msMonth.clear();
        if (msDay) msDay.clear();
        if (msWeek) msWeek.clear();
        updateDayOptions([], [], false);
        populateWeeks([]);
        await refreshActiveView();
      });
    }

    document.querySelectorAll(".subtab[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".subtab").forEach(node => node.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
        btn.classList.add("active");
        const pane = document.getElementById("tab-" + btn.dataset.tab);
        if (pane) pane.classList.add("active");
        renderActive();
      });
    });

    window.addEventListener("resize", () => Object.values(charts).forEach(chart => chart && chart.resize()));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
