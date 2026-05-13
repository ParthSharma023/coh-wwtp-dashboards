/* dashboard.js — shared WWTP chart logic
 * Requires PLANT_CONFIG = { name, fid, dataDir } defined before this script.
 * Requires ECharts 5 loaded before this script.
 */
(function () {
  "use strict";

  const PUMP_COLORS = [
    "#5da8ff", "#41b9a8", "#e6a52e", "#d46b2d",
    "#cf4336", "#9b7fd4", "#74c6ea", "#6fd9cb",
    "#f4c26b", "#e89c76",
  ];
  const FLOW_COLOR  = "#f1f5fb";
  const LINE_WIDTHS = { flow: 2, wwl: 2.5 };
  const RAIN_COLOR  = "#48d0c9";
  const WWL_COLOR   = "#6ee7a0";
  const AXIS_COLOR  = "rgba(180,192,208,0.45)";
  const SPLIT_COLOR = "rgba(180,192,208,0.07)";
  const TIP_BG      = "#17273a";
  const TIP_BORDER  = "rgba(122,156,199,0.28)";

  let meta        = null;
  let rainYearData = null;
  let rainMinuteCache = {};
  let yearData    = null;
  let minuteCache = {};
  let charts      = {};
  let savedZoom   = null;
  let rerendering = false;
  let selectedSide = PLANT_CONFIG.pumpGroups ? "east" : null;

  const ZOOM_DAILY_THRESHOLD = 14;
  const ZOOM_MINUTE_THRESHOLD = 3;
  const MINUTE_MONTH_LIMIT = 3;
  const PUMP_DAILY_THRESHOLD = 31;
  const PUMP_MINUTE_THRESHOLD = 1;

  // opts: { showAll: bool, minSelected: int }
  function createMultiSelect(id, placeholder, onChange, opts) {
    opts = opts || {};
    const showAll    = opts.showAll    || false;
    const minSelected = opts.minSelected || 0;

    const el = document.getElementById(id);
    if (!el) return null;
    const trigger = el.querySelector(".ms-trigger");
    const panel   = el.querySelector(".ms-panel");
    let selected = [], options = [];

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
      setOptions(opts)  { options = opts; selected = []; renderPanel(); },
      setSelected(vals) { selected = vals; renderPanel(); },
      getSelected()     { return [...selected]; },
      clear()           { selected = []; renderPanel(); },
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

  const sel = { years: [], months: [], days: [], weeks: [], gauges: [], includeRain: true };
  let msYear = null, msMonth = null, msDay = null, msWeek = null, msGauge = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const avg    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const sum    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0) : null; };
  const maxVal = arr => { const v = arr.filter(x => x != null); return v.length ? Math.max(...v) : null; };
  const hasRain = () => !!(PLANT_CONFIG.rain && PLANT_CONFIG.rain.gauge);
  const rainEnabled = () => !hasRain() || sel.gauges.includes(PLANT_CONFIG.rain.gauge);
  const showRainOverlay = () => hasRain() && rainEnabled() && sel.includeRain;

  function isoWeek(ts) {
    const d = new Date(ts.length === 10 ? ts + "T00:00" : ts.replace(" ", "T"));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - y) / 86400000) + 1) / 7);
  }

  function fmtLabel(ts, granularity) {
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const month = +ts.substring(5,7) - 1;
    const day   = +ts.substring(8,10);
    if (granularity === "daily") return mo[month] + " " + day;
    return mo[month] + " " + day + " " + ts.substring(11,16);
  }

  function fmtAxisValue(value, granularity) {
    if (typeof value === "string") {
      return value.length >= 10 ? fmtLabel(value, granularity) : value;
    }
    if (typeof value !== "number") return String(value);
    const d = new Date(value);
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const label = `${mo[d.getMonth()]} ${d.getDate()}`;
    if (granularity === "daily") return label;
    return `${label} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function toTimeValue(ts) {
    if (typeof ts === "number") return ts;
    if (!ts) return ts;
    const normalized = ts.length === 10 ? `${ts}T00:00` : ts.replace(" ", "T");
    return new Date(normalized).getTime();
  }

  function floorToFiveMinute(ts) {
    if (!ts || ts.length < 16) return ts;
    const prefix = ts.substring(0, 14);
    const minute = +ts.substring(14, 16);
    return prefix + String(Math.floor(minute / 5) * 5).padStart(2, "0");
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

  // ── Year data loading + merging ───────────────────────────────────────────
  function mergeYearData(years) {
    const datasets = years.map(y => window.__wwtp_year && window.__wwtp_year[y]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    const allPumps = [...new Set(datasets.flatMap(d => d.pumps))].sort();
    const merged = {
      plant: datasets[0].plant, fid: datasets[0].fid,
      pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow:        datasets.flatMap(d => d.flow),
      wwl:         datasets.flatMap(d => d.wwl),
      pump_status: Object.fromEntries(allPumps.map(p => [
        p, datasets.flatMap(d => d.pump_status[p] || new Array(d.timestamps.length).fill(null))
      ])),
    };
    if (datasets[0].wwl_east != null) {
      merged.wwl_east = datasets.flatMap(d => d.wwl_east || new Array(d.timestamps.length).fill(null));
      merged.wwl_west = datasets.flatMap(d => d.wwl_west || new Array(d.timestamps.length).fill(null));
    }
    return merged;
  }

  function mergeRainYears(years) {
    const datasets = years.map(y => window.__wwtp_rain && window.__wwtp_rain[y]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];
    return {
      plant: datasets[0].plant,
      fid: datasets[0].fid,
      gauge: datasets[0].gauge,
      timestamps: datasets.flatMap(d => d.timestamps),
      rain: datasets.flatMap(d => d.rain),
    };
  }

  async function loadRainYears(years) {
    if (!hasRain()) {
      rainYearData = null;
      return;
    }
    for (const year of years) {
      if (!window.__wwtp_rain || !window.__wwtp_rain[year]) {
        try {
          await loadScript(PLANT_CONFIG.dataDir + "rain_" + year + ".js");
        } catch (e) {}
      }
    }
    rainYearData = mergeRainYears(years);
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
      if (!data) throw new Error("Not found");
      yearData = data;
      await loadRainYears(years);
      savedZoom = null;
      sel.months = []; sel.days = []; sel.weeks = [];
      if (msMonth) msMonth.clear();
      if (msDay)   msDay.clear();
      if (msWeek)  msWeek.clear();
      populateMonths(); updateDayOptions([], [], false); populateWeeks([]);
      renderActive();
    } catch(e) {
      setStatus("No data for selected years");
    } finally {
      setLoading(false);
    }
  }

  // ── Minute data loader ────────────────────────────────────────────────────
  async function loadMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2, "0")}`;
    if (minuteCache[key]) return minuteCache[key];
    if (minuteCache[key + "_loading"]) return null;
    minuteCache[key + "_loading"] = true;
    try {
      await loadScript(PLANT_CONFIG.dataDir + key + "_min.js");
      const data = window.__wwtp_min && window.__wwtp_min[key];
      if (data) {
        data.tsIndex = Object.fromEntries(data.timestamps.map((ts, i) => [ts, i]));
        minuteCache[key] = data;
      }
      return data || null;
    } catch (e) { return null; }
    finally { delete minuteCache[key + "_loading"]; }
  }

  function minuteKeys() {
    if (sel.years.length !== 1 || !sel.months.length || sel.months.length > MINUTE_MONTH_LIMIT) return null;
    const year = sel.years[0];
    return sel.months.slice().sort((a, b) => a - b).map(month =>
      `${year}_${String(month).padStart(2, "0")}`
    );
  }

  function minuteKey() {
    const keys = minuteKeys();
    return keys && keys.length === 1 ? keys[0] : null;
  }

  function mergeMinuteData(keys) {
    const datasets = keys.map(key => minuteCache[key]).filter(Boolean);
    if (!datasets.length) return null;
    if (datasets.length === 1) return datasets[0];

    const allPumps = [...new Set(datasets.flatMap(d => d.pumps || []))].sort();
    return {
      year: datasets[0].year,
      month: null,
      pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow: datasets.flatMap(d => d.flow),
      wwl: datasets.flatMap(d => d.wwl),
      wwl_east: datasets.flatMap(d => d.wwl_east || new Array(d.timestamps.length).fill(null)),
      wwl_west: datasets.flatMap(d => d.wwl_west || new Array(d.timestamps.length).fill(null)),
      pump_status: Object.fromEntries(allPumps.map(p => [
        p,
        datasets.flatMap(d => d.pump_status[p] || new Array(d.timestamps.length).fill(null)),
      ])),
    };
  }

  async function loadMinuteRange() {
    const keys = minuteKeys();
    if (!keys) return [];
    return loadMinuteKeys(keys);
  }

  async function loadMinuteKeys(keys) {
    if (!keys || !keys.length) return [];
    return Promise.all(keys.map(key => {
      if (minuteCache[key]) return Promise.resolve(minuteCache[key]);
      const [year, month] = key.split("_");
      return loadMinuteData(+year, +month);
    }));
  }

  async function preloadSelectedDetailData() {
    const loaders = [];
    if (minuteKeys()) loaders.push(loadMinuteRange());
    if (hasRain() && sel.years.length === 1 && sel.months.length === 1) {
      loaders.push(loadRainMinuteData(sel.years[0], sel.months[0]));
    }
    return loaders.length ? Promise.all(loaders) : [];
  }

  async function loadRainMinuteData(year, month) {
    const key = `${year}_${String(month).padStart(2, "0")}`;
    if (rainMinuteCache[key]) return rainMinuteCache[key];
    if (rainMinuteCache[key + "_loading"]) return null;
    rainMinuteCache[key + "_loading"] = true;
    try {
      await loadScript(PLANT_CONFIG.dataDir + "rain_" + key + "_min.js");
      const data = window.__wwtp_rain_min && window.__wwtp_rain_min[key];
      if (data) rainMinuteCache[key] = data;
      return data || null;
    } catch (e) { return null; }
    finally { delete rainMinuteCache[key + "_loading"]; }
  }

  function aggregateDailyRain(timestamps, rain) {
    const buckets = {};
    timestamps.forEach((ts, i) => {
      const day = ts.substring(0, 10);
      if (!buckets[day]) buckets[day] = [];
      if (rain[i] != null) buckets[day].push(rain[i]);
    });
    const days = Object.keys(buckets).sort();
    return {
      timestamps: days,
      rain: days.map(d => sum(buckets[d]) ?? 0),
      granularity: "daily",
    };
  }

  // ── Filter + aggregate ────────────────────────────────────────────────────
  function filterSourceSlice(src) {
    if (!yearData) return null;
    const { months, days, weeks } = sel;
    const { timestamps, flow, wwl, pump_status, pumps } = src;
    const gran = src.granularity || "hourly";

    const mask = timestamps.map(ts => {
      if (months.length && !months.includes(+ts.substring(5,7))) return false;
      if (days.length   && !days.includes(+ts.substring(8,10)))  return false;
      if (weeks.length  && !weeks.includes(isoWeek(ts)))         return false;
      return true;
    });

    const fi = arr => arr ? arr.filter((_,i) => mask[i]) : null;
    const tsFilt   = fi(timestamps);
    const flowFilt = fi(flow);
    const wwlFilt  = fi(wwl);
    const wwlEastFilt = fi(src.wwl_east);
    const wwlWestFilt = fi(src.wwl_west);
    const pumpFilt = {};
    pumps.forEach(p => { pumpFilt[p] = fi(pump_status[p]); });

    const extra = {};
    if (wwlEastFilt) { extra.wwl_east = wwlEastFilt; extra.wwl_west = wwlWestFilt; }

    return { timestamps: tsFilt, flow: flowFilt, wwl: wwlFilt, pump_status: pumpFilt, pumps, granularity: gran, ...extra };
  }

  function getBaseFilteredSlice() {
    return filterSourceSlice(yearData);
  }

  function indexRangeFromZoom(timestamps, zoom) {
    if (!timestamps || !timestamps.length) return { startIdx: 0, endIdx: -1 };
    const activeZoom = zoom === undefined ? savedZoom : zoom;
    if (!activeZoom) return { startIdx: 0, endIdx: timestamps.length - 1 };

    if (activeZoom.startTs != null && activeZoom.endTs != null) {
      const startValue = toTimeValue(activeZoom.startTs);
      const endValue = toTimeValue(activeZoom.endTs);
      let startIdx = 0;
      let endIdx = timestamps.length - 1;

      while (startIdx < timestamps.length && toTimeValue(timestamps[startIdx]) < startValue) startIdx += 1;
      while (endIdx >= 0 && toTimeValue(timestamps[endIdx]) > endValue) endIdx -= 1;

      if (startIdx >= timestamps.length) startIdx = timestamps.length - 1;
      if (endIdx < 0) endIdx = 0;
      if (endIdx < startIdx) {
        const anchor = Math.max(0, Math.min(timestamps.length - 1, startIdx));
        return { startIdx: anchor, endIdx: anchor };
      }
      return { startIdx, endIdx };
    }

    const lastIdx = timestamps.length - 1;
    const startIdx = Math.max(0, Math.floor((activeZoom.start / 100) * lastIdx));
    const endIdx = Math.min(lastIdx, Math.ceil((activeZoom.end / 100) * lastIdx));
    return { startIdx, endIdx };
  }

  function zoomPercentsForTimestamps(timestamps, zoom) {
    if (!timestamps || !timestamps.length) return { start: 0, end: 100 };
    const activeZoom = zoom === undefined ? savedZoom : zoom;
    if (!activeZoom) return { start: 0, end: 100 };
    const { startIdx, endIdx } = indexRangeFromZoom(timestamps, activeZoom);
    const lastIdx = Math.max(1, timestamps.length - 1);
    return {
      start: Math.max(0, Math.min(100, (startIdx / lastIdx) * 100)),
      end: Math.max(0, Math.min(100, (endIdx / lastIdx) * 100)),
    };
  }

  function zoomValueRangeForTimestamps(timestamps, zoom) {
    if (!timestamps || !timestamps.length) return {};
    const activeZoom = zoom === undefined ? savedZoom : zoom;
    if (!activeZoom || activeZoom.startTs == null || activeZoom.endTs == null) return {};
    return {
      startValue: toTimeValue(activeZoom.startTs),
      endValue: toTimeValue(activeZoom.endTs),
    };
  }

  function timestampBoundsFromValues(timestamps, startValue, endValue) {
    if (!timestamps || !timestamps.length) return { startTs: null, endTs: null };
    let startIdx = 0;
    let endIdx = timestamps.length - 1;
    while (startIdx < timestamps.length && toTimeValue(timestamps[startIdx]) < startValue) startIdx += 1;
    while (endIdx >= 0 && toTimeValue(timestamps[endIdx]) > endValue) endIdx -= 1;
    if (startIdx >= timestamps.length) startIdx = timestamps.length - 1;
    if (endIdx < 0) endIdx = 0;
    if (endIdx < startIdx) endIdx = startIdx;
    return {
      startTs: timestamps[startIdx] ?? timestamps[0] ?? null,
      endTs: timestamps[endIdx] ?? timestamps[timestamps.length - 1] ?? null,
    };
  }

  function visibleDays(slice, zoom) {
    if (!slice || !slice.timestamps || !slice.timestamps.length) return 0;
    return new Set(visibleTimestamps(slice, zoom).map(ts => ts.substring(0, 10))).size;
  }

  function visibleTimestamps(slice, zoom) {
    if (!slice || !slice.timestamps || !slice.timestamps.length) return [];
    const { startIdx, endIdx } = indexRangeFromZoom(slice.timestamps, zoom);
    return slice.timestamps.slice(startIdx, endIdx + 1);
  }

  function visibleIndexRange(target, zoom) {
    if (Array.isArray(target)) return indexRangeFromZoom(target, zoom);
    const length = target;
    if (!length) return { startIdx: 0, endIdx: -1 };
    const activeZoom = zoom === undefined ? savedZoom : zoom;
    if (!activeZoom) return { startIdx: 0, endIdx: length - 1 };
    const lastIdx = length - 1;
    const startIdx = Math.max(0, Math.floor((activeZoom.start / 100) * lastIdx));
    const endIdx = Math.min(lastIdx, Math.ceil((activeZoom.end / 100) * lastIdx));
    return { startIdx, endIdx };
  }

  function getResolutionMode(baseSlice, zoom) {
    const days = visibleDays(baseSlice, zoom);
    if (days > ZOOM_DAILY_THRESHOLD) return "daily";
    if (days >= ZOOM_MINUTE_THRESHOLD) return "hourly";
    if (minuteKeys()) return "minute";
    return "hourly";
  }

  function getLineMinuteSpec(baseSlice, zoom) {
    const selectedKeys = minuteKeys();
    if (selectedKeys) return { keys: selectedKeys, visibleScoped: false };
    if (sel.years.length !== 1 || !baseSlice || !baseSlice.timestamps || !baseSlice.timestamps.length) return null;
    if (visibleDays(baseSlice, zoom) >= ZOOM_MINUTE_THRESHOLD) return null;
    const months = [...new Set(visibleTimestamps(baseSlice, zoom).map(ts => +ts.substring(5, 7)))].sort((a, b) => a - b);
    if (!months.length || months.length > MINUTE_MONTH_LIMIT) return null;
    const year = sel.years[0];
    return {
      keys: months.map(month => `${year}_${String(month).padStart(2, "0")}`),
      visibleScoped: true,
    };
  }

  function getFlowMinuteSpec(baseSlice, zoom) {
    return getLineMinuteSpec(baseSlice, zoom);
  }

  function getWwlMinuteSpec(baseSlice, zoom) {
    return getLineMinuteSpec(baseSlice, zoom);
  }

  function flowMinuteSpecKey(spec) {
    if (!spec) return "";
    return `${spec.visibleScoped ? "visible" : "selected"}:${spec.keys.join(",")}`;
  }

  function getPumpGranularity(baseSlice, zoom) {
    const days = visibleDays(baseSlice, zoom);
    if (days > PUMP_DAILY_THRESHOLD) return "daily";
    if (days > PUMP_MINUTE_THRESHOLD) return "hourly";
    return "minute";
  }

  function getPumpMinuteSpec(baseSlice, zoom) {
    if (sel.years.length !== 1 || !baseSlice || !baseSlice.timestamps || !baseSlice.timestamps.length) return null;
    if (getPumpGranularity(baseSlice, zoom) !== "minute") return null;
    const selectedKeys = minuteKeys();
    if (selectedKeys) return { keys: selectedKeys, visibleScoped: false };
    const months = [...new Set(visibleTimestamps(baseSlice, zoom).map(ts => +ts.substring(5, 7)))].sort((a, b) => a - b);
    if (!months.length || months.length > MINUTE_MONTH_LIMIT) return null;
    const year = sel.years[0];
    return {
      keys: months.map(month => `${year}_${String(month).padStart(2, "0")}`),
      visibleScoped: true,
    };
  }

  function pumpMinuteSpecKey(spec) {
    if (!spec) return "";
    return `${spec.visibleScoped ? "visible" : "selected"}:${spec.keys.join(",")}`;
  }

  function getFilteredSlice() {
    const baseSlice = getBaseFilteredSlice();
    if (!baseSlice) return null;

    if (getResolutionMode(baseSlice) !== "minute") return baseSlice;

    const keys = minuteKeys();
    const minuteData = keys && mergeMinuteData(keys);
    if (!minuteData) return baseSlice;

    return filterSourceSlice({ ...minuteData, granularity: "minute" });
  }

  function getFlowChartData() {
    const baseSlice = getBaseFilteredSlice();
    const spec = getFlowMinuteSpec(baseSlice, savedZoom);
    if (spec) {
      const keys = spec.keys;
      const minuteData = mergeMinuteData(keys);
      if (minuteData) return { ...filterSourceSlice({ ...minuteData, granularity: "minute" }), visibleScoped: spec.visibleScoped };
    }
    return getFilteredSlice();
  }

  function getWwlChartData() {
    const baseSlice = getBaseFilteredSlice();
    const spec = getWwlMinuteSpec(baseSlice, savedZoom);
    if (spec) {
      const keys = spec.keys;
      const minuteData = mergeMinuteData(keys);
      if (minuteData) return { ...filterSourceSlice({ ...minuteData, granularity: "minute" }), visibleScoped: spec.visibleScoped };
    }
    return getFilteredSlice();
  }

  function getViewData() {
    const baseSlice = getBaseFilteredSlice();
    if (!baseSlice) return null;

    const resolution = getResolutionMode(baseSlice);
    const filtered = getFilteredSlice();
    if (!filtered) return null;
    if (resolution !== "daily") return filterActivePumps(filtered);

    const daily = aggregateDaily(baseSlice.timestamps, baseSlice.flow, baseSlice.wwl, baseSlice.pump_status, baseSlice.pumps);
    if (baseSlice.wwl_east) {
      const B = {};
      baseSlice.timestamps.forEach((ts, i) => {
        const day = ts.substring(0, 10);
        if (!B[day]) B[day] = { east: [], west: [] };
        if (baseSlice.wwl_east[i] != null) B[day].east.push(baseSlice.wwl_east[i]);
        if (baseSlice.wwl_west[i] != null) B[day].west.push(baseSlice.wwl_west[i]);
      });
      const maxVal2 = arr => arr.length ? Math.max(...arr) : null;
      daily.wwl_east = daily.timestamps.map(d => maxVal2(B[d] ? B[d].east : []));
      daily.wwl_west = daily.timestamps.map(d => maxVal2(B[d] ? B[d].west : []));
    }
    return filterActivePumps(daily);
  }

  function aggregatePumpBuckets(timestamps, pump_status, pumps, bucketFn, granularity) {
    const buckets = {};
    timestamps.forEach((ts, i) => {
      const key = bucketFn(ts);
      if (!buckets[key]) buckets[key] = {};
      pumps.forEach(p => {
        if (!buckets[key][p]) buckets[key][p] = [];
        if (pump_status[p][i] != null) buckets[key][p].push(pump_status[p][i]);
      });
    });
    const keys = Object.keys(buckets).sort();
    return {
      timestamps: keys,
      pumps,
      pump_status: Object.fromEntries(
        pumps.map(p => [p, keys.map(key => maxVal(buckets[key][p] || []))])
      ),
      granularity,
    };
  }

  function getPumpChartData() {
    const baseSlice = getBaseFilteredSlice();
    if (!baseSlice) return null;

    const granularity = getPumpGranularity(baseSlice, savedZoom);
    if (granularity === "daily") {
      return filterActivePumps(aggregatePumpBuckets(
        baseSlice.timestamps,
        baseSlice.pump_status,
        baseSlice.pumps,
        ts => ts.substring(0, 10),
        "daily"
      ));
    }

    if (granularity === "hourly") {
      return filterActivePumps({
        timestamps: baseSlice.timestamps,
        pump_status: baseSlice.pump_status,
        pumps: baseSlice.pumps,
        granularity: "hourly",
      });
    }

    const spec = getPumpMinuteSpec(baseSlice, savedZoom);
    if (spec) {
      const minuteData = mergeMinuteData(spec.keys);
      if (minuteData) {
        return filterActivePumps({
          ...filterSourceSlice({ ...minuteData, granularity: "minute" }),
          visibleScoped: spec.visibleScoped,
        });
      }
    }

    return filterActivePumps({
      timestamps: baseSlice.timestamps,
      pump_status: baseSlice.pump_status,
      pumps: baseSlice.pumps,
      granularity: "hourly",
    });
  }

  function getRainViewData() {
    if (!rainYearData || !rainEnabled()) return null;
    const { months, days, weeks } = sel;
    const mk = minuteKey();
    const useMins = days.length === 1 && months.length === 1 && mk && rainMinuteCache[mk];
    const src = useMins ? { ...rainMinuteCache[mk], granularity: "5min" } : rainYearData;
    const { timestamps, rain } = src;
    const gran = src.granularity || "hourly";

    const mask = timestamps.map(ts => {
      if (months.length && !months.includes(+ts.substring(5,7))) return false;
      if (days.length   && !days.includes(+ts.substring(8,10)))  return false;
      if (weeks.length  && !weeks.includes(isoWeek(ts)))         return false;
      return true;
    });

    const fi = arr => arr.filter((_,i) => mask[i]);
    const tsFilt   = fi(timestamps);
    const rainFilt = fi(rain);

    if (!months.length && !weeks.length) return aggregateDailyRain(tsFilt, rainFilt);
    return { timestamps: tsFilt, rain: rainFilt, granularity: gran };
  }

  function alignRainToTimestamps(targetTimestamps, rainVd) {
    if (!rainVd) return null;
    const lookup = Object.fromEntries(rainVd.timestamps.map((ts, i) => [ts, rainVd.rain[i]]));
    return {
      data: targetTimestamps.map(ts => Object.prototype.hasOwnProperty.call(lookup, ts) ? lookup[ts] : null),
      lookup,
      granularity: rainVd.granularity,
    };
  }


  function filterActivePumps(vd) {
    const activePumps = vd.pumps.filter(p =>
      vd.pump_status[p].some(v => v != null && v > 0)
    );
    return { ...vd, pumps: activePumps };
  }

  function aggregateDaily(timestamps, flow, wwl, pump_status, pumps) {
    const B = {};
    timestamps.forEach((ts, i) => {
      const day = ts.substring(0, 10);
      if (!B[day]) B[day] = { flow:[], wwl:[], pumps:{} };
      if (flow[i] != null) B[day].flow.push(flow[i]);
      if (wwl[i]  != null) B[day].wwl.push(wwl[i]);
      pumps.forEach(p => {
        if (!B[day].pumps[p]) B[day].pumps[p] = [];
        if (pump_status[p][i] != null) B[day].pumps[p].push(pump_status[p][i]);
      });
    });
    const days = Object.keys(B).sort();
    const pumpFilt = {};
    pumps.forEach(p => { pumpFilt[p] = days.map(d => maxVal(B[d].pumps[p])); });
    return {
      timestamps: days,
      flow:        days.map(d => maxVal(B[d].flow)),
      wwl:         days.map(d => maxVal(B[d].wwl)),
      pump_status: pumpFilt,
      pumps,
      granularity: "daily",
    };
  }

  // ── Chart options ─────────────────────────────────────────────────────────
  function xAxisOpt(timestamps, granularity) {
    const n = timestamps.length;
    const interval = Math.max(0, Math.floor(n / 10) - 1);
    return {
      type: "category",
      data: timestamps,
      axisLabel: {
        color: "#b4c0d0", fontSize: 11, interval,
        formatter: ts => fmtLabel(ts, granularity),
        rotate: n > 200 ? 30 : 0,
      },
      axisLine:  { lineStyle: { color: AXIS_COLOR } },
      axisTick:  { lineStyle: { color: AXIS_COLOR } },
      splitLine: { show: false },
    };
  }

  function timeXAxisOpt(granularity) {
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return {
      type: "time",
      axisLabel: {
        color: "#b4c0d0",
        fontSize: 11,
        formatter: value => {
          const d = new Date(value);
          const label = `${mo[d.getMonth()]} ${d.getDate()}`;
          if (granularity === "minute" || granularity === "hourly") {
            return `${label} ${String(d.getHours()).padStart(2, "0")}:00`;
          }
          return label;
        },
      },
      axisLine:  { lineStyle: { color: AXIS_COLOR } },
      axisTick:  { lineStyle: { color: AXIS_COLOR } },
      splitLine: { show: false },
    };
  }

  function yAxisLeft(name) {
    return {
      type: "value", name, min: 0,
      nameTextStyle: { color: "#b4c0d0", fontSize: 11 },
      axisLabel:     { color: "#b4c0d0", fontSize: 11 },
      axisLine:      { show: false },
      axisTick:      { show: false },
      splitLine:     { lineStyle: { color: SPLIT_COLOR } },
    };
  }

  function yAxisRight(name) {
    return { ...yAxisLeft(name), position: "right", splitLine: { show: false } };
  }

  function yAxisRain() {
    return {
      type: "value",
      min: 0,
      position: "right",
      offset: 58,
      axisLabel: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      name: "",
    };
  }

  function dataZoom(timestamps, granularity, useTimeValues) {
    const { start, end } = zoomPercentsForTimestamps(timestamps, savedZoom);
    const valueRange = useTimeValues ? zoomValueRangeForTimestamps(timestamps, savedZoom) : {};
    return [
      {
        type: "inside",
        xAxisIndex: 0,
        ...(valueRange.startValue != null ? valueRange : { start, end }),
      },
      {
        type: "slider",
        xAxisIndex: 0,
        height: 18,
        bottom: 4,
        ...(valueRange.startValue != null ? valueRange : { start, end }),
        fillerColor: "rgba(93,168,255,0.12)", borderColor: TIP_BORDER,
        textStyle: { color: "#b4c0d0", fontSize: 10 },
      },
    ];
  }

  let hoveredMinuteTs = null;
  const _minHoverListeners = {};

  function attachMinuteHover(chartId, chart, timestamps, granularity) {
    const prev = _minHoverListeners[chartId];
    if (prev) {
      prev.dom.removeEventListener("mousemove", prev.move);
      prev.dom.removeEventListener("mouseleave", prev.leave);
    }
    if (granularity === "minute") {
      hoveredMinuteTs = null;
      _minHoverListeners[chartId] = null;
      return;
    }
    const dom = chart.getDom();
    const n   = timestamps.length;
    const minsPerBar = granularity === "daily" ? 1440 : 60;

    const move = function(e) {
      const rect   = dom.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const x0     = chart.convertToPixel({ xAxisIndex: 0 }, 0);
      const x1     = chart.convertToPixel({ xAxisIndex: 0 }, n - 1);
      if (x0 == null || x1 == null || x1 === x0) { hoveredMinuteTs = null; return; }

      const floatIdx = (mouseX - x0) / (x1 - x0) * (n - 1);
      const barIdx   = Math.max(0, Math.min(n - 1, Math.floor(floatIdx)));
      const fraction = Math.max(0, Math.min(0.999, floatIdx - barIdx));
      const barTs    = timestamps[barIdx];

      const year  = +barTs.substring(0, 4);
      const month = +barTs.substring(5, 7);
      const mk    = `${year}_${String(month).padStart(2, "0")}`;
      const md    = minuteCache[mk];
      if (!md) { loadMinuteData(year, month); hoveredMinuteTs = null; return; }

      let minuteTs;
      if (granularity === "daily") {
        const totalMins = Math.round(fraction * minsPerBar);
        const estHour   = Math.floor(totalMins / 60);
        const estMin    = totalMins % 60;
        minuteTs = barTs + " " + String(estHour).padStart(2, "0") + ":" + String(estMin).padStart(2, "0");
      } else {
        const h      = +barTs.substring(11, 13);
        const estMin = Math.min(59, Math.round(fraction * 60));
        minuteTs = barTs.substring(0, 11) + String(h).padStart(2, "0") + ":" + String(estMin).padStart(2, "0");
      }

      const idx = md.tsIndex ? md.tsIndex[minuteTs] : md.timestamps.indexOf(minuteTs);
      if (idx != null && idx !== -1) {
        hoveredMinuteTs = { ts: minuteTs, flow: md.flow[idx], wwl: md.wwl[idx] };
      } else {
        hoveredMinuteTs = null;
      }
    };

    const leave = () => { hoveredMinuteTs = null; };
    dom.addEventListener("mousemove", move);
    dom.addEventListener("mouseleave", leave);
    _minHoverListeners[chartId] = { dom, move, leave };
  }

  function tooltip(opts) {
    opts = opts || {};
    const rainLookup = opts.rainLookup || null;
    const rainGranularity = opts.rainGranularity || null;
    const granularity = opts.granularity || null;
    const rainSeriesName = "Rain, in";
    return {
      trigger: "axis",
      backgroundColor: TIP_BG, borderColor: TIP_BORDER,
      textStyle: { color: "#eff5fb", fontSize: 12 },
      axisPointer: { type: "shadow" },
      formatter: params => {
        const axisTs = params[0].axisValue;
        const ts = fmtAxisValue(axisTs, granularity || "hourly");
        let out = '<div style="margin-bottom:4px;font-weight:600">' + ts + '</div>';
        params.forEach(p => {
          if (p.value == null || p.value === "-") return;
          const raw = p.value;
          const v = typeof raw === "number"
            ? (Number.isInteger(raw) ? raw : +raw.toFixed(2))
            : raw;
          out += p.marker + " " + p.seriesName + "&nbsp;&nbsp;<b>" + v + "</b><br/>";
        });
        if (rainLookup && !params.some(p => p.seriesName === rainSeriesName)) {
          let rainTs = axisTs;
          if (rainGranularity === "5min" && typeof axisTs === "string") rainTs = floorToFiveMinute(axisTs);
          const rainVal = rainLookup[rainTs];
          if (rainVal != null) {
            const label = rainGranularity === "5min" ? "Rain (5-min)" : rainGranularity === "daily" ? "Rain (daily)" : "Rain";
            out += '<span style="display:inline-block;margin-right:6px;border-radius:50%;width:8px;height:8px;background:' + RAIN_COLOR + ';"></span>' +
              label + "&nbsp;&nbsp;<b>" + (+rainVal.toFixed(2)) + "</b><br/>";
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
      top: 4, icon: "roundRect", itemWidth: 12, itemHeight: 7,
    };
  }

  function makeComboOption(vd, overlayKey, overlayName, overlayColor, lineWidth, rainVd) {
    const { timestamps, pump_status, pumps, granularity } = vd;
    const overlay = vd[overlayKey];
    const rain = alignRainToTimestamps(timestamps, rainVd);
    const rainFocus = !!rain;
    const yAxes = [yAxisLeft("Pump Status (0/1)"), yAxisRight(overlayName)];
    if (rain) yAxes.push(yAxisRain());
    const legendNames = rain ? [...pumps, "Rain, in", overlayName] : [...pumps, overlayName];
    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ rainLookup: rain && rain.lookup, rainGranularity: rain && rain.granularity, granularity }),
      legend: legend(legendNames),
      grid: { left: 70, right: 70, top: 44, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: yAxes,
      series: [
        ...pumps.map((pid, i) => ({
          name: pid, type: "bar", stack: "pumps", yAxisIndex: 0,
          itemStyle: {
            color: PUMP_COLORS[i % PUMP_COLORS.length],
            opacity: rainFocus ? 0.26 : 1,
          },
          data: pump_status[pid], barMaxWidth: granularity === "minute" ? 6 : 24,
          z: 1,
        })),
        ...(rain ? [{
          name: "Rain, in",
          type: "bar",
          yAxisIndex: 2,
          data: rain.data,
          barMaxWidth: granularity === "minute" ? 8 : 16,
          itemStyle: { color: "rgba(72,208,201,0.55)" },
          emphasis: { itemStyle: { color: "rgba(72,208,201,0.78)" } },
          z: 4,
        }] : []),
        {
          name: overlayName, type: "line", yAxisIndex: 1,
          data: overlay,
          lineStyle: { width: lineWidth || 2, color: overlayColor },
          itemStyle: { color: overlayColor },
          symbol: "none", connectNulls: false, z: 10,
          markPoint: getFlowExtremaMarkPoint(timestamps, overlay, granularity),
        },
      ],
    };
  }

  function getFlowExtremaMarkPoint(timestamps, values, granularity) {
    if (!timestamps || !values || !timestamps.length || !values.length) return null;
    const visibleSpan = visibleDays({ timestamps }, savedZoom);
    if (visibleSpan > 60) return null;

    const { startIdx, endIdx } = visibleIndexRange(timestamps, savedZoom);
    const points = [];
    for (let i = startIdx; i <= endIdx; i += 1) {
      const value = values[i];
      if (value == null) continue;
      points.push({ index: i, ts: timestamps[i], value });
    }
    if (!points.length) return null;

    const labelCount = visibleSpan > 14 ? 2 : visibleSpan > 3 ? 4 : 6;
    const spacing = Math.max(4, Math.floor((endIdx - startIdx + 1) / Math.max(3, labelCount)));
    const picked = [];
    const used = new Set();

    function addCandidates(sorted, type) {
      for (const point of sorted) {
        if (picked.length >= labelCount) break;
        const tooClose = picked.some(existing => Math.abs(existing.index - point.index) < spacing);
        if (tooClose || used.has(point.index)) continue;
        used.add(point.index);
        picked.push({ ...point, type });
      }
    }

    addCandidates(points.slice().sort((a, b) => b.value - a.value), "max");
    addCandidates(points.slice().sort((a, b) => a.value - b.value), "min");

    if (!picked.length) return null;

    return {
      symbol: "pin",
      symbolSize: 24,
      itemStyle: { color: "rgba(241,245,251,0.18)", borderColor: "rgba(241,245,251,0.45)" },
      label: {
        color: "#eff5fb",
        fontSize: 10,
        formatter: ({ value }) => {
          const raw = Array.isArray(value) ? value[1] : value;
          return raw == null ? "" : (+raw).toFixed(2);
        },
      },
      data: picked
        .sort((a, b) => a.index - b.index)
        .map(point => ({
          coord: [point.ts, point.value],
          value: point.value,
          name: point.type,
        })),
    };
  }

  function makeMixedComboOption(vd, overlayVd, overlayKey, overlayName, overlayColor, lineWidth) {
    const { timestamps, pump_status, pumps, granularity } = vd;
    const overlayTs = overlayVd.timestamps;
    const overlay = overlayVd[overlayKey];
    const renderMinutePumps = !!(
      overlayVd.granularity === "minute" &&
      overlayVd.pump_status &&
      overlayTs.length <= 50000
    );
    const pumpTs = renderMinutePumps ? overlayTs : timestamps;
    const pumpSource = renderMinutePumps ? overlayVd : vd;
    const pumpBarWidth = renderMinutePumps ? 6 : (granularity === "daily" ? 36 : 12);
    const tooltipFormatter = params => {
      if (!params.length) return "";
      const ts = fmtAxisValue(params[0].axisValue, overlayVd.granularity);
      let out = '<div style="margin-bottom:4px;font-weight:600">' + ts + '</div>';
      params.forEach(p => {
        if (p.value == null || p.value === "-") return;
        const raw = Array.isArray(p.value) ? p.value[1] : p.value;
        if (raw == null) return;
        const v = typeof raw === "number"
          ? (Number.isInteger(raw) ? raw : +raw.toFixed(2))
          : raw;
        out += p.marker + " " + p.seriesName + "&nbsp;&nbsp;<b>" + v + "</b><br/>";
      });
      return out;
    };

    return {
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: TIP_BG,
        borderColor: TIP_BORDER,
        textStyle: { color: "#eff5fb", fontSize: 12 },
        axisPointer: { type: "line" },
        formatter: tooltipFormatter,
      },
      legend: legend([...pumps, overlayName]),
      grid: { left: 70, right: 70, top: 44, bottom: 52 },
      dataZoom: dataZoom(overlayTs, overlayVd.granularity, true),
      xAxis: timeXAxisOpt(overlayVd.granularity),
      yAxis: [yAxisLeft("Pump Status (0/1)"), yAxisRight(overlayName)],
      series: [
        ...pumps.map((pid, i) => ({
          name: pid,
          type: "bar",
          stack: "pumps",
          yAxisIndex: 0,
          itemStyle: { color: PUMP_COLORS[i % PUMP_COLORS.length] },
          data: pumpTs.map((ts, idx) => [toTimeValue(ts), (pumpSource.pump_status[pid] || [])[idx]]),
          barWidth: pumpBarWidth,
          z: 1,
        })),
        {
          name: overlayName,
          type: "line",
          yAxisIndex: 1,
          data: overlayTs.map((ts, idx) => [toTimeValue(ts), overlay[idx]]),
          lineStyle: { width: lineWidth || 2, color: overlayColor },
          itemStyle: { color: overlayColor },
          symbol: "none",
          connectNulls: false,
          ...(overlayVd.granularity !== "minute" ? { sampling: "lttb" } : {}),
          z: 10,
          markPoint: getFlowExtremaMarkPoint(overlayTs, overlay, overlayVd.granularity),
        },
      ],
    };
  }

  function makePumpsSepOption(vd) {
    const { timestamps, pump_status, pumps, granularity } = vd;
    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity }),
      legend: legend(pumps),
      grid: { left: 70, right: 20, top: 36, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: yAxisLeft("Pump Status (0/1)"),
      series: pumps.map((pid, i) => ({
        name: pid, type: "bar", stack: "pumps",
        itemStyle: { color: PUMP_COLORS[i % PUMP_COLORS.length] },
        data: pump_status[pid], barMaxWidth: granularity === "minute" ? 6 : 24,
      })),
    };
  }

  function makeSingleOption(timestamps, values, color, yLabel, granularity) {
    return {
      backgroundColor: "transparent",
      tooltip: tooltip({ granularity }),
      grid: { left: 70, right: 20, top: 16, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: { ...yAxisLeft(yLabel), min: undefined },
      series: [{
        type: "bar", data: values, itemStyle: { color }, barMaxWidth: 24,
        markPoint: (yLabel === "Flow, MGD" || yLabel === "WWL, ft")
          ? getFlowExtremaMarkPoint(timestamps, values, granularity)
          : null,
      }],
    };
  }

  function makeRainOption(vd) {
    return {
      backgroundColor: "transparent",
      tooltip: tooltip(),
      grid: { left: 70, right: 20, top: 16, bottom: 52 },
      dataZoom: dataZoom(vd.timestamps, vd.granularity),
      xAxis: xAxisOpt(vd.timestamps, vd.granularity),
      yAxis: yAxisLeft("Rainfall, in"),
      series: [{ name: "Rain, in", type: "bar", data: vd.rain, itemStyle: { color: RAIN_COLOR }, barMaxWidth: 24 }],
    };
  }

  function groupedStats(timestamps, values, keyFn) {
    const buckets = {};
    timestamps.forEach((ts, i) => {
      const value = values[i];
      if (value == null) return;
      const key = keyFn(ts);
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push(value);
    });
    return Object.keys(buckets)
      .sort()
      .map(key => {
        const vals = buckets[key];
        return {
          min: Math.min(...vals),
          mean: avg(vals),
          max: Math.max(...vals),
        };
      })
      .filter(stat => stat.mean != null);
  }

  function summarizeGroupedStats(timestamps, values, keyFn) {
    const statsByGroup = groupedStats(timestamps, values, keyFn);
    if (!statsByGroup.length) return { min: null, mean: null, max: null };
    return {
      min: Math.min(...statsByGroup.map(stat => stat.min)),
      mean: avg(statsByGroup.map(stat => stat.mean)),
      max: Math.max(...statsByGroup.map(stat => stat.max)),
    };
  }

  function applySideFilter(vd) {
    if (!selectedSide || !PLANT_CONFIG.pumpGroups) return vd;
    const pumpIds = PLANT_CONFIG.pumpGroups[selectedSide] || [];
    return {
      ...vd,
      pumps: vd.pumps.filter(p => pumpIds.includes(p)),
      pump_status: Object.fromEntries(
        vd.pumps.filter(p => pumpIds.includes(p)).map(p => [p, vd.pump_status[p]])
      ),
      wwl: vd["wwl_" + selectedSide] || vd.wwl,
    };
  }

  function renderStatisticsPanel(slice, flowSlice, wwlSlice) {
    const fmt = v => v == null ? "—" : v.toFixed(2);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
    const daily  = ts => ts.substring(0, 10);
    const weekly = ts => isoWeekInfo(ts).key;
    const flowSource = flowSlice || slice;
    const wwlSource = wwlSlice || slice;
    const wwlValues = selectedSide && wwlSource["wwl_" + selectedSide] ? wwlSource["wwl_" + selectedSide] : wwlSource.wwl;
    const flowDaily = summarizeGroupedStats(flowSource.timestamps, flowSource.flow, daily);
    const flowWeekly = summarizeGroupedStats(flowSource.timestamps, flowSource.flow, weekly);
    set("stat-flow-d-min", flowDaily.min);
    set("stat-flow-d-mean", flowDaily.mean);
    set("stat-flow-d-max", flowDaily.max);
    set("stat-flow-w-min", flowWeekly.min);
    set("stat-flow-w-mean", flowWeekly.mean);
    set("stat-flow-w-max", flowWeekly.max);

    const wwlDaily = summarizeGroupedStats(wwlSource.timestamps, wwlValues, daily);
    const wwlWeekly = summarizeGroupedStats(wwlSource.timestamps, wwlValues, weekly);
    set("stat-wwl-d-min", wwlDaily.min);
    set("stat-wwl-d-mean", wwlDaily.mean);
    set("stat-wwl-d-max", wwlDaily.max);
    set("stat-wwl-w-min", wwlWeekly.min);
    set("stat-wwl-w-mean", wwlWeekly.mean);
    set("stat-wwl-w-max", wwlWeekly.max);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function initChart(id, groupName) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (charts[id]) { charts[id].dispose(); delete charts[id]; }
    charts[id] = echarts.init(el, null, { renderer: "canvas" });
    if (groupName) {
      charts[id].group = groupName;
      echarts.connect(groupName);
    }
    return charts[id];
  }

  function attachZoomListener(chart, timestamps, useTimeValues) {
    if (!chart) return;
    chart.on("dataZoom", e => {
      if (rerendering) return;
      const batch  = e.batch && e.batch[0];
      const start  = batch ? batch.start  : (e.start  ?? savedZoom?.start ?? 0);
      const end    = batch ? batch.end    : (e.end    ?? savedZoom?.end   ?? 100);
      const activeTimestamps = timestamps || [];
      const startValue = batch ? batch.startValue : e.startValue;
      const endValue = batch ? batch.endValue : e.endValue;
      let startTs;
      let endTs;
      if (useTimeValues && startValue != null && endValue != null && activeTimestamps.length) {
        ({ startTs, endTs } = timestampBoundsFromValues(activeTimestamps, startValue, endValue));
      } else {
        const { startIdx, endIdx } = visibleIndexRange(activeTimestamps, { start, end });
        startTs = activeTimestamps[startIdx] ?? activeTimestamps[0] ?? null;
        endTs = activeTimestamps[endIdx] ?? activeTimestamps[activeTimestamps.length - 1] ?? null;
      }
      if (
        savedZoom &&
        savedZoom.start === start &&
        savedZoom.end === end &&
        savedZoom.startTs === startTs &&
        savedZoom.endTs === endTs
      ) return;
      const baseSlice = getBaseFilteredSlice();
      const prevZoom = savedZoom;
      const wasResolution = getResolutionMode(baseSlice, prevZoom);
      const wasFlowSpec = getFlowMinuteSpec(baseSlice, prevZoom);
      const wasWwlSpec = getWwlMinuteSpec(baseSlice, prevZoom);
      const wasPumpSpec = getPumpMinuteSpec(baseSlice, prevZoom);
      const wasPumpGranularity = getPumpGranularity(baseSlice, prevZoom);
      savedZoom = { start, end, startTs, endTs };
      const isResolution = getResolutionMode(baseSlice, savedZoom);
      const isFlowSpec = getFlowMinuteSpec(baseSlice, savedZoom);
      const isWwlSpec = getWwlMinuteSpec(baseSlice, savedZoom);
      const isPumpSpec = getPumpMinuteSpec(baseSlice, savedZoom);
      const isPumpGranularity = getPumpGranularity(baseSlice, savedZoom);
      const flowChanged = flowMinuteSpecKey(wasFlowSpec) !== flowMinuteSpecKey(isFlowSpec);
      const wwlChanged = flowMinuteSpecKey(wasWwlSpec) !== flowMinuteSpecKey(isWwlSpec);
      const pumpChanged = pumpMinuteSpecKey(wasPumpSpec) !== pumpMinuteSpecKey(isPumpSpec)
        || wasPumpGranularity !== isPumpGranularity;

      if (wasResolution !== isResolution || flowChanged || wwlChanged || pumpChanged) {
        const keysToLoad = new Set();
        const selectedKeys = minuteKeys();
        if (isResolution === "minute" && selectedKeys) selectedKeys.forEach(key => keysToLoad.add(key));
        if (isFlowSpec) isFlowSpec.keys.forEach(key => keysToLoad.add(key));
        if (isWwlSpec) isWwlSpec.keys.forEach(key => keysToLoad.add(key));
        if (isPumpSpec) isPumpSpec.keys.forEach(key => keysToLoad.add(key));

        if (keysToLoad.size) {
          loadMinuteKeys([...keysToLoad]).then(loaded => {
            if (!loaded.some(Boolean)) return;
            rerendering = true;
            renderActive();
            rerendering = false;
          });
          return;
        }

        rerendering = true;
        renderActive();
        rerendering = false;
      }
    });
  }

  function renderRainChart(id, rainVd) {
    const c = initChart(id, "wwtp-rain");
    if (!c) return;
    if (!rainVd) { c.clear(); return; }
    c.setOption(makeRainOption(rainVd));
  }

  function renderCombined(vd, rainVd) {
    const c1 = initChart("chart-flow", "wwtp");
    const combinedRain = showRainOverlay() ? rainVd : null;
    const flowVd = getFlowChartData();
    const pumpVd = applySideFilter(getPumpChartData());
    if (c1) {
      c1.setOption(makeMixedComboOption(pumpVd || vd, flowVd || vd, "flow", "Flow, MGD", FLOW_COLOR, 2));
      attachMinuteHover("chart-flow", c1, flowVd ? flowVd.timestamps : vd.timestamps, flowVd ? flowVd.granularity : vd.granularity);
      attachZoomListener(c1, flowVd ? flowVd.timestamps : vd.timestamps);
    }
    const wwlVd = applySideFilter(getWwlChartData());
    const c2 = initChart("chart-wwl", "wwtp");
    if (c2) {
      c2.setOption(makeMixedComboOption(pumpVd || vd, wwlVd || vd, "wwl", "WWL, ft", WWL_COLOR, 2.5));
      attachMinuteHover("chart-wwl", c2, wwlVd ? wwlVd.timestamps : vd.timestamps, wwlVd ? wwlVd.granularity : vd.granularity);
    }
  }

  function renderSeparate(vd, rainVd) {
    const c1 = initChart("chart-sep-pumps", "wwtp");
    const pumpVd = applySideFilter(getPumpChartData());
    if (c1 && pumpVd) { c1.setOption(makePumpsSepOption(pumpVd)); attachMinuteHover("chart-sep-pumps", c1, pumpVd.timestamps, pumpVd.granularity); }
    const c2 = initChart("chart-sep-wwl", "wwtp");
    const wwlVd = applySideFilter(getWwlChartData());
    if (c2 && wwlVd) { c2.setOption(makeSingleOption(wwlVd.timestamps, wwlVd.wwl, WWL_COLOR, "WWL, ft", wwlVd.granularity)); attachMinuteHover("chart-sep-wwl", c2, wwlVd.timestamps, wwlVd.granularity); }
    const flowVd = getFlowChartData();
    const c3 = initChart("chart-sep-flow", "wwtp");
    if (c3 && flowVd) { c3.setOption(makeSingleOption(flowVd.timestamps, flowVd.flow, FLOW_COLOR, "Flow, MGD", flowVd.granularity)); attachMinuteHover("chart-sep-flow", c3, flowVd.timestamps, flowVd.granularity); attachZoomListener(c3, flowVd.timestamps); }
    renderRainChart("chart-sep-rain", rainVd);
  }


  function renderActive() {
    const slice = getFilteredSlice();
    if (!slice) return;
    const flowSlice = getFlowChartData();
    const wwlSlice = getWwlChartData();
    renderStatisticsPanel(slice, flowSlice, wwlSlice);
    const vd = applySideFilter(getViewData());
    if (!vd) return;
    const rainVd = getRainViewData();
    const active = document.querySelector(".tab-pane.active");
    if (!active) return;
    if (active.id === "tab-combined") renderCombined(vd, rainVd);
    else renderSeparate(vd, rainVd);
  }

  // ── Dropdowns ─────────────────────────────────────────────────────────────
  const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function populateMonths() {
    if (!yearData || !msMonth) return;
    const months = [...new Set(yearData.timestamps.map(ts => +ts.substring(5,7)))].sort((a,b)=>a-b);
    msMonth.setOptions(months.map(m => ({ value: m, label: MO[m-1] })));
  }

  function updateDayOptions(months, weeks, preserveSelection) {
    if (!msDay || !yearData) return;
    let src = yearData.timestamps;
    if (months && months.length) src = src.filter(ts => months.includes(+ts.substring(5,7)));
    if (weeks  && weeks.length)  src = src.filter(ts => weeks.includes(isoWeek(ts)));
    const days = [...new Set(src.map(ts => +ts.substring(8,10)))].sort((a,b)=>a-b);
    const validDays = preserveSelection ? sel.days.filter(d => days.includes(d)) : [];
    sel.days = validDays;
    msDay.setOptions(days.map(d => ({ value: d, label: String(d) })));
    if (validDays.length) msDay.setSelected(validDays);
  }

  function populateWeeks(months) {
    if (!msWeek || !yearData) return;
    const source = months.length
      ? yearData.timestamps.filter(ts => months.includes(+ts.substring(5,7)))
      : yearData.timestamps;
    const weeks = [...new Set(source.map(ts => isoWeek(ts)))].sort((a,b)=>a-b);
    msWeek.setOptions(weeks.map(w => ({ value: w, label: "Week " + w })));
  }

  function setLoading(on) { const el = document.getElementById("loading-msg"); if (el) el.style.display = on ? "block" : "none"; }
  function setStatus(msg) { const el = document.getElementById("status-msg"); if (el) { el.textContent = msg; el.style.display = "block"; } }
  function hideStatus()   { const el = document.getElementById("status-msg"); if (el) el.style.display = "none"; }

  function updateRainToggleUI() {
    const btn = document.getElementById("btn-rain-toggle");
    if (!btn) return;
    const enabled = rainEnabled();
    btn.disabled = !enabled;
    btn.classList.toggle("is-on", enabled && sel.includeRain);
    btn.setAttribute("aria-pressed", enabled && sel.includeRain ? "true" : "false");
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  async function init() {
    const t = document.getElementById("plant-title");
    if (t) t.textContent = PLANT_CONFIG.name;

    try {
      await loadScript(PLANT_CONFIG.dataDir + "meta.js");
      meta = window.__wwtp_meta || null;
      if (!meta) throw new Error();
    } catch(e) {
      setStatus("Could not load meta.js — run preprocess.py first.");
      return;
    }

    msYear = createMultiSelect("ms-year", "All Years", async years => {
      sel.years = years;
      minuteCache = {};
      rainMinuteCache = {};
      savedZoom = null;

      await loadYears(years.length ? years : meta.years);
    }, { showAll: true });

    msMonth = createMultiSelect("ms-month", "All Months", async months => {
      sel.months = months;
      sel.days = []; sel.weeks = [];
      savedZoom = null;
      msDay.clear(); msWeek.clear();
      updateDayOptions(months, [], false);
      populateWeeks(months);

      renderActive();
      const loaded = await preloadSelectedDetailData();
      if (loaded.some(Boolean)) renderActive();
    }, { showAll: true });

    msDay = createMultiSelect("ms-day", "All Days", days => {
      sel.days = days;
      savedZoom = null;

      renderActive();
    }, { showAll: true });

    msWeek = createMultiSelect("ms-week", "All Weeks", weeks => {
      sel.weeks = weeks;
      sel.days = [];
      savedZoom = null;
      msDay.clear();
      updateDayOptions(sel.months, weeks, false);
      renderActive();
    }, { showAll: true });

    if (hasRain()) {
      msGauge = createMultiSelect("ms-gauge", "Gauge", async gauges => {
        sel.gauges = gauges;
        savedZoom = null;
        updateRainToggleUI();
        renderActive();
        if (gauges.length && sel.months.length === 1 && sel.years.length === 1) {
          const loaded = await loadRainMinuteData(sel.years[0], sel.months[0]);
          if (loaded) renderActive();
        }
      });
      if (msGauge) {
        const gaugeLabel = PLANT_CONFIG.rain.label
          ? `${PLANT_CONFIG.rain.gauge} · ${PLANT_CONFIG.rain.label}`
          : `Gauge ${PLANT_CONFIG.rain.gauge}`;
        msGauge.setOptions([{ value: PLANT_CONFIG.rain.gauge, label: gaugeLabel }]);
        sel.gauges = [PLANT_CONFIG.rain.gauge];
        msGauge.setSelected(sel.gauges);
      }
    }

    const rainToggleBtn = document.getElementById("btn-rain-toggle");
    if (rainToggleBtn) {
      rainToggleBtn.addEventListener("click", () => {
        if (!rainEnabled()) return;
        sel.includeRain = !sel.includeRain;
        savedZoom = null;
        updateRainToggleUI();
        renderActive();
      });
      updateRainToggleUI();
    }

    // Load most recent year, default to May 2026
    const sortedYears = meta.years.slice().sort((a,b) => b - a);
    msYear.setOptions(sortedYears.map(y => ({ value: y, label: String(y) })));
    const defaultYear = meta.years.includes(2026) ? 2026 : meta.years[meta.years.length - 1];
    sel.years = [defaultYear];
    msYear.setSelected([defaultYear]);
    await loadYears([defaultYear]);

    // Default to May
    const defaultMonth = (defaultYear === 2026 && meta.years.includes(2026)) ? 5 : 1;
    sel.months = [defaultMonth];
    msMonth.setSelected([defaultMonth]);
    populateWeeks([defaultMonth]);
    updateDayOptions([defaultMonth], [], false);
    await preloadSelectedDetailData();
    renderActive();

    document.querySelectorAll(".side-btn[data-side]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".side-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectedSide = btn.dataset.side;
        savedZoom = null;
        renderActive();
      });
    });

    document.getElementById("btn-reset").addEventListener("click", () => {
      sel.months = []; sel.days = []; sel.weeks = [];
      savedZoom = null;
      msMonth.clear(); msDay.clear(); msWeek.clear();
      updateDayOptions([], [], false);

      renderActive();
    });

    document.querySelectorAll(".subtab[data-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".subtab").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        const pane = document.getElementById("tab-" + btn.dataset.tab);
        if (pane) pane.classList.add("active");
        renderActive();
      });
    });

    window.addEventListener("resize", () => Object.values(charts).forEach(c => c && c.resize()));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
