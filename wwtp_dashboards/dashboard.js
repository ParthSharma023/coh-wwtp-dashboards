/* dashboard.js — shared WWTP chart logic (Chart.js 4.4.1 + chartjs-plugin-zoom)
 * Requires PLANT_CONFIG = { name, fid, dataDir } defined before this script.
 * Requires Chart.js 4, Hammer.js, chartjs-plugin-zoom loaded before this script.
 */
(function () {
  "use strict";

  /* ── colour constants ───────────────────────────────────────────────────── */
  const PUMP_COLORS = [
    "#5da8ff", "#66bb6a", "#e6a52e", "#d46b2d",
    "#cf4336", "#9b7fd4", "#74c6ea", "#6fd9cb",
    "#f4c26b", "#e89c76",
  ];
  const FLOW_COLOR         = "#f1f5fb";
  const FLOW_MAX_COLOR     = "rgba(241,245,251,0.72)";
  const WWL_COLOR          = "#6ee7a0";
  const WWL_MAX_COLOR      = "rgba(110,231,160,0.78)";
  const RAIN_COLOR         = "#48d0c9";
  const DAILY_AVG_NAME     = "Flow Daily Avg";
  const DAILY_AVG_COLOR    = "#7dd3fc";
  const THRESHOLD_75_NAME  = "75% Threshold";
  const THRESHOLD_90_NAME  = "90% Threshold";
  const THRESHOLD_75_COLOR = "#f0bd4e";
  const THRESHOLD_90_COLOR = "#ff9a76";
  const PEAK_2HR_NAME      = "2-Hr Peak Permit";
  const PEAK_2HR_COLOR     = "#ef4444";
  const CRITICAL_WWL_NAME  = "Critical WWL";
  const CRITICAL_WWL_COLOR = "#f48adf";
  const TICK_COLOR  = "#b4c0d0";
  const GRID_COLOR  = "rgba(180,192,208,0.07)";
  const TIP_BG      = "#17273a";
  const TIP_BORDER  = "rgba(122,156,199,0.28)";

  /* ── dashboard state ────────────────────────────────────────────────────── */
  let meta            = null;
  let yearData        = null;
  let rainYearData    = null;
  let minuteCache     = {};
  let rainMinuteCache = {};
  let charts          = {};
  let legendState     = null;
  let selectedRainGauge = null;
  let selectedSide    = PLANT_CONFIG.pumpGroups ? "east" : null;
  let drillState      = null;
  let _drilling       = false;
  let _syncing        = false;

  const sel = { years: [], months: [], days: [], weeks: [], gauges: [], includeRain: false, dateFrom: null, dateTo: null };
  let msYear = null, msMonth = null, msDay = null, msWeek = null, msGauge = null;

  const MinuteChartReg = {};

  const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  /* ── multi-select widget ────────────────────────────────────────────────── */
  function createMultiSelect(id, placeholder, onChange, opts) {
    opts = opts || {};
    const showAll    = opts.showAll    || false;
    const minSelected = opts.minSelected || 0;
    const el      = document.getElementById(id);
    if (!el) return null;
    const trigger = el.querySelector(".ms-trigger");
    const panel   = el.querySelector(".ms-panel");
    let selected  = [];
    let options   = [];

    trigger.addEventListener("click", e => {
      e.stopPropagation();
      document.querySelectorAll(".multi-select.open").forEach(ms => { if (ms !== el) ms.classList.remove("open"); });
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
          e.stopPropagation(); selected = []; el.classList.remove("open"); renderPanel(); onChange(selected);
        });
        panel.appendChild(allItem);
        const sep = document.createElement("div"); sep.className = "ms-sep"; panel.appendChild(sep);
      }
      options.forEach(opt => {
        const isSel = selected.includes(opt.value);
        const item  = document.createElement("div");
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
          renderPanel(); onChange(selected);
        });
        panel.appendChild(item);
      });
      renderTrigger();
    }

    return {
      setOptions(nextOptions) { options = nextOptions; selected = selected.filter(v => options.some(o => o.value === v)); renderPanel(); },
      setSelected(vals)       { selected = vals; renderPanel(); },
      getSelected()           { return [...selected]; },
      clear()                 { selected = []; renderPanel(); },
    };
  }

  /* ── script loader ──────────────────────────────────────────────────────── */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* ── math helpers ───────────────────────────────────────────────────────── */
  const avg    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((s,x)=>s+x,0)/v.length : null; };
  const sum    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((s,x)=>s+x,0) : null; };
  const maxVal = arr => { const v = arr.filter(x => x != null); return v.length ? Math.max(...v) : null; };
  const minVal = arr => { const v = arr.filter(x => x != null); return v.length ? Math.min(...v) : null; };

  /* ── colour helpers ─────────────────────────────────────────────────────── */
  function hexToRgba(hex, alpha) {
    if (!hex || !hex.startsWith("#")) return (hex || "").replace(/[\d.]+\)$/, `${alpha})`);
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const colorWithAlpha = hexToRgba;

  function stablePumpColor(pump) {
    const ref = PLANT_CONFIG.pumpGroups
      ? (PLANT_CONFIG.pumpGroups[selectedSide] || (yearData && yearData.pumps) || [])
      : ((yearData && yearData.pumps) || []);
    const idx = ref.indexOf(pump);
    return PUMP_COLORS[(idx >= 0 ? idx : 0) % PUMP_COLORS.length];
  }

  /* ── plant-config helpers ───────────────────────────────────────────────── */
  const hasRain       = () => !!(PLANT_CONFIG.rain && (PLANT_CONFIG.rain.gauges || PLANT_CONFIG.rain.polygon || PLANT_CONFIG.rain.gauge));
  const isMultiGauge  = () => !!(PLANT_CONFIG.rain && PLANT_CONFIG.rain.gauges);
  const isPolygonRain = () => !!(PLANT_CONFIG.rain && PLANT_CONFIG.rain.polygon) || !!(rainYearData && rainYearData.polygon);
  const rainEnabled   = () => isPolygonRain()
    ? sel.includeRain
    : (!hasRain() || isMultiGauge() || sel.gauges.includes(PLANT_CONFIG.rain.gauge));
  const hasSingleYear  = () => sel.years.length === 1;
  const hasCustomRange = () => !!(sel.dateFrom && sel.dateTo && sel.dateFrom <= sel.dateTo);

  /* ── time helpers ───────────────────────────────────────────────────────── */
  function isoWeek(ts) {
    const d = new Date(ts.length === 10 ? ts + "T00:00" : ts.replace(" ","T"));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - y) / 86400000) + 1) / 7);
  }

  function isoWeekInfo(ts) {
    const d = new Date(ts.length === 10 ? ts + "T00:00" : ts.replace(" ","T"));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const isoYear = d.getUTCFullYear();
    const y = new Date(Date.UTC(isoYear, 0, 1));
    const week = Math.ceil((((d - y) / 86400000) + 1) / 7);
    return { year: isoYear, week, key: `${isoYear}-W${String(week).padStart(2,"0")}` };
  }

  function fmtLabel(ts, granularity, showYear) {
    if (!ts) return "";
    const year = ts.substring(0,4), month = +ts.substring(5,7)-1, day = +ts.substring(8,10);
    if (granularity === "daily") return showYear ? `${MO[month]} ${day} ${year}` : `${MO[month]} ${day}`;
    return showYear ? `${MO[month]} ${day} ${year} ${ts.substring(11,16)}` : `${MO[month]} ${day} ${ts.substring(11,16)}`;
  }

  function floorToFiveMinute(ts) {
    if (!ts || ts.length < 16) return ts;
    return ts.substring(0,14) + String(Math.floor(+ts.substring(14,16)/5)*5).padStart(2,"0");
  }

  /* ── data normalisation ─────────────────────────────────────────────────── */
  function normalizeYearDataset(dataset) {
    if (!dataset) return null;
    const norm = {
      plant: dataset.plant, fid: dataset.fid, year: dataset.year,
      pumps: dataset.pumps || [],
      timestamps: dataset.timestamps || [],
      flow_mean:  dataset.flow_mean  || dataset.flow || [],
      flow_min:   dataset.flow_min   || dataset.flow || [],
      flow_max:   dataset.flow_max   || dataset.flow || [],
      flow_count: dataset.flow_count || (dataset.flow || []).map(v => (v == null ? 0 : 1)),
      wwl_mean:   dataset.wwl_mean   || dataset.wwl  || [],
      wwl_min:    dataset.wwl_min    || dataset.wwl  || [],
      wwl_max:    dataset.wwl_max    || dataset.wwl  || [],
      wwl_count:  dataset.wwl_count  || (dataset.wwl  || []).map(v => (v == null ? 0 : 1)),
      pump_status: dataset.pump_status || {},
    };
    if (dataset.wwl_east_mean || dataset.wwl_east || dataset.wwl_east_max) {
      norm.wwl_east_mean  = dataset.wwl_east_mean  || dataset.wwl_east || [];
      norm.wwl_east_min   = dataset.wwl_east_min   || dataset.wwl_east || [];
      norm.wwl_east_max   = dataset.wwl_east_max   || dataset.wwl_east || [];
      norm.wwl_east_count = dataset.wwl_east_count || norm.wwl_east_mean.map(v => (v == null ? 0 : 1));
      norm.wwl_west_mean  = dataset.wwl_west_mean  || dataset.wwl_west || [];
      norm.wwl_west_min   = dataset.wwl_west_min   || dataset.wwl_west || [];
      norm.wwl_west_max   = dataset.wwl_west_max   || dataset.wwl_west || [];
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
      .filter(Boolean).map(normalizeYearDataset);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    const allPumps = [...new Set(datasets.flatMap(d => d.pumps))].sort();
    const merged = {
      plant: datasets[0].plant, fid: datasets[0].fid, pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow_mean:  mergeMetricSeries(datasets,"flow_mean"),
      flow_min:   mergeMetricSeries(datasets,"flow_min"),
      flow_max:   mergeMetricSeries(datasets,"flow_max"),
      flow_count: mergeMetricSeries(datasets,"flow_count"),
      wwl_mean:   mergeMetricSeries(datasets,"wwl_mean"),
      wwl_min:    mergeMetricSeries(datasets,"wwl_min"),
      wwl_max:    mergeMetricSeries(datasets,"wwl_max"),
      wwl_count:  mergeMetricSeries(datasets,"wwl_count"),
      pump_status: Object.fromEntries(
        allPumps.map(pump => [pump, datasets.flatMap(d => d.pump_status[pump] || new Array(d.timestamps.length).fill(null))])
      ),
    };
    if (datasets.some(d => d.wwl_east_mean)) {
      merged.wwl_east_mean  = mergeMetricSeries(datasets,"wwl_east_mean");
      merged.wwl_east_min   = mergeMetricSeries(datasets,"wwl_east_min");
      merged.wwl_east_max   = mergeMetricSeries(datasets,"wwl_east_max");
      merged.wwl_east_count = mergeMetricSeries(datasets,"wwl_east_count");
      merged.wwl_west_mean  = mergeMetricSeries(datasets,"wwl_west_mean");
      merged.wwl_west_min   = mergeMetricSeries(datasets,"wwl_west_min");
      merged.wwl_west_max   = mergeMetricSeries(datasets,"wwl_west_max");
      merged.wwl_west_count = mergeMetricSeries(datasets,"wwl_west_count");
    }
    return merged;
  }

  function mergeRainYears(years) {
    const datasets = years.map(year => window.__wwtp_rain && window.__wwtp_rain[year]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return { ...datasets[0], timestamps: datasets.flatMap(d=>d.timestamps), rain: datasets.flatMap(d=>d.rain), freq: datasets[0].freq ? datasets.flatMap(d=>d.freq||[]) : null };
  }

  function mergeRainYearsGauge(years, ns) {
    const datasets = years.map(year => window[ns] && window[ns][year]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return { ...datasets[0], timestamps: datasets.flatMap(d=>d.timestamps), rain: datasets.flatMap(d=>d.rain) };
  }

  /* ── data loading ───────────────────────────────────────────────────────── */
  async function loadRainYears(years) {
    if (!hasRain()) { rainYearData = null; return; }
    if (isMultiGauge()) {
      const gauge = selectedRainGauge || PLANT_CONFIG.rain.gauges[0].id;
      const ns = `__wwtp_rain_g${gauge}`;
      for (const year of years) {
        if (!window[ns] || !window[ns][year]) {
          try { await loadScript(PLANT_CONFIG.dataDir + `rain_g${gauge}_${year}.js`); } catch(e) {}
        }
      }
      rainYearData = mergeRainYearsGauge(years, ns);
    } else {
      for (const year of years) {
        if (!window.__wwtp_rain || !window.__wwtp_rain[year]) {
          try { await loadScript(PLANT_CONFIG.dataDir + "rain_" + year + ".js"); } catch(e) {}
        }
      }
      rainYearData = mergeRainYears(years);
    }
  }

  async function loadYears(years) {
    setLoading(true); hideStatus();
    try {
      for (const year of years) {
        if (!window.__wwtp_year || !window.__wwtp_year[year]) {
          await loadScript(PLANT_CONFIG.dataDir + year + ".js");
        }
      }
      const data = mergeYearData(years);
      if (!data) throw new Error("No yearly data found");
      yearData = data; legendState = null;
      await loadRainYears(years);
      sel.months = []; sel.days = []; sel.weeks = [];
      if (msMonth) msMonth.clear();
      if (msDay)   msDay.clear();
      if (msWeek)  msWeek.clear();
      populateMonths();
      updateDayOptions([], [], false);
      populateWeeks([]);
      await refreshActiveView();
    } catch(e) {
      setStatus("No data for selected years");
    } finally {
      setLoading(false);
    }
  }

  async function loadMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2,"0")}`;
    if (minuteCache[key]) return minuteCache[key];
    if (minuteCache[key+"_loading"]) return null;
    minuteCache[key+"_loading"] = true;
    try {
      await loadScript(PLANT_CONFIG.dataDir + key + "_min.js");
      const data = window.__wwtp_min && window.__wwtp_min[key];
      if (data) minuteCache[key] = data;
      return data || null;
    } catch(e) { return null; } finally { delete minuteCache[key+"_loading"]; }
  }

  async function loadRainMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2,"0")}`;
    if (rainMinuteCache[key]) return rainMinuteCache[key];
    if (rainMinuteCache[key+"_loading"]) return null;
    rainMinuteCache[key+"_loading"] = true;
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
    } catch(e) { return null; } finally { delete rainMinuteCache[key+"_loading"]; }
  }

  function mergeMinuteData(keys) {
    const datasets = keys.map(key => minuteCache[key]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    const allPumps = [...new Set(datasets.flatMap(d => d.pumps || []))].sort();
    const merged = {
      year: datasets[0].year, month: null, pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow: datasets.flatMap(d => d.flow),
      wwl:  datasets.flatMap(d => d.wwl),
      pump_status: Object.fromEntries(
        allPumps.map(pump => [pump, datasets.flatMap(d => d.pump_status[pump] || new Array(d.timestamps.length).fill(null))])
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
    return { gauge: datasets[0].gauge, timestamps: datasets.flatMap(d=>d.timestamps), rain: datasets.flatMap(d=>d.rain) };
  }

  /* ── UI helpers ─────────────────────────────────────────────────────────── */
  function setLoading(on)  { const el=document.getElementById("loading-msg"); if(el) el.style.display=on?"block":"none"; }
  function setStatus(msg)  { const el=document.getElementById("status-msg");  if(!el) return; el.textContent=msg; el.style.display="block"; }
  function hideStatus()    { const el=document.getElementById("status-msg");  if(el) el.style.display="none"; }

  function customRangeDays() {
    if (!hasCustomRange()) return 0;
    return Math.round((new Date(sel.dateTo) - new Date(sel.dateFrom)) / 86400000) + 1;
  }

  /* ── resolution logic ───────────────────────────────────────────────────── */
  function getResolutionMode() {
    if (hasCustomRange()) {
      if (hasSingleYear() && customRangeDays() <= 31) return "minute";
      return "daily";
    }
    if (hasSingleYear() && sel.days.length && sel.months.length) return "minute";
    if (hasSingleYear() && sel.weeks.length) return "minute";
    if (sel.months.length) return "hourly";
    return "daily";
  }

  function selectedMinuteKeys() {
    if (!hasSingleYear() || !yearData) return [];
    const year = sel.years[0];
    if (hasCustomRange()) {
      const fromMonth = parseInt(sel.dateFrom.substring(5,7));
      const toMonth   = parseInt(sel.dateTo.substring(5,7));
      const keys = [];
      for (let m = fromMonth; m <= toMonth; m++) keys.push(`${year}_${String(m).padStart(2,"0")}`);
      return keys;
    }
    if (sel.days.length) {
      if (!sel.months.length) return [];
      return sel.months.slice().sort((a,b)=>a-b).map(month => `${year}_${String(month).padStart(2,"0")}`);
    }
    if (!sel.weeks.length) return [];
    const months = [...new Set(
      yearData.timestamps
        .filter(ts => { if (sel.months.length && !sel.months.includes(+ts.substring(5,7))) return false; return sel.weeks.includes(isoWeek(ts)); })
        .map(ts => +ts.substring(5,7))
    )].sort((a,b)=>a-b);
    return months.map(month => `${year}_${String(month).padStart(2,"0")}`);
  }

  /* ── data filtering ─────────────────────────────────────────────────────── */
  function filterSeriesSlice(src, matcher) {
    const mask = src.timestamps.map(matcher);
    const fi   = arr => (arr ? arr.filter((_,i) => mask[i]) : null);
    const out  = { timestamps: fi(src.timestamps), pumps: src.pumps || [] };
    ["flow","flow_mean","flow_min","flow_max","flow_count",
     "wwl","wwl_mean","wwl_min","wwl_max","wwl_count",
     "wwl_east","wwl_east_mean","wwl_east_min","wwl_east_max","wwl_east_count",
     "wwl_west","wwl_west_mean","wwl_west_min","wwl_west_max","wwl_west_count",
     "rain"].forEach(key => { if (src[key]) out[key] = fi(src[key]); });
    if (src.pump_status) {
      out.pump_status = Object.fromEntries(out.pumps.map(pump => [pump, fi(src.pump_status[pump] || [])]));
    }
    if (src.granularity) out.granularity = src.granularity;
    return out;
  }

  function filterHourlySlice(src) {
    if (hasCustomRange()) return filterSeriesSlice(src, ts => { const d=ts.substring(0,10); return d>=sel.dateFrom && d<=sel.dateTo; });
    return filterSeriesSlice(src, ts => !sel.months.length || sel.months.includes(+ts.substring(5,7)));
  }

  function filterMinuteSlice(src) {
    if (hasCustomRange()) return filterSeriesSlice(src, ts => { const d=ts.substring(0,10); return d>=sel.dateFrom && d<=sel.dateTo; });
    return filterSeriesSlice(src, ts => {
      if (sel.months.length && !sel.months.includes(+ts.substring(5,7))) return false;
      if (sel.days.length   && !sel.days.includes(+ts.substring(8,10)))   return false;
      if (sel.weeks.length  && !sel.weeks.includes(isoWeek(ts)))           return false;
      return true;
    });
  }

  function filterDateRangeSlice(slice) {
    return filterSeriesSlice(slice, ts => { const d=ts.substring(0,10); return (!sel.dateFrom||d>=sel.dateFrom) && (!sel.dateTo||d<=sel.dateTo); });
  }

  /* ── daily aggregation ──────────────────────────────────────────────────── */
  function weightedMean(values, counts) {
    let wt = 0, tc = 0;
    values.forEach((v,i) => { const c=counts[i]||0; if (v==null||!c) return; wt+=v*c; tc+=c; });
    return tc ? wt/tc : null;
  }

  function aggregateDailyMetric(timestamps, meanValues, minValues, maxValues, countValues) {
    const buckets = {};
    timestamps.forEach((ts,i) => {
      const day = ts.substring(0,10);
      if (!buckets[day]) buckets[day] = { means:[], mins:[], maxes:[], counts:[] };
      if (meanValues[i]  != null) buckets[day].means.push(meanValues[i]);
      if (minValues[i]   != null) buckets[day].mins.push(minValues[i]);
      if (maxValues[i]   != null) buckets[day].maxes.push(maxValues[i]);
      const c = countValues[i]||0;
      if (c) buckets[day].counts.push(c); else if (meanValues[i]!=null) buckets[day].counts.push(1);
    });
    const days = Object.keys(buckets).sort();
    return {
      timestamps: days,
      mean:  days.map(d => weightedMean(buckets[d].means, buckets[d].counts)),
      min:   days.map(d => minVal(buckets[d].mins)),
      max:   days.map(d => maxVal(buckets[d].maxes)),
      count: days.map(d => sum(buckets[d].counts)||0),
    };
  }

  function aggregateDailyRain(timestamps, rain) {
    const buckets = {};
    timestamps.forEach((ts,i) => { const day=ts.substring(0,10); if(!buckets[day]) buckets[day]=[]; if(rain[i]!=null) buckets[day].push(rain[i]); });
    const days = Object.keys(buckets).sort();
    return { timestamps: days, rain: days.map(d => sum(buckets[d])||0), granularity: "daily" };
  }

  function aggregateDailySlice(src) {
    const flow = aggregateDailyMetric(src.timestamps, src.flow_mean, src.flow_min, src.flow_max, src.flow_count);
    const wwl  = aggregateDailyMetric(src.timestamps, src.wwl_mean,  src.wwl_min,  src.wwl_max,  src.wwl_count);
    const buckets = {};
    src.timestamps.forEach((ts,i) => {
      const day = ts.substring(0,10);
      if (!buckets[day]) buckets[day] = {};
      src.pumps.forEach(pump => {
        if (!buckets[day][pump]) buckets[day][pump] = [];
        const v = src.pump_status[pump][i];
        if (v != null) buckets[day][pump].push(v);
      });
    });
    const days = flow.timestamps;
    const out = {
      timestamps: days, pumps: src.pumps,
      flow_mean: flow.mean, flow_min: flow.min, flow_max: flow.max, flow_count: flow.count,
      wwl_mean:  wwl.mean,  wwl_min:  wwl.min,  wwl_max:  wwl.max,  wwl_count:  wwl.count,
      pump_status: Object.fromEntries(
        src.pumps.map(pump => [pump, days.map(day => maxVal((buckets[day]&&buckets[day][pump])||[]))])
      ),
      granularity: "daily",
    };
    if (src.wwl_east_mean) {
      const east = aggregateDailyMetric(src.timestamps, src.wwl_east_mean, src.wwl_east_min, src.wwl_east_max, src.wwl_east_count);
      const west = aggregateDailyMetric(src.timestamps, src.wwl_west_mean, src.wwl_west_min, src.wwl_west_max, src.wwl_west_count);
      out.wwl_east_mean = east.mean; out.wwl_east_min = east.min; out.wwl_east_max = east.max; out.wwl_east_count = east.count;
      out.wwl_west_mean = west.mean; out.wwl_west_min = west.min; out.wwl_west_max = west.max; out.wwl_west_count = west.count;
    }
    return out;
  }

  /* ── active-pump / side filters ─────────────────────────────────────────── */
  function filterActivePumps(vd) {
    const active = (vd.pumps||[]).filter(pump => (vd.pump_status[pump]||[]).some(v => v!=null && v>0));
    return { ...vd, pumps: active, pump_status: Object.fromEntries(active.map(p=>[p,vd.pump_status[p]])) };
  }

  function applySideFilter(vd) {
    if (!vd || !selectedSide || !PLANT_CONFIG.pumpGroups) return vd;
    const pumpIds = PLANT_CONFIG.pumpGroups[selectedSide] || [];
    const out = { ...vd, pumps: (vd.pumps||[]).filter(p=>pumpIds.includes(p)), pump_status: Object.fromEntries((vd.pumps||[]).filter(p=>pumpIds.includes(p)).map(p=>[p,vd.pump_status[p]])) };
    if (selectedSide==="east" && vd.wwl_east_mean) { out.wwl_mean=vd.wwl_east_mean; out.wwl_min=vd.wwl_east_min; out.wwl_max=vd.wwl_east_max; out.wwl_count=vd.wwl_east_count; }
    else if (selectedSide==="west" && vd.wwl_west_mean) { out.wwl_mean=vd.wwl_west_mean; out.wwl_min=vd.wwl_west_min; out.wwl_max=vd.wwl_west_max; out.wwl_count=vd.wwl_west_count; }
    if (selectedSide==="east" && vd.wwl_east) out.wwl=vd.wwl_east;
    else if (selectedSide==="west" && vd.wwl_west) out.wwl=vd.wwl_west;
    return out;
  }

  /* ── view data getters ──────────────────────────────────────────────────── */
  function getMinuteViewSlice() {
    const keys = selectedMinuteKeys();
    if (!keys.length) return null;
    if (keys.some(key => !minuteCache[key])) return null;
    const merged = mergeMinuteData(keys);
    if (!merged) return null;
    return { ...filterMinuteSlice(merged), granularity: "minute" };
  }

  function getActiveViewData() {
    if (!yearData) return null;
    const resolution = getResolutionMode();
    if (resolution === "minute") {
      const minute = getMinuteViewSlice();
      if (minute) return applySideFilter(minute);
      return applySideFilter(filterSeriesSlice(
        { ...filterHourlySlice(yearData), granularity: "hourly" },
        ts => !sel.days.length || sel.days.includes(+ts.substring(8,10))
      ));
    }
    if (resolution === "hourly") return applySideFilter({ ...filterHourlySlice(yearData), granularity: "hourly" });
    const daily = aggregateDailySlice(yearData);
    return applySideFilter(hasCustomRange() ? filterDateRangeSlice(daily) : daily);
  }

  function getRainViewData() {
    if (!rainYearData) return null;
    if (isPolygonRain()) {
      const rangeFn = hasCustomRange()
        ? ts => ts >= sel.dateFrom && ts <= sel.dateTo
        : sel.months.length ? ts => sel.months.includes(+ts.substring(5,7)) : null;
      if (!rangeFn) return rainYearData;
      const mask = rainYearData.timestamps.map(rangeFn);
      const fi = arr => arr ? arr.filter((_,i) => mask[i]) : null;
      return { ...rainYearData, timestamps: fi(rainYearData.timestamps), rain: fi(rainYearData.rain), freq: rainYearData.freq ? fi(rainYearData.freq) : null };
    }
    const resolution = getResolutionMode();
    if (resolution === "minute") {
      const keys = selectedMinuteKeys();
      if (keys.some(key => !rainMinuteCache[key])) {
        return filterSeriesSlice({ ...rainYearData, pumps:[], granularity:"hourly" }, ts => {
          if (hasCustomRange()) return ts.substring(0,10)>=sel.dateFrom && ts.substring(0,10)<=sel.dateTo;
          return (!sel.months.length||sel.months.includes(+ts.substring(5,7))) && (!sel.days.length||sel.days.includes(+ts.substring(8,10)));
        });
      }
      const merged = mergeRainMinuteData(keys);
      if (!merged) return null;
      return { ...filterSeriesSlice({ ...merged, pumps:[], granularity:"5min" }, ts => {
        if (hasCustomRange()) return ts.substring(0,10)>=sel.dateFrom && ts.substring(0,10)<=sel.dateTo;
        if (sel.months.length && !sel.months.includes(+ts.substring(5,7))) return false;
        if (sel.days.length   && !sel.days.includes(+ts.substring(8,10)))   return false;
        if (sel.weeks.length  && !sel.weeks.includes(isoWeek(ts)))           return false;
        return true;
      }), granularity:"5min" };
    }
    const hourly = filterSeriesSlice({ ...rainYearData, pumps:[], granularity:"hourly" }, ts => {
      if (hasCustomRange()) return ts.substring(0,10)>=sel.dateFrom && ts.substring(0,10)<=sel.dateTo;
      return !sel.months.length || sel.months.includes(+ts.substring(5,7));
    });
    if (resolution === "hourly") return hourly;
    return aggregateDailyRain(hourly.timestamps, hourly.rain);
  }

  function alignRainToTimestamps(targetTimestamps, rainVd) {
    if (!rainVd) return null;
    if (rainVd.polygon || (rainVd.timestamps.length && rainVd.timestamps[0].length === 10)) {
      const lookup = {};
      rainVd.timestamps.forEach((ts,i) => { lookup[ts] = { rain: rainVd.rain[i], freq: rainVd.freq ? rainVd.freq[i] : null }; });
      return { data: targetTimestamps.map(ts => { const e=lookup[ts.substring(0,10)]; return e ? e.rain : null; }), freqByDate: lookup, granularity: "daily" };
    }
    const lookup = Object.fromEntries(rainVd.timestamps.map((ts,i)=>[ts,rainVd.rain[i]]));
    return {
      data: targetTimestamps.map(ts => {
        if (Object.prototype.hasOwnProperty.call(lookup, ts)) return lookup[ts];
        if (rainVd.granularity === "5min") { const f=floorToFiveMinute(ts); return Object.prototype.hasOwnProperty.call(lookup,f) ? lookup[f] : null; }
        return null;
      }),
      lookup, granularity: rainVd.granularity,
    };
  }

  /* ── plant-config derived values ────────────────────────────────────────── */
  function criticalWwlValue() {
    const cfg = PLANT_CONFIG.criticalWwl;
    if (!cfg) return null;
    if (typeof cfg === "number") return cfg;
    if (selectedSide && cfg[selectedSide] != null) return cfg[selectedSide];
    if (cfg.default != null) return cfg.default;
    return Object.values(cfg).find(v => typeof v === "number") ?? null;
  }

  function criticalWwlLabel() {
    const v = criticalWwlValue();
    return v == null ? CRITICAL_WWL_NAME : `${CRITICAL_WWL_NAME} (${(+v).toFixed(0)} ft)`;
  }

  /* ── legend state ───────────────────────────────────────────────────────── */
  function isLegendActive(name, fallback) {
    if (legendState === null || !(name in legendState)) {
      if (fallback != null) return fallback;
      return name !== "Rain, in";
    }
    return legendState[name];
  }

  /* ── stats helpers ──────────────────────────────────────────────────────── */
  function groupedRawStats(timestamps, values, keyFn) {
    const buckets = {};
    timestamps.forEach((ts,i) => { const v=values[i]; if(v==null) return; const k=keyFn(ts); if(!buckets[k]) buckets[k]=[]; buckets[k].push(v); });
    return Object.keys(buckets).sort().map(k => ({ min: Math.min(...buckets[k]), mean: avg(buckets[k]), max: Math.max(...buckets[k]) }));
  }

  function groupedBucketStats(timestamps, meanValues, minValues, maxValues, countValues, keyFn) {
    const buckets = {};
    timestamps.forEach((ts,i) => {
      const mv=meanValues[i], minv=minValues[i], maxv=maxValues[i], c=countValues[i]||0;
      if (mv==null && minv==null && maxv==null && !c) return;
      const k=keyFn(ts); if(!buckets[k]) buckets[k]={mins:[],maxes:[],wt:0,n:0};
      if (minv!=null) buckets[k].mins.push(minv);
      if (maxv!=null) buckets[k].maxes.push(maxv);
      if (mv!=null && c) { buckets[k].wt+=mv*c; buckets[k].n+=c; } else if (mv!=null) { buckets[k].wt+=mv; buckets[k].n+=1; }
    });
    return Object.keys(buckets).sort().map(k => ({ min: minVal(buckets[k].mins), mean: buckets[k].n ? buckets[k].wt/buckets[k].n : null, max: maxVal(buckets[k].maxes) })).filter(s=>s.mean!=null||s.min!=null||s.max!=null);
  }

  function summarizeGroupedStats(statsByGroup) {
    if (!statsByGroup.length) return { min:null, mean:null, max:null };
    return { min: minVal(statsByGroup.map(s=>s.min)), mean: avg(statsByGroup.map(s=>s.mean)), max: maxVal(statsByGroup.map(s=>s.max)) };
  }

  function renderPermitPanel() {
    const aaf = PLANT_CONFIG.permit && PLANT_CONFIG.permit.aaf;
    if (!aaf) return;
    const peak2hr = PLANT_CONFIG.permit.peak2hr;
    const container = document.getElementById("filter-stats");
    if (!container || container.querySelector(".permit-group")) return;
    const divider = document.createElement("div"); divider.className = "fstat-divider";
    const group = document.createElement("div"); group.className = "fstat-group permit-group";
    group.innerHTML = '<div class="fstat-label">Permit, MGD</div><table class="fstat-table"><tbody>' +
      '<tr><th>Limit</th><td>' + aaf.toFixed(1) + '</td></tr>' +
      '<tr><th>75%</th><td style="color:#e6a52e">' + (aaf*0.75).toFixed(1) + '</td></tr>' +
      '<tr><th>90%</th><td style="color:#cf4336">' + (aaf*0.90).toFixed(1) + '</td></tr>' +
      (peak2hr ? '<tr><th>2-Hr Peak</th><td style="color:#ef4444">' + peak2hr.toFixed(1) + '</td></tr>' : '') +
      '</tbody></table>';
    container.appendChild(divider); container.appendChild(group);
  }

  function renderStatisticsPanel(slice) {
    const fmt = v => (v==null ? "—" : v.toFixed(2));
    const permitAaf = PLANT_CONFIG.permit && PLANT_CONFIG.permit.aaf;
    const set = (id, v) => {
      const el = document.getElementById(id); if (!el) return;
      el.textContent = fmt(v);
      if (permitAaf && id.startsWith("stat-flow-") && v!=null) {
        const ratio = v/permitAaf;
        if (ratio>=0.90) { el.style.color="#cf4336"; el.style.fontWeight="700"; }
        else if (ratio>=0.75) { el.style.color="#e6a52e"; el.style.fontWeight="700"; }
        else { el.style.color=""; el.style.fontWeight=""; }
      }
    };
    const daily  = ts => ts.substring(0,10);
    const weekly = ts => isoWeekInfo(ts).key;
    const isBucketed = !!slice.flow_mean;
    const flowD = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.flow_mean, slice.flow_min, slice.flow_max, slice.flow_count, daily))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.flow, daily));
    const flowW = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.flow_mean, slice.flow_min, slice.flow_max, slice.flow_count, weekly))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.flow, weekly));
    set("stat-flow-d-min",flowD.min); set("stat-flow-d-mean",flowD.mean); set("stat-flow-d-max",flowD.max);
    set("stat-flow-w-min",flowW.min); set("stat-flow-w-mean",flowW.mean); set("stat-flow-w-max",flowW.max);
    const wwlD = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.wwl_mean, slice.wwl_min, slice.wwl_max, slice.wwl_count, daily))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.wwl, daily));
    const wwlW = isBucketed
      ? summarizeGroupedStats(groupedBucketStats(slice.timestamps, slice.wwl_mean, slice.wwl_min, slice.wwl_max, slice.wwl_count, weekly))
      : summarizeGroupedStats(groupedRawStats(slice.timestamps, slice.wwl, weekly));
    set("stat-wwl-d-min",wwlD.min); set("stat-wwl-d-mean",wwlD.mean); set("stat-wwl-d-max",wwlD.max);
    set("stat-wwl-w-min",wwlW.min); set("stat-wwl-w-mean",wwlW.mean); set("stat-wwl-w-max",wwlW.max);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     CHART.JS RENDERING LAYER
     ══════════════════════════════════════════════════════════════════════════ */

  /* ── extrema (peak/valley) plugin ──────────────────────────────────────── */
  function computeExtrema(values, opts) {
    opts = opts || {};
    const n = values.length;
    const minSpacing = Math.max(4, Math.floor(n * 0.08));

    function localExtrema(kind) {
      const out = [];
      for (let i = 1; i < n - 1; i++) {
        const prev = values[i-1], curr = values[i], next = values[i+1];
        if (prev == null || curr == null || next == null) continue;
        const isPeak   = (curr >= prev && curr > next) || (curr > prev && curr >= next);
        const isValley = (curr <= prev && curr < next) || (curr < prev && curr <= next);
        if ((kind === "max" && isPeak) || (kind === "min" && isValley))
          out.push({ index: i, value: curr, type: kind });
      }
      return out;
    }

    function addSpaced(selected, candidates, limit) {
      for (const p of candidates) {
        if (selected.length >= limit) break;
        if (!selected.some(e => Math.abs(e.index - p.index) < minSpacing)) selected.push(p);
      }
    }

    const nonNull = values.map((v, i) => ({ value: v, index: i })).filter(p => p.value != null);
    if (!nonNull.length) return [];

    if (opts.multi) {
      const selected = [];
      const peaks   = localExtrema("max").sort((a, b) => b.value - a.value);
      const valleys = localExtrema("min").sort((a, b) => a.value - b.value);
      addSpaced(selected, peaks, opts.maxPeaks || 2);
      addSpaced(selected, valleys, (opts.maxValleys == null ? 1 : opts.maxValleys) + selected.length);
      if (!selected.length) {
        const best = nonNull.reduce((b, p) => (p.value > b.value ? p : b));
        return [{ ...best, type: "max" }];
      }
      return selected.sort((a, b) => a.index - b.index);
    }
    const best = nonNull.reduce((b, p) => (p.value > b.value ? p : b));
    return [{ ...best, type: "max" }];
  }

  const extremaPlugin = {
    id: "extrema",
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const ca  = chart.chartArea;
      const leftThreshold = Math.max(3, Math.floor((chart.data.labels || []).length * 0.12));
      chart.data.datasets.forEach((ds, dsIdx) => {
        const eopts = ds.extremaOpts;
        if (!eopts) return;
        const meta = chart.getDatasetMeta(dsIdx);
        if (meta.hidden || ds.hidden) return;
        const points = computeExtrema(ds.data, typeof eopts === "object" ? eopts : {});
        if (!points.length) return;
        const yScale = chart.scales[ds.yAxisID || "y"];
        if (!yScale) return;
        const color = ds.borderColor || "#fff";

        ctx.save();
        ctx.font = "bold 10px system-ui,sans-serif";
        points.forEach(pt => {
          const mpt = meta.data[pt.index];
          if (!mpt) return;
          const xPx = mpt.x, yPx = yScale.getPixelForValue(pt.value);
          if (xPx < ca.left - 1 || xPx > ca.right + 1 || yPx < ca.top - 1 || yPx > ca.bottom + 1) return;

          // dot
          ctx.beginPath();
          ctx.arc(xPx, yPx, 4.5, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();

          // label
          const txt = (+pt.value).toFixed(2);
          const tw  = ctx.measureText(txt).width;
          const px = 5, py = 2, bh = 14, bw = tw + px * 2, r = 3;
          const isLeft = pt.index < leftThreshold;
          let lx = isLeft ? xPx + 9 : xPx - bw / 2;
          let ly = (pt.type === "max") ? yPx - bh - 7 : yPx + 7;
          lx = Math.max(ca.left, Math.min(ca.right - bw, lx));
          ly = Math.max(ca.top,  Math.min(ca.bottom - bh, ly));

          ctx.fillStyle = "rgba(12,21,34,0.92)";
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(lx+r,ly); ctx.lineTo(lx+bw-r,ly); ctx.quadraticCurveTo(lx+bw,ly,lx+bw,ly+r);
          ctx.lineTo(lx+bw,ly+bh-r); ctx.quadraticCurveTo(lx+bw,ly+bh,lx+bw-r,ly+bh);
          ctx.lineTo(lx+r,ly+bh); ctx.quadraticCurveTo(lx,ly+bh,lx,ly+bh-r);
          ctx.lineTo(lx,ly+r); ctx.quadraticCurveTo(lx,ly,lx+r,ly); ctx.closePath();
          ctx.fill(); ctx.stroke();

          ctx.fillStyle = "#eff5fb";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(txt, lx + px, ly + bh / 2);
        });
        ctx.restore();
      });
    },
  };
  Chart.register(extremaPlugin);

  /* ── chart instance management ──────────────────────────────────────────── */
  function makeChart(id, config) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    const el = document.getElementById(id);
    if (!el) return null;
    let canvas;
    if (el.tagName === "CANVAS") {
      canvas = el;
    } else {
      el.style.position = "relative";
      const existing = el.querySelector("canvas[data-cjs]");
      if (existing) existing.remove();
      canvas = document.createElement("canvas");
      canvas.setAttribute("data-cjs","1");
      canvas.style.cssText = "display:block;width:100%;height:100%;position:absolute;top:0;left:0;";
      el.appendChild(canvas);
    }
    // Wire zoom completion using the div id (closed over)
    const zp = config.options && config.options.plugins && config.options.plugins.zoom;
    if (zp && zp.zoom) zp.zoom.onZoomComplete = () => { showResetBtn(id); syncLinkedCharts(id); };
    charts[id] = new Chart(canvas, config);
    hideResetBtn(id);
    return charts[id];
  }

  /* ── zoom helpers ───────────────────────────────────────────────────────── */
  const OVERVIEW_CHART_IDS = ["chart-flow","chart-wwl","chart-combined-rain"];
  const SEPARATE_CHART_IDS = ["chart-sep-pumps","chart-sep-wwl","chart-sep-flow","chart-sep-rain"];
  const ALL_CHART_IDS      = [...OVERVIEW_CHART_IDS, ...SEPARATE_CHART_IDS];

  function showResetBtn(id) { const b=document.querySelector(`.zoom-reset-btn[data-chart="${id}"]`); if(b) b.style.display="inline-flex"; }
  function hideResetBtn(id) { const b=document.querySelector(`.zoom-reset-btn[data-chart="${id}"]`); if(b) b.style.display="none"; }

  function setResBadge(gran) {
    const labels = { daily:"Daily", hourly:"Hourly", minute:"1-min" };
    document.querySelectorAll(".res-badge").forEach(b => { b.textContent = labels[gran] || gran; });
  }

  function syncLinkedCharts(sourceId) {
    if (_syncing) return;
    const src = charts[sourceId];
    if (!src || !src.scales || !src.scales.x) return;
    const { min, max } = src.scales.x;
    _syncing = true;
    ALL_CHART_IDS.forEach(id => {
      if (id === sourceId) return;
      const c = charts[id]; if (!c || c.destroyed) return;
      c.options.scales.x.min = min; c.options.scales.x.max = max; c.update("none"); showResetBtn(id);
    });
    _syncing = false;
  }

  function zoomAllMinuteCharts(startTs, endTs) {
    Object.entries(MinuteChartReg).forEach(([id,c]) => {
      if (!c || c.destroyed) { delete MinuteChartReg[id]; return; }
      c.options.scales.x.min = startTs; c.options.scales.x.max = endTs; c.update("none");
    });
    document.querySelectorAll(".min-reset-zoom-btn").forEach(b => b.style.display="inline-flex");
  }

  /* ── drill-down state ───────────────────────────────────────────────────── */
  function _clearDrillState() {
    drillState = null;
    for (const k in MinuteChartReg) delete MinuteChartReg[k];
    document.querySelectorAll(".min-reset-zoom-btn").forEach(b => b.style.display="none");
    const bar = document.getElementById("drill-mode-bar"); if(bar) bar.style.display="none";
  }

  function exitDrillMode() { _clearDrillState(); renderActive(); }

  /* ── brush overlay ──────────────────────────────────────────────────────── */
  function makeBrushOverlay(divId, ovId) {
    const el = document.getElementById(divId); if (!el) return null;
    if (getComputedStyle(el).position==="static") el.style.position="relative";
    const ex = document.getElementById(ovId); if(ex) ex.remove();
    const ov = document.createElement("canvas"); ov.id=ovId;
    ov.style.cssText="position:absolute;top:0;left:0;pointer-events:none;z-index:10;";
    el.appendChild(ov); return ov;
  }

  function drawBrushRect(ov, refEl, x1, x2, chartTop, chartBottom) {
    ov.width=refEl.offsetWidth; ov.height=refEl.offsetHeight;
    ov.style.width=refEl.offsetWidth+"px"; ov.style.height=refEl.offsetHeight+"px";
    const ctx=ov.getContext("2d"); ctx.clearRect(0,0,ov.width,ov.height);
    const l=Math.min(x1,x2), w=Math.abs(x2-x1);
    const t=chartTop??0, h=(chartBottom??ov.height)-t;
    ctx.fillStyle="rgba(72,208,201,0.12)"; ctx.fillRect(l,t,w,h);
    ctx.strokeStyle="rgba(72,208,201,0.65)"; ctx.lineWidth=1.5; ctx.strokeRect(l,t,w,h);
  }

  function addDailyBrush(divId, labels) {
    const el = document.getElementById(divId); if(!el) return;
    el.style.cursor="crosshair";
    const canvas = el.querySelector("canvas[data-cjs]") || el;
    const ov = makeBrushOverlay(divId, divId+"--drill-ov");
    if (canvas.__drillBrushCleanup) canvas.__drillBrushCleanup();
    let sx=null, drag=false, sup=false;

    function pxToIdx(px) {
      const c = charts[divId]; if(!c) return null;
      return Math.min(Math.max(Math.round(c.scales.x.getValueForPixel(px)),0), labels.length-1);
    }
    function clearOv() { if(ov){const ctx=ov.getContext("2d");ctx.clearRect(0,0,ov.width,ov.height);} }

    const refEl = el.tagName==="CANVAS" ? el : (el.querySelector("canvas[data-cjs]")||el);
    const onDown = e=>{ sx=e.clientX-refEl.getBoundingClientRect().left; drag=false; };
    const onMove = e=>{ if(sx===null) return; const cx=e.clientX-refEl.getBoundingClientRect().left; if(Math.abs(cx-sx)>20) drag=true; if(drag&&ov){ const ca=charts[divId]&&charts[divId].chartArea; drawBrushRect(ov,refEl,sx,cx,ca&&ca.top,ca&&ca.bottom); } };
    const onUp   = e=>{
      if(sx===null) return;
      const ex=e.clientX-refEl.getBoundingClientRect().left;
      if(drag && Math.abs(ex-sx)>20) {
        sup=true; clearOv();
        const i1=pxToIdx(Math.min(sx,ex)), i2=pxToIdx(Math.max(sx,ex));
        if(i1!==null && i2!==null) {
          const d1=labels[i1]?labels[i1].substring(0,10):null, d2=labels[i2]?labels[i2].substring(0,10):null;
          if(d1&&d2) triggerDrillDown(d1,d2);
        }
      }
      sx=null; drag=false;
    };
    const onLeave = ()=>{ if(drag) clearOv(); sx=null; drag=false; };
    const onClick = e=>{ if(sup){sup=false;e.stopImmediatePropagation();} };

    refEl.addEventListener("mousedown",onDown); refEl.addEventListener("mousemove",onMove);
    refEl.addEventListener("mouseup",onUp);     refEl.addEventListener("mouseleave",onLeave);
    refEl.addEventListener("click",onClick,true);
    canvas.__drillBrushCleanup=()=>{
      refEl.removeEventListener("mousedown",onDown); refEl.removeEventListener("mousemove",onMove);
      refEl.removeEventListener("mouseup",onUp);     refEl.removeEventListener("mouseleave",onLeave);
      refEl.removeEventListener("click",onClick,true);
      el.style.cursor="";
    };
  }

  function addMinuteBrush(divId, labels) {
    const el = document.getElementById(divId); if(!el) return;
    const canvas = el.querySelector("canvas[data-cjs]") || el;
    const ov = makeBrushOverlay(divId, divId+"--min-ov");
    if (canvas.__minBrushCleanup) canvas.__minBrushCleanup();
    let sx=null, drag=false, sup=false;

    function pxToIdx(px) {
      const c=charts[divId]; if(!c) return null;
      return Math.min(Math.max(Math.round(c.scales.x.getValueForPixel(px)),0), labels.length-1);
    }
    function clearOv() { if(ov){const ctx=ov.getContext("2d");ctx.clearRect(0,0,ov.width,ov.height);} }

    const refEl = el.tagName==="CANVAS" ? el : (canvas||el);
    const onDown  = e=>{ sx=e.clientX-refEl.getBoundingClientRect().left; drag=false; };
    const onMove  = e=>{ if(sx===null) return; const cx=e.clientX-refEl.getBoundingClientRect().left; if(Math.abs(cx-sx)>20) drag=true; if(drag&&ov){ const ca=charts[divId]&&charts[divId].chartArea; drawBrushRect(ov,refEl,sx,cx,ca&&ca.top,ca&&ca.bottom); } };
    const onUp    = e=>{
      if(sx===null) return;
      const ex=e.clientX-refEl.getBoundingClientRect().left;
      if(drag && Math.abs(ex-sx)>20) {
        sup=true; clearOv();
        const i1=pxToIdx(Math.min(sx,ex)), i2=pxToIdx(Math.max(sx,ex));
        if(i1!==null && i2!==null && labels[i1] && labels[i2]) zoomAllMinuteCharts(labels[i1],labels[i2]);
      }
      sx=null; drag=false;
    };
    const onLeave = ()=>{ if(drag) clearOv(); sx=null; drag=false; };
    const onClick = e=>{ if(sup){sup=false;e.stopImmediatePropagation();} };

    refEl.addEventListener("mousedown",onDown); refEl.addEventListener("mousemove",onMove);
    refEl.addEventListener("mouseup",onUp);     refEl.addEventListener("mouseleave",onLeave);
    refEl.addEventListener("click",onClick,true);
    canvas.__minBrushCleanup=()=>{
      refEl.removeEventListener("mousedown",onDown); refEl.removeEventListener("mousemove",onMove);
      refEl.removeEventListener("mouseup",onUp);     refEl.removeEventListener("mouseleave",onLeave);
      refEl.removeEventListener("click",onClick,true);
    };
  }

  /* ── minute range loader ────────────────────────────────────────────────── */
  async function loadMinuteRange(startDate, endDate) {
    const s=new Date(startDate+"T00:00"), e=new Date(endDate+"T00:00");
    const months=[]; const cur=new Date(s.getFullYear(),s.getMonth(),1);
    while(cur<=e){ months.push({year:cur.getFullYear(),month:cur.getMonth()+1}); cur.setMonth(cur.getMonth()+1); }
    setLoading(true);
    await Promise.all(months.map(({year,month})=>loadMinuteData(year,month)));
    setLoading(false);
    const keys = months.map(({year,month})=>`${year}_${String(month).padStart(2,"0")}`);
    const merged = mergeMinuteData(keys.filter(k=>minuteCache[k]));
    if (!merged) return null;
    return filterSeriesSlice(merged, ts => ts>=startDate+" 00:00" && ts<=endDate+" 23:59");
  }

  /* ── drill-down trigger ─────────────────────────────────────────────────── */
  async function triggerDrillDown(startDate, endDate) {
    if (_drilling || !sel.years.length) return;
    if (startDate>endDate) [startDate,endDate]=[endDate,startDate];
    _drilling=true;
    try {
      const bar=document.getElementById("drill-mode-bar"), infoEl=document.getElementById("drill-mode-info");
      const nDays=Math.round((new Date(endDate+"T00:00")-new Date(startDate+"T00:00"))/86400000)+1;
      if(bar) bar.style.display="flex";
      if(infoEl) infoEl.innerHTML=`⏳ Loading&nbsp;&nbsp;<strong style="color:#f1f5fb">${startDate} → ${endDate}</strong>&nbsp;&nbsp;~<strong style="color:#48d0c9">${(nDays*1440).toLocaleString()} rows</strong>…`;
      const md = await loadMinuteRange(startDate, endDate);
      if(!md||!md.timestamps.length){ if(infoEl) infoEl.textContent=`${startDate} → ${endDate} — no data`; return; }
      if(infoEl) infoEl.innerHTML=`<strong style="color:#f1f5fb">${startDate} → ${endDate}</strong>&nbsp;&nbsp;<strong style="color:#48d0c9">${md.timestamps.length.toLocaleString()} rows</strong>&nbsp;&nbsp;<span style="color:var(--muted);font-size:11px">Drag to zoom · charts sync</span>`;
      const adapted = { ...md, granularity: "minute" };
      drillState = { startDate, endDate, adapted };
      renderActive();
    } finally { _drilling=false; }
  }

  /* ── Chart.js config helpers ────────────────────────────────────────────── */
  function tooltipConfig(labels, gran) {
    const multiYear = labels.length>0 && labels[0].substring(0,4)!==labels[labels.length-1].substring(0,4);
    return {
      backgroundColor: TIP_BG, borderColor: TIP_BORDER, borderWidth:1,
      titleColor:"#eff5fb", bodyColor:"#b4c0d0",
      titleFont:{weight:"bold",size:12}, bodyFont:{size:12},
      filter: item => !item.dataset.label.startsWith("__"),
      callbacks: {
        title: items => fmtLabel(labels[items[0].dataIndex], gran, multiYear),
        label: item => {
          const v=item.raw; if(v==null) return null;
          const fmt=typeof v==="number"?(Number.isInteger(v)?v:+v.toFixed(2)):v;
          return ` ${item.dataset.label}: ${fmt}`;
        },
      },
    };
  }

  function zoomPluginConfig() {
    return { zoom: { wheel:{enabled:true,speed:0.08}, pinch:{enabled:true}, mode:"x" } };
  }

  function xScaleConfig(labels, gran) {
    const multiYear = labels.length>0 && labels[0].substring(0,4)!==labels[labels.length-1].substring(0,4);
    return {
      ticks: {
        maxTicksLimit:14, color:TICK_COLOR, font:{size:11},
        maxRotation: labels.length>200?30:0,
        callback(val) { const ts=labels[val]; return ts ? fmtLabel(ts,gran,multiYear) : ""; },
      },
      grid: { color:GRID_COLOR },
    };
  }

  function yLeftConfig(title) {
    return { position:"left", title:{display:true,text:title,color:TICK_COLOR,font:{size:11}}, ticks:{color:TICK_COLOR,font:{size:11}}, grid:{color:GRID_COLOR} };
  }

  function yRightConfig(title) {
    return { position:"right", title:{display:true,text:title,color:TICK_COLOR,font:{size:11}}, ticks:{color:TICK_COLOR,font:{size:11}}, grid:{drawOnChartArea:false} };
  }

  function buildDailyAvgData(timestamps, values) {
    const buckets={};
    timestamps.forEach((ts,i)=>{ const d=ts.substring(0,10); if(!buckets[d]) buckets[d]={s:0,n:0}; if(values[i]!=null){buckets[d].s+=values[i];buckets[d].n++;} });
    const lk={}; Object.entries(buckets).forEach(([d,{s,n}])=>{ lk[d]=n?s/n:null; });
    return timestamps.map(ts=>lk[ts.substring(0,10)]);
  }

  function rainFreqColor(freq) {
    if (freq==null||freq<=0) return RAIN_COLOR;
    if (freq<2)   return RAIN_COLOR;
    if (freq<5)   return "#f4c26b";
    if (freq<10)  return "#e6a52e";
    if (freq<25)  return "#d46b2d";
    if (freq<100) return "#cf4336";
    return "#9b7fd4";
  }

  /* ── Chart.js dataset builders ──────────────────────────────────────────── */
  function buildComboChart(vd, metricKey, metricLabel, metricColor, metricMaxColor, rainVd) {
    const labels=vd.timestamps, n=labels.length, gran=vd.granularity, isMin=gran==="minute";
    const isBucketed=!!vd[metricKey+"_mean"];
    const mainData=isBucketed?vd[metricKey+"_mean"]:vd[metricKey];
    const maxData=isBucketed?vd[metricKey+"_max"]:null;
    const showDailyAvg=metricKey==="flow"&&gran==="hourly";
    const rain=rainVd?alignRainToTimestamps(labels,rainVd):null;
    const rainMax=rain?Math.max(...(rain.data.filter(v=>v!=null&&v>0)||[0.1]),0.1):0;
    const aaf=PLANT_CONFIG.permit&&PLANT_CONFIG.permit.aaf;
    const peak2hr=PLANT_CONFIG.permit&&PLANT_CONFIG.permit.peak2hr;

    const datasets=[
      // Pump status bars
      ...vd.pumps.map(pump=>({
        type:"bar", label:pump, data:vd.pump_status[pump],
        backgroundColor:stablePumpColor(pump), borderWidth:0, stack:"pumps",
        yAxisID:"y", barPercentage:isMin?1.0:0.85, categoryPercentage:isMin?1.0:0.9,
        hidden:!isLegendActive(pump), order:3,
      })),
      // Rain overlay bars
      ...(rain?[{
        type:"bar", label:"Rain, in", data:rain.data,
        backgroundColor:hexToRgba(RAIN_COLOR,0.60), borderWidth:0,
        yAxisID:"y2", barPercentage:isMin?0.9:0.85, categoryPercentage:isMin?1.0:0.9,
        hidden:!isLegendActive("Rain, in"), order:4,
      }]:[]),
      // 75% / 90% / 2-Hr Peak thresholds
      ...(aaf&&metricKey==="flow"?[{
        type:"line", label:THRESHOLD_75_NAME, data:new Array(n).fill(aaf*0.75),
        borderColor:THRESHOLD_75_COLOR, backgroundColor:"transparent",
        borderWidth:1.8, borderDash:[6,4], pointRadius:0,
        yAxisID:"y1", hidden:!isLegendActive(THRESHOLD_75_NAME,false), order:5,
      },{
        type:"line", label:THRESHOLD_90_NAME, data:new Array(n).fill(aaf*0.90),
        borderColor:THRESHOLD_90_COLOR, backgroundColor:"transparent",
        borderWidth:1.8, borderDash:[6,4], pointRadius:0,
        yAxisID:"y1", hidden:!isLegendActive(THRESHOLD_90_NAME,false), order:5,
      }]:[]),
      ...(peak2hr&&metricKey==="flow"?[{
        type:"line", label:PEAK_2HR_NAME, data:new Array(n).fill(peak2hr),
        borderColor:PEAK_2HR_COLOR, backgroundColor:"transparent",
        borderWidth:1.8, borderDash:[6,4], pointRadius:0,
        yAxisID:"y1", hidden:!isLegendActive(PEAK_2HR_NAME,false), order:5,
      }]:[]),
      // Critical WWL
      ...(metricKey==="wwl"&&criticalWwlValue()!=null?[{
        type:"line", label:CRITICAL_WWL_NAME, data:new Array(n).fill(criticalWwlValue()),
        borderColor:CRITICAL_WWL_COLOR, backgroundColor:"transparent",
        borderWidth:1.8, borderDash:[6,4], pointRadius:0,
        yAxisID:"y1", hidden:!isLegendActive(CRITICAL_WWL_NAME,true), order:5,
      }]:[]),
      // Daily avg
      ...(showDailyAvg?[{
        type:"line", label:DAILY_AVG_NAME, data:buildDailyAvgData(labels,mainData),
        borderColor:DAILY_AVG_COLOR, backgroundColor:"transparent",
        borderWidth:1.8, pointRadius:0, stepped:"before",
        yAxisID:"y1", hidden:!isLegendActive(DAILY_AVG_NAME,false), order:4,
      }]:[]),
      // Main metric line
      {
        type:"line", label:isBucketed?`${metricLabel} Mean`:metricLabel, data:mainData,
        borderColor:metricColor, backgroundColor:"transparent",
        borderWidth:2.5, pointRadius:0, spanGaps:false,
        yAxisID:"y1", hidden:!isLegendActive(isBucketed?`${metricLabel} Mean`:metricLabel), order:2,
        ...(!maxData?{extremaOpts:true}:{}),
      },
      // Max metric line
      ...(maxData?[{
        type:"line", label:`${metricLabel} Max`, data:maxData,
        borderColor:metricMaxColor, backgroundColor:"transparent",
        borderWidth:1.8, borderDash:[6,4], pointRadius:0, spanGaps:false,
        yAxisID:"y1", hidden:!isLegendActive(`${metricLabel} Max`), order:2,
        ...(!isMin?{extremaOpts:{multi:true,maxPeaks:2,maxValleys:1}}:{}),
      }]:[]),
    ];

    return {
      type:"bar",
      data:{ labels, datasets },
      options:{
        animation:false, responsive:true, maintainAspectRatio:false,
        interaction:{mode:"index",intersect:false},
        plugins:{
          legend:{display:false},
          tooltip:tooltipConfig(labels,gran),
          zoom:zoomPluginConfig(),
        },
        scales:{
          x:xScaleConfig(labels,gran),
          y:{ ...yLeftConfig("Pump Status (0/1)"), stacked:true, min:0 },
          y1:yRightConfig(metricLabel),
          ...(rain?{y2:{display:false,position:"right",min:0,max:rainMax*4,grid:{drawOnChartArea:false}}}:{}),
        },
      },
    };
  }

  function buildPumpsChart(vd) {
    const labels=vd.timestamps, gran=vd.granularity, isMin=gran==="minute";
    return {
      type:"bar",
      data:{ labels, datasets: vd.pumps.map((pump,i)=>({
        label:pump, data:vd.pump_status[pump],
        backgroundColor:PUMP_COLORS[i%PUMP_COLORS.length], borderWidth:0, stack:"pumps",
        barPercentage:isMin?1.0:0.85, categoryPercentage:isMin?1.0:0.9,
      })) },
      options:{
        animation:false, responsive:true, maintainAspectRatio:false,
        interaction:{mode:"index",intersect:false},
        plugins:{ legend:{display:false}, tooltip:tooltipConfig(labels,gran), zoom:zoomPluginConfig() },
        scales:{ x:xScaleConfig(labels,gran), y:{...yLeftConfig("Pump Status (0/1)"),stacked:true,min:0} },
      },
    };
  }

  function buildMetricChart(vd, metricKey, label, color, maxColor) {
    const labels=vd.timestamps, n=labels.length, gran=vd.granularity, isMin=gran==="minute";
    const isBucketed=!!vd[metricKey+"_mean"];
    const mainData=isBucketed?vd[metricKey+"_mean"]:vd[metricKey];
    const maxData=isBucketed?vd[metricKey+"_max"]:null;
    const showDailyAvg=metricKey==="flow"&&gran==="hourly";
    const aaf=PLANT_CONFIG.permit&&PLANT_CONFIG.permit.aaf;
    const peak2hr=PLANT_CONFIG.permit&&PLANT_CONFIG.permit.peak2hr;

    const datasets=[
      ...(aaf&&metricKey==="flow"?[
        {type:"line",label:THRESHOLD_75_NAME,data:new Array(n).fill(aaf*0.75),borderColor:THRESHOLD_75_COLOR,backgroundColor:"transparent",borderWidth:1.8,borderDash:[6,4],pointRadius:0,hidden:!isLegendActive(THRESHOLD_75_NAME,false),order:5},
        {type:"line",label:THRESHOLD_90_NAME,data:new Array(n).fill(aaf*0.90),borderColor:THRESHOLD_90_COLOR,backgroundColor:"transparent",borderWidth:1.8,borderDash:[6,4],pointRadius:0,hidden:!isLegendActive(THRESHOLD_90_NAME,false),order:5},
      ]:[]),
      ...(peak2hr&&metricKey==="flow"?[
        {type:"line",label:PEAK_2HR_NAME,data:new Array(n).fill(peak2hr),borderColor:PEAK_2HR_COLOR,backgroundColor:"transparent",borderWidth:1.8,borderDash:[6,4],pointRadius:0,hidden:!isLegendActive(PEAK_2HR_NAME,false),order:5},
      ]:[]),
      ...(metricKey==="wwl"&&criticalWwlValue()!=null?[{type:"line",label:CRITICAL_WWL_NAME,data:new Array(n).fill(criticalWwlValue()),borderColor:CRITICAL_WWL_COLOR,backgroundColor:"transparent",borderWidth:1.8,borderDash:[6,4],pointRadius:0,hidden:!isLegendActive(CRITICAL_WWL_NAME,true),order:5}]:[]),
      ...(showDailyAvg?[{type:"line",label:DAILY_AVG_NAME,data:buildDailyAvgData(labels,mainData),borderColor:DAILY_AVG_COLOR,backgroundColor:"transparent",borderWidth:1.8,pointRadius:0,stepped:"before",hidden:!isLegendActive(DAILY_AVG_NAME,false),order:4}]:[]),
      {type:"line",label:isBucketed?`${label} Mean`:label,data:mainData,borderColor:color,backgroundColor:"transparent",borderWidth:2.5,pointRadius:0,spanGaps:false,hidden:!isLegendActive(isBucketed?`${label} Mean`:label),order:2,...(!maxData?{extremaOpts:true}:{})},
      ...(maxData?[{type:"line",label:`${label} Max`,data:maxData,borderColor:maxColor,backgroundColor:"transparent",borderWidth:1.8,borderDash:[6,4],pointRadius:0,spanGaps:false,hidden:!isLegendActive(`${label} Max`),order:2,...(!isMin?{extremaOpts:{multi:true,maxPeaks:2,maxValleys:1}}:{})}]:[]),
    ];

    return {
      type:"line",
      data:{ labels, datasets },
      options:{
        animation:false, responsive:true, maintainAspectRatio:false,
        interaction:{mode:"index",intersect:false},
        plugins:{ legend:{display:false}, tooltip:tooltipConfig(labels,gran), zoom:zoomPluginConfig() },
        scales:{ x:xScaleConfig(labels,gran), y:{...yLeftConfig(label),min:undefined} },
      },
    };
  }

  function buildRainChart(vd) {
    const labels=vd.timestamps, gran=vd.granularity||"daily";
    const hasFreq=Array.isArray(vd.freq)&&vd.freq.some(v=>v!=null&&v>0);
    const barColors=hasFreq?vd.timestamps.map((_,i)=>rainFreqColor(vd.freq&&vd.freq[i])):hexToRgba(RAIN_COLOR,0.75);
    return {
      type:"bar",
      data:{ labels, datasets:[{
        label:"Rainfall, in", data:vd.rain,
        backgroundColor:barColors, borderWidth:0,
        barPercentage:gran==="minute"?0.9:0.85, categoryPercentage:gran==="minute"?1.0:0.9,
      }] },
      options:{
        animation:false, responsive:true, maintainAspectRatio:false,
        interaction:{mode:"index",intersect:false},
        plugins:{ legend:{display:false}, tooltip:tooltipConfig(labels,gran), zoom:zoomPluginConfig() },
        scales:{ x:xScaleConfig(labels,gran), y:{...yLeftConfig("Rainfall, in"),min:0} },
      },
    };
  }

  /* ── legend controls ────────────────────────────────────────────────────── */
  function toggleDataset(chart, name, active) {
    const i=chart.data.datasets.findIndex(d=>d.label===name);
    if(i>=0){ chart.data.datasets[i].hidden=!active; chart.update("none"); }
  }

  function buildPillLegend(containerId, items, chart) {
    const container=document.getElementById(containerId); if(!container) return;
    container.style.cssText="display:flex;flex-wrap:wrap;gap:4px;padding:4px 14px 8px;align-items:center;justify-content:center;";
    function render() {
      container.innerHTML="";
      items.forEach(({name,color,label})=>{
        const active=isLegendActive(name);
        const border=active?color:"rgba(108,143,186,0.2)";
        const textCol=active?color:"rgba(180,192,208,0.38)";
        const bg=active?hexToRgba(color,0.07):"transparent";
        const pill=document.createElement("button"); pill.type="button";
        pill.style.cssText=`display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 7px;border-radius:12px;border:1px solid ${border};background:${bg};color:${textCol};cursor:pointer;font-size:11px;font-weight:600;font-family:inherit;transition:opacity 0.15s;user-select:none;line-height:1.3;${active?"":"text-decoration:line-through"}`;
        const swatch=document.createElement("span");
        swatch.style.cssText=`width:8px;height:4px;border-radius:2px;flex-shrink:0;background:${active?color:"rgba(180,192,208,0.12)"}`;
        const txt=document.createElement("span"); txt.textContent=label||name;
        pill.appendChild(swatch); pill.appendChild(txt);
        pill.addEventListener("mouseenter",()=>pill.style.opacity="0.78");
        pill.addEventListener("mouseleave",()=>pill.style.opacity="1");
        pill.addEventListener("click",()=>{
          if(!legendState) legendState={};
          legendState[name]=!isLegendActive(name);
          if(name==="Rain, in") sel.includeRain=legendState[name];
          toggleDataset(chart,name,legendState[name]);
          render();
        });
        container.appendChild(pill);
      });
    }
    render();
  }

  function buildThresholdKey(containerId, items, chart) {
    const container=document.getElementById(containerId); if(!container) return;
    container.style.cssText="display:flex;flex-wrap:wrap;gap:10px;padding:0;align-items:center;justify-content:flex-end;min-height:20px;align-self:start;";
    function render() {
      container.innerHTML="";
      items.forEach(({name,color,label})=>{
        const active=isLegendActive(name, name===CRITICAL_WWL_NAME?true:false);
        const btn=document.createElement("button"); btn.type="button";
        btn.style.cssText=`display:inline-flex;align-items:center;gap:8px;padding:0;border:none;background:transparent;color:${active?"#cfd8e6":"rgba(180,192,208,0.42)"};cursor:pointer;font-size:10px;font-weight:600;font-family:inherit;line-height:1.2;user-select:none;transition:opacity 0.15s,color 0.15s;`;
        const swatch=document.createElement("span");
        swatch.style.cssText=`width:10px;height:10px;flex-shrink:0;border:2px dashed ${active?color:"rgba(180,192,208,0.28)"};border-radius:2px;background:transparent;`;
        const text=document.createElement("span"); text.textContent=label||name;
        btn.appendChild(swatch); btn.appendChild(text);
        btn.addEventListener("mouseenter",()=>btn.style.opacity="0.78");
        btn.addEventListener("mouseleave",()=>btn.style.opacity="1");
        btn.addEventListener("click",()=>{
          if(!legendState) legendState={};
          const def=name===CRITICAL_WWL_NAME?true:false;
          legendState[name]=!isLegendActive(name,def);
          toggleDataset(chart,name,legendState[name]);
          render();
        });
        container.appendChild(btn);
      });
    }
    render();
  }

  /* ── render functions ───────────────────────────────────────────────────── */
  function cleanBrushes(ids) {
    ids.forEach(id=>{
      const el=document.getElementById(id); if(!el) return;
      const cv=el.querySelector("canvas[data-cjs]")||el;
      if(cv.__drillBrushCleanup){ cv.__drillBrushCleanup(); cv.__drillBrushCleanup=null; }
      if(cv.__minBrushCleanup){  cv.__minBrushCleanup();   cv.__minBrushCleanup=null; }
    });
  }

  function renderCombined(vd, rainVd) {
    cleanBrushes(OVERVIEW_CHART_IDS);
    const hasCombinedRainEl=!!document.getElementById("chart-combined-rain");
    const overlayRain=hasCombinedRainEl?null:rainVd;
    if(hasCombinedRainEl&&rainVd) {
      const rc=makeChart("chart-combined-rain",buildRainChart(rainVd));
      if(rc&&vd.granularity==="minute"){ MinuteChartReg["chart-combined-rain"]=rc; addMinuteBrush("chart-combined-rain",vd.timestamps); }
      else if(rc){ delete MinuteChartReg["chart-combined-rain"]; addDailyBrush("chart-combined-rain",vd.timestamps); }
    }

    const flowChart=makeChart("chart-flow",buildComboChart(vd,"flow","Flow, MGD",FLOW_COLOR,FLOW_MAX_COLOR,overlayRain));
    if(flowChart){
      const isBucketed=!!vd.flow_mean;
      const granLabel=vd.granularity==="minute"?"Flow 1-min":vd.granularity==="daily"?"Flow Daily":"Flow Hourly";
      if(document.getElementById("chart-flow-legend")){
        const pillItems=[
          ...vd.pumps.map(pump=>({name:pump,color:stablePumpColor(pump)})),
          ...(overlayRain?[{name:"Rain, in",color:RAIN_COLOR}]:[]),
          {name:isBucketed?"Flow, MGD Mean":"Flow, MGD",color:FLOW_COLOR,label:granLabel},
          ...(isBucketed?[{name:"Flow, MGD Max",color:FLOW_MAX_COLOR,label:"Flow Max"}]:[]),
          ...(vd.granularity==="hourly"?[{name:DAILY_AVG_NAME,color:DAILY_AVG_COLOR,label:"Daily Avg"}]:[]),
        ];
        buildPillLegend("chart-flow-legend",pillItems,flowChart);
      }
      if(document.getElementById("chart-flow-thresholds")&&PLANT_CONFIG.permit&&PLANT_CONFIG.permit.aaf){
        buildThresholdKey("chart-flow-thresholds",[
          {name:THRESHOLD_75_NAME,color:THRESHOLD_75_COLOR},
          {name:THRESHOLD_90_NAME,color:THRESHOLD_90_COLOR},
          ...(PLANT_CONFIG.permit.peak2hr?[{name:PEAK_2HR_NAME,color:PEAK_2HR_COLOR}]:[]),
        ],flowChart);
      }
    }

    const wwlChart=makeChart("chart-wwl",buildComboChart(vd,"wwl","WWL, ft",WWL_COLOR,WWL_MAX_COLOR,overlayRain));
    if(wwlChart&&document.getElementById("chart-wwl-thresholds")&&criticalWwlValue()!=null){
      buildThresholdKey("chart-wwl-thresholds",[
        {name:CRITICAL_WWL_NAME,color:CRITICAL_WWL_COLOR,label:criticalWwlLabel()},
      ],wwlChart);
    }

    if(vd.granularity==="minute"){
      if(flowChart){ MinuteChartReg["chart-flow"]=flowChart; addMinuteBrush("chart-flow",vd.timestamps); }
      if(wwlChart){  MinuteChartReg["chart-wwl"]=wwlChart;   addMinuteBrush("chart-wwl",vd.timestamps); }
    } else {
      delete MinuteChartReg["chart-flow"]; delete MinuteChartReg["chart-wwl"];
      if(flowChart) addDailyBrush("chart-flow",vd.timestamps);
      if(wwlChart)  addDailyBrush("chart-wwl",vd.timestamps);
    }
  }

  function renderSeparate(vd, rainVd) {
    cleanBrushes(SEPARATE_CHART_IDS);
    const pc=makeChart("chart-sep-pumps",buildPumpsChart(vd));
    const wc=makeChart("chart-sep-wwl",  buildMetricChart(vd,"wwl","WWL, ft",WWL_COLOR,WWL_MAX_COLOR));
    const fc=makeChart("chart-sep-flow", buildMetricChart(vd,"flow","Flow, MGD",FLOW_COLOR,FLOW_MAX_COLOR));

    const rainEl=document.getElementById("chart-sep-rain");
    if(rainEl){ if(rainVd) makeChart("chart-sep-rain",buildRainChart(rainVd)); else if(charts["chart-sep-rain"]){ charts["chart-sep-rain"].destroy(); delete charts["chart-sep-rain"]; } }

    if(vd.granularity==="minute"){
      if(pc){ MinuteChartReg["chart-sep-pumps"]=pc; addMinuteBrush("chart-sep-pumps",vd.timestamps); }
      if(wc){ MinuteChartReg["chart-sep-wwl"]=wc;   addMinuteBrush("chart-sep-wwl",vd.timestamps); }
      if(fc){ MinuteChartReg["chart-sep-flow"]=fc;  addMinuteBrush("chart-sep-flow",vd.timestamps); }
    } else {
      ["chart-sep-pumps","chart-sep-wwl","chart-sep-flow"].forEach(id=>delete MinuteChartReg[id]);
      if(pc) addDailyBrush("chart-sep-pumps",vd.timestamps);
      if(wc) addDailyBrush("chart-sep-wwl",vd.timestamps);
      if(fc) addDailyBrush("chart-sep-flow",vd.timestamps);
    }
  }

  function renderActive() {
    const active=document.querySelector(".tab-pane.active"); if(!active) return;

    if(drillState){
      const adapted=applySideFilter(drillState.adapted);
      hideStatus(); setResBadge("minute");
      if(active.id==="tab-combined") renderCombined(adapted,null);
      else renderSeparate(adapted,null);
      return;
    }

    _clearDrillState();
    const slice=getActiveViewData(); if(!slice) return;
    hideStatus(); setResBadge(slice.granularity);
    renderStatisticsPanel(slice);
    const rainVd=getRainViewData();
    if(active.id==="tab-combined") renderCombined(slice,rainVd);
    else renderSeparate(slice,rainVd);
  }

  /* ── filter population ──────────────────────────────────────────────────── */
  function populateMonths() {
    if(!yearData||!msMonth) return;
    const months=[...new Set(yearData.timestamps.map(ts=>+ts.substring(5,7)))].sort((a,b)=>a-b);
    msMonth.setOptions(months.map(m=>({value:m,label:MO[m-1]})));
  }

  function updateDayOptions(months, weeks, preserveSelection) {
    if(!msDay||!yearData) return;
    if(!hasSingleYear()){ sel.days=[]; msDay.setOptions([]); msDay.clear(); return; }
    let source=yearData.timestamps;
    if(months.length) source=source.filter(ts=>months.includes(+ts.substring(5,7)));
    if(weeks.length)  source=source.filter(ts=>weeks.includes(isoWeek(ts)));
    const days=[...new Set(source.map(ts=>+ts.substring(8,10)))].sort((a,b)=>a-b);
    const validDays=preserveSelection?sel.days.filter(d=>days.includes(d)):[];
    sel.days=validDays;
    msDay.setOptions(days.map(d=>({value:d,label:String(d)})));
    if(validDays.length) msDay.setSelected(validDays);
  }

  function populateWeeks(months) {
    if(!msWeek||!yearData) return;
    if(!hasSingleYear()){ sel.weeks=[]; msWeek.setOptions([]); msWeek.clear(); return; }
    const source=months.length?yearData.timestamps.filter(ts=>months.includes(+ts.substring(5,7))):yearData.timestamps;
    const weeks=[...new Set(source.map(ts=>isoWeek(ts)))].sort((a,b)=>a-b);
    msWeek.setOptions(weeks.map(w=>({value:w,label:"Week "+w})));
  }

  function syncGaugeFilterUI() {
    const el=document.getElementById("ms-gauge-rain"); if(!el) return;
    const label=el.closest("label");
    if(label) label.style.display=(isMultiGauge()&&sel.includeRain)?"":"none";
  }

  function updateRainToggleUI() {
    const btn=document.getElementById("btn-rain-toggle");
    if(btn){
      const enabled=rainEnabled();
      btn.disabled=!enabled;
      btn.classList.toggle("is-on",enabled&&sel.includeRain);
      btn.setAttribute("aria-pressed",enabled&&sel.includeRain?"true":"false");
    }
    syncGaugeFilterUI();
  }

  /* ── minute preload ─────────────────────────────────────────────────────── */
  async function preloadSelectedDetailData() {
    const keys=[...new Set(selectedMinuteKeys())];
    if(!keys.length) return {failures:[]};
    const loads=await Promise.all(keys.map(async key=>{
      const [year,month]=key.split("_");
      const data=await loadMinuteData(+year,+month);
      return {key,ok:!!data};
    }));
    if(hasRain()&&!isPolygonRain()&&(isMultiGauge()||sel.gauges.length)){
      await Promise.all(keys.map(async key=>{ const [year,month]=key.split("_"); await loadRainMinuteData(+year,+month); }));
    }
    return {failures:loads.filter(l=>!l.ok).map(l=>l.key)};
  }

  async function refreshActiveView() {
    _clearDrillState();
    hideStatus();
    const resolution=getResolutionMode();
    if(resolution==="minute"){ setLoading(true); await preloadSelectedDetailData(); setLoading(false); }
    renderActive();
  }

  /* ── init ───────────────────────────────────────────────────────────────── */
  async function init() {
    const title=document.getElementById("plant-title");
    if(title) title.textContent=PLANT_CONFIG.name;
    renderPermitPanel();

    /* inject drill mode bar + zoom CSS */
    const drillBar=document.createElement("div");
    drillBar.id="drill-mode-bar";
    drillBar.style.cssText="display:none;align-items:center;gap:12px;flex-wrap:wrap;padding:9px 20px;background:rgba(72,208,201,0.07);border-bottom:1px solid rgba(72,208,201,0.18);";
    drillBar.innerHTML='<span style="font-size:13px;font-weight:700;color:#48d0c9">&#11015; Minute View</span><span id="drill-mode-info" style="font-size:12px;color:var(--muted)"></span><div style="margin-left:auto;display:flex;gap:8px;align-items:center"><button class="min-reset-zoom-btn zoom-reset-btn" style="display:none">&#8635; Reset Zoom</button><button id="drill-back-btn" class="zoom-reset-btn" style="display:inline-flex">&#8629; Back to Overview</button></div>';

    const subtabs=document.querySelector(".subtabs");
    const firstPane=document.querySelector(".tab-pane");
    if(subtabs&&subtabs.nextElementSibling) subtabs.parentNode.insertBefore(drillBar,subtabs.nextElementSibling);
    else if(firstPane) firstPane.parentNode.insertBefore(drillBar,firstPane);

    document.getElementById("drill-back-btn")&&document.getElementById("drill-back-btn").addEventListener("click",exitDrillMode);

    document.querySelectorAll(".min-reset-zoom-btn").forEach(btn=>{
      btn.addEventListener("click",()=>{
        Object.entries(MinuteChartReg).forEach(([id,c])=>{ if(!c||c.destroyed) return; delete c.options.scales.x.min; delete c.options.scales.x.max; c.update("none"); });
        document.querySelectorAll(".min-reset-zoom-btn").forEach(b=>b.style.display="none");
      });
    });

    /* per-chart zoom reset buttons — inject if not already in HTML */
    ALL_CHART_IDS.forEach(id=>{
      const el=document.getElementById(id); if(!el) return;
      const panelTitle=el.closest&&el.closest(".chart-panel")&&el.closest(".chart-panel").querySelector(".chart-panel-title");
      if(panelTitle){
        if(!panelTitle.querySelector(".res-badge")){
          const badge=document.createElement("span"); badge.className="res-badge";
          const firstChild=panelTitle.firstChild;
          if(firstChild&&firstChild.nodeType===3) panelTitle.insertBefore(badge,firstChild.nextSibling);
          else panelTitle.insertBefore(badge,panelTitle.firstChild&&panelTitle.firstChild.nextSibling||null);
        }
        if(!panelTitle.querySelector(".zoom-reset-btn")){
          const zb=document.createElement("button");
          zb.className="zoom-reset-btn"; zb.dataset.chart=id;
          zb.innerHTML="&#8635; Reset Zoom";
          zb.style.display="none";
          zb.addEventListener("click",()=>{
            const c=charts[id]; if(!c||c.destroyed) return;
            c.resetZoom(); hideResetBtn(id);
            ALL_CHART_IDS.forEach(oid=>{ if(oid===id) return; const oc=charts[oid]; if(!oc||oc.destroyed) return; oc.resetZoom(); hideResetBtn(oid); });
          });
          panelTitle.appendChild(zb);
        }
      }
    });

    /* inject zoom + drill CSS */
    const zoomStyle=document.createElement("style");
    zoomStyle.textContent=[
      ".zoom-reset-btn{display:none;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:8px;background:rgba(72,208,201,0.12);border:1px solid rgba(72,208,201,0.32);color:#48d0c9;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;transition:background 0.15s;flex-shrink:0;margin-left:auto;}",
      ".zoom-reset-btn:hover{background:rgba(72,208,201,0.22);}",
      ".zoom-hint{font-size:11px;color:rgba(180,192,208,0.55);font-weight:400;margin-left:8px;}",
      ".drillable{cursor:crosshair!important;}",
      ".chart-panel-title{display:flex;align-items:center;flex-wrap:wrap;gap:6px;}",
      ".res-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:rgba(72,208,201,0.12);border:1px solid rgba(72,208,201,0.25);color:#48d0c9;margin-left:4px;}",
    ].join("\n");
    document.head.appendChild(zoomStyle);

    try {
      await loadScript(PLANT_CONFIG.dataDir+"meta.js");
      meta=window.__wwtp_meta||null;
      if(!meta) throw new Error("Missing meta");
    } catch(e) {
      setStatus("Could not load meta.js — run preprocess.py first.");
      return;
    }

    msYear=createMultiSelect("ms-year","All Years",async years=>{
      if(hasCustomRange()) return;
      sel.years=years; minuteCache={}; rainMinuteCache={};
      await loadYears(years.length?years:meta.years);
    },{showAll:true});

    msMonth=createMultiSelect("ms-month","All Months",async months=>{
      if(hasCustomRange()) return;
      sel.months=months; sel.days=[]; sel.weeks=[];
      if(msDay) msDay.clear(); if(msWeek) msWeek.clear();
      updateDayOptions(months,[],false); populateWeeks(months);
      await refreshActiveView();
    },{showAll:true});

    msDay=createMultiSelect("ms-day","All Days",async days=>{
      if(hasCustomRange()) return;
      sel.days=days; await refreshActiveView();
    },{showAll:true});

    msWeek=createMultiSelect("ms-week","All Weeks",async weeks=>{
      if(hasCustomRange()) return;
      sel.weeks=weeks; sel.days=[]; if(msDay) msDay.clear();
      updateDayOptions(sel.months,weeks,false);
      await refreshActiveView();
    },{showAll:true});

    if(isMultiGauge()){
      const gauges=PLANT_CONFIG.rain.gauges;
      selectedRainGauge=gauges[0].id;
      const msGaugeRain=createMultiSelect("ms-gauge-rain","Gauge",async selected=>{
        if(!selected.length) return;
        const gauge=selected[selected.length-1];
        if(gauge===selectedRainGauge) return;
        selectedRainGauge=gauge; rainYearData=null; rainMinuteCache={};
        setLoading(true); await loadRainYears(sel.years.length?sel.years:meta.years); setLoading(false);
        await refreshActiveView();
      },{minSelected:1});
      if(msGaugeRain){
        const shortLabel=lbl=>lbl.replace(/ (Road|Street|Drive|Boulevard|Avenue|Lane)$/i,"");
        msGaugeRain.setOptions(gauges.map(g=>({value:g.id,label:`${g.id} · ${shortLabel(g.label)}`})));
        msGaugeRain.setSelected([gauges[0].id]);
      }
      syncGaugeFilterUI();
    } else if(hasRain()&&!isPolygonRain()){
      msGauge=createMultiSelect("ms-gauge","Gauge",async gauges=>{
        sel.gauges=gauges; updateRainToggleUI(); await refreshActiveView();
      });
      if(msGauge){
        const gaugeLabel=PLANT_CONFIG.rain.label?`${PLANT_CONFIG.rain.gauge} · ${PLANT_CONFIG.rain.label}`:`Gauge ${PLANT_CONFIG.rain.gauge}`;
        msGauge.setOptions([{value:PLANT_CONFIG.rain.gauge,label:gaugeLabel}]);
        sel.gauges=[PLANT_CONFIG.rain.gauge]; msGauge.setSelected(sel.gauges);
      } else {
        sel.gauges=[PLANT_CONFIG.rain.gauge];
      }
    }

    const rainToggleBtn=document.getElementById("btn-rain-toggle");
    if(rainToggleBtn){
      rainToggleBtn.addEventListener("click",async()=>{
        if(!rainEnabled()) return;
        sel.includeRain=!sel.includeRain; updateRainToggleUI(); renderActive();
      });
      updateRainToggleUI();
    }

    const sortedYears=meta.years.slice().sort((a,b)=>b-a);
    msYear.setOptions(sortedYears.map(year=>({value:year,label:String(year)})));
    const defaultYear=meta.years.includes(2026)?2026:meta.years[meta.years.length-1];
    sel.years=[defaultYear]; msYear.setSelected([defaultYear]);
    await loadYears([defaultYear]);

    const _now=new Date(), _curMonth=_now.getMonth()+1;
    const _availMonths=new Set((yearData?yearData.timestamps:[]).map(ts=>+ts.substring(5,7)));
    const defaultMonth=defaultYear===_now.getFullYear()
      ? ([..._availMonths].filter(m=>m<=_curMonth).sort((a,b)=>b-a)[0] ?? [..._availMonths].sort((a,b)=>b-a)[0] ?? 1)
      : 1;
    sel.months=[defaultMonth];
    if(msMonth) msMonth.setSelected([defaultMonth]);
    populateWeeks([defaultMonth]); updateDayOptions([defaultMonth],[],false);
    await refreshActiveView();

    document.querySelectorAll(".side-btn[data-side]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll(".side-btn").forEach(n=>n.classList.remove("active"));
        btn.classList.add("active"); selectedSide=btn.dataset.side; renderActive();
      });
    });

    /* custom date range UI */
    const filterControls=document.querySelector(".filter-controls");
    if(filterControls){
      const rangeStyle=document.createElement("style");
      rangeStyle.textContent=[
        ".range-sep{width:1px;height:22px;background:rgba(122,156,199,0.2);align-self:center;margin:0 4px;flex-shrink:0}",
        ".range-label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:14px;font-weight:600}",
        ".range-input{height:36px;border-radius:8px;border:1px solid rgba(108,143,186,0.36);background:#102032;color:var(--text);padding:0 8px;font:inherit;font-size:13px;color-scheme:dark;min-width:120px}",
        ".range-input:focus{outline:none;border-color:rgba(108,143,186,0.7)}",
        ".filter-controls.range-active>label:not(.range-label){opacity:0.4;pointer-events:none}",
        ".filter-controls.range-active>.multi-select{opacity:0.4;pointer-events:none}",
      ].join("");
      document.head.appendChild(rangeStyle);

      const sepEl=document.createElement("div"); sepEl.className="range-sep";
      const fromLabel=document.createElement("label"); fromLabel.className="range-label"; fromLabel.textContent="From ";
      const fromInput=document.createElement("input"); fromInput.type="date"; fromInput.id="inp-date-from"; fromInput.className="range-input";
      fromLabel.appendChild(fromInput);
      const toLabel=document.createElement("label"); toLabel.className="range-label"; toLabel.textContent="To ";
      const toInput=document.createElement("input"); toInput.type="date"; toInput.id="inp-date-to"; toInput.className="range-input";
      toLabel.appendChild(toInput);
      const minYear=Math.min(...meta.years), maxYear=Math.max(...meta.years);
      [fromInput,toInput].forEach(inp=>{ inp.min=`${minYear}-01-01`; inp.max=`${maxYear}-12-31`; });
      const existingReset=filterControls.querySelector("#btn-reset");
      filterControls.insertBefore(sepEl,existingReset||null);
      filterControls.insertBefore(fromLabel,existingReset||null);
      filterControls.insertBefore(toLabel,existingReset||null);

      async function applyDateRange(){
        if(!hasCustomRange()) return;
        const fromYear=parseInt(sel.dateFrom.substring(0,4)), toYear=parseInt(sel.dateTo.substring(0,4));
        const years=[]; for(let y=fromYear;y<=toYear;y++) if(meta.years.includes(y)) years.push(y);
        if(!years.length) return;
        filterControls.classList.add("range-active");
        sel.years=years; msYear.setSelected(years);
        sel.months=[]; sel.days=[]; sel.weeks=[];
        if(msMonth) msMonth.clear(); if(msDay) msDay.clear(); if(msWeek) msWeek.clear();
        minuteCache={}; rainMinuteCache={};
        await loadYears(years);
      }

      function clearDateRange(){
        sel.dateFrom=null; sel.dateTo=null; fromInput.value=""; toInput.value="";
        filterControls.classList.remove("range-active");
      }

      fromInput.addEventListener("change",async()=>{ sel.dateFrom=fromInput.value||null; if(hasCustomRange()) await applyDateRange(); else if(!sel.dateFrom) filterControls.classList.remove("range-active"); });
      toInput.addEventListener("change",  async()=>{ sel.dateTo=toInput.value||null;     if(hasCustomRange()) await applyDateRange(); else if(!sel.dateTo)   filterControls.classList.remove("range-active"); });

      const resetBtn=document.getElementById("btn-reset");
      if(resetBtn){
        resetBtn.addEventListener("click",async()=>{
          clearDateRange();
          sel.months=[]; sel.days=[]; sel.weeks=[];
          if(msMonth) msMonth.clear(); if(msDay) msDay.clear(); if(msWeek) msWeek.clear();
          updateDayOptions([],[],false); populateWeeks([]);
          await refreshActiveView();
        });
      }
    }

    document.querySelectorAll(".subtab[data-tab]").forEach(btn=>{
      btn.addEventListener("click",()=>{
        document.querySelectorAll(".subtab").forEach(n=>n.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach(p=>p.classList.remove("active"));
        btn.classList.add("active");
        const pane=document.getElementById("tab-"+btn.dataset.tab); if(pane) pane.classList.add("active");
        renderActive();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
