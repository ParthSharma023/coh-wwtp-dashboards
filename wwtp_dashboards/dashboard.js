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

  const ZOOM_HOURLY_THRESHOLD = 60;

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
      populateMonths(); populateDays([]); populateWeeks([]);
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

  function minuteKey() {
    return (sel.years.length === 1 && sel.months.length === 1)
      ? `${sel.years[0]}_${String(sel.months[0]).padStart(2, "0")}`
      : null;
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
  function getFilteredSlice() {
    if (!yearData) return null;
    const { months, days, weeks } = sel;

    const mk = minuteKey();
    const useMins = days.length === 1 && months.length === 1 && mk && minuteCache[mk];
    const src = useMins ? { ...minuteCache[mk], granularity: "minute" } : yearData;
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

  function visibleDays() {
    if (!savedZoom || !yearData) return Infinity;
    const totalDays = new Set(yearData.timestamps.map(ts => ts.substring(0, 10))).size;
    return (savedZoom.end - savedZoom.start) / 100 * totalDays;
  }

  function getViewData() {
    const filtered = getFilteredSlice();
    if (!filtered) return null;
    if (!sel.months.length && !sel.weeks.length) {
      if (visibleDays() <= ZOOM_HOURLY_THRESHOLD) return filterActivePumps(filtered);
      const daily = aggregateDaily(filtered.timestamps, filtered.flow, filtered.wwl, filtered.pump_status, filtered.pumps);
      if (filtered.wwl_east) {
        const B = {};
        filtered.timestamps.forEach((ts, i) => {
          const day = ts.substring(0, 10);
          if (!B[day]) B[day] = { east: [], west: [] };
          if (filtered.wwl_east[i] != null) B[day].east.push(filtered.wwl_east[i]);
          if (filtered.wwl_west[i] != null) B[day].west.push(filtered.wwl_west[i]);
        });
        const maxVal2 = arr => arr.length ? Math.max(...arr) : null;
        daily.wwl_east = daily.timestamps.map(d => maxVal2(B[d] ? B[d].east : []));
        daily.wwl_west = daily.timestamps.map(d => maxVal2(B[d] ? B[d].west : []));
      }
      return filterActivePumps(daily);
    }
    return filterActivePumps(filtered);
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

  function dataZoom(timestamps, granularity) {
    const start = savedZoom ? savedZoom.start : 0;
    const end   = savedZoom ? savedZoom.end   : 100;
    return [
      { type: "inside", xAxisIndex: 0, start, end },
      {
        type: "slider", xAxisIndex: 0, height: 18, bottom: 4, start, end,
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
    const rainSeriesName = "Rain, in";
    return {
      trigger: "axis",
      backgroundColor: TIP_BG, borderColor: TIP_BORDER,
      textStyle: { color: "#eff5fb", fontSize: 12 },
      axisPointer: { type: "shadow" },
      formatter: params => {
        const canUseMinuteHover = params.some(p =>
          p.seriesName === "Flow, MGD" || p.seriesName === "WWL, ft"
        );
        const hm = canUseMinuteHover ? hoveredMinuteTs : null;
        const axisTs = params[0].axisValue;
        const ts = (hm && hm.ts) || axisTs;
        let out = '<div style="margin-bottom:4px;font-weight:600">' + ts + '</div>';
        params.forEach(p => {
          if (p.value == null || p.value === "-") return;
          let raw = p.value;
          if (hm) {
            if (p.seriesName === "Flow, MGD" && hm.flow != null) raw = hm.flow;
            else if (p.seriesName === "WWL, ft" && hm.wwl != null) raw = hm.wwl;
          }
          const v = typeof raw === "number"
            ? (Number.isInteger(raw) ? raw : +raw.toFixed(2))
            : raw;
          out += p.marker + " " + p.seriesName + "&nbsp;&nbsp;<b>" + v + "</b><br/>";
        });
        if (rainLookup && !params.some(p => p.seriesName === rainSeriesName)) {
          let rainTs = axisTs;
          if (rainGranularity === "5min") rainTs = floorToFiveMinute(ts);
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
      tooltip: tooltip({ rainLookup: rain && rain.lookup, rainGranularity: rain && rain.granularity }),
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
          data: pump_status[pid], barMaxWidth: 24,
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
        },
      ],
    };
  }

  function makePumpsSepOption(vd) {
    const { timestamps, pump_status, pumps, granularity } = vd;
    return {
      backgroundColor: "transparent",
      tooltip: tooltip(),
      legend: legend(pumps),
      grid: { left: 70, right: 20, top: 36, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: yAxisLeft("Pump Status (0/1)"),
      series: pumps.map((pid, i) => ({
        name: pid, type: "bar", stack: "pumps",
        itemStyle: { color: PUMP_COLORS[i % PUMP_COLORS.length] },
        data: pump_status[pid], barMaxWidth: 24,
      })),
    };
  }

  function makeSingleOption(timestamps, values, color, yLabel, granularity) {
    return {
      backgroundColor: "transparent",
      tooltip: tooltip(),
      grid: { left: 70, right: 20, top: 16, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: { ...yAxisLeft(yLabel), min: undefined },
      series: [{
        type: "bar", data: values, itemStyle: { color }, barMaxWidth: 24,
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

  function renderStatisticsPanel(slice) {
    const fmt = v => v == null ? "—" : v.toFixed(2);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
    const daily  = ts => ts.substring(0, 10);
    const weekly = ts => isoWeekInfo(ts).key;
    const wwlValues = selectedSide && slice["wwl_" + selectedSide] ? slice["wwl_" + selectedSide] : slice.wwl;
    for (const [sig, values] of [["flow", slice.flow], ["wwl", wwlValues]]) {
      const d = summarizeGroupedStats(slice.timestamps, values, daily);
      const w = summarizeGroupedStats(slice.timestamps, values, weekly);
      set(`stat-${sig}-d-min`,  d.min);  set(`stat-${sig}-d-mean`, d.mean);  set(`stat-${sig}-d-max`, d.max);
      set(`stat-${sig}-w-min`,  w.min);  set(`stat-${sig}-w-mean`, w.mean);  set(`stat-${sig}-w-max`, w.max);
    }
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

  function attachZoomListener(chart) {
    if (!chart) return;
    chart.on("dataZoom", e => {
      if (rerendering) return;
      const batch  = e.batch && e.batch[0];
      const start  = batch ? batch.start  : (e.start  ?? savedZoom?.start ?? 0);
      const end    = batch ? batch.end    : (e.end    ?? savedZoom?.end   ?? 100);
      const wasHourly = savedZoom && visibleDays() <= ZOOM_HOURLY_THRESHOLD;
      savedZoom = { start, end };
      const isHourly = visibleDays() <= ZOOM_HOURLY_THRESHOLD;
      if (wasHourly !== isHourly && !sel.months.length && !sel.weeks.length) {
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
    if (c1) { c1.setOption(makeComboOption(vd, "flow", "Flow, MGD", FLOW_COLOR, 2, combinedRain)); attachMinuteHover("chart-flow", c1, vd.timestamps, vd.granularity); attachZoomListener(c1); }
    const c2 = initChart("chart-wwl", "wwtp");
    if (c2) { c2.setOption(makeComboOption(vd, "wwl", "WWL, ft", WWL_COLOR, 2.5, combinedRain)); attachMinuteHover("chart-wwl", c2, vd.timestamps, vd.granularity); }
  }

  function renderSeparate(vd, rainVd) {
    const c1 = initChart("chart-sep-pumps", "wwtp");
    if (c1) { c1.setOption(makePumpsSepOption(vd)); attachMinuteHover("chart-sep-pumps", c1, vd.timestamps, vd.granularity); }
    const c2 = initChart("chart-sep-wwl", "wwtp");
    if (c2) { c2.setOption(makeSingleOption(vd.timestamps, vd.wwl, WWL_COLOR, "WWL, ft", vd.granularity)); attachMinuteHover("chart-sep-wwl", c2, vd.timestamps, vd.granularity); }
    const c3 = initChart("chart-sep-flow", "wwtp");
    if (c3) { c3.setOption(makeSingleOption(vd.timestamps, vd.flow, FLOW_COLOR, "Flow, MGD", vd.granularity)); attachMinuteHover("chart-sep-flow", c3, vd.timestamps, vd.granularity); attachZoomListener(c3); }
    renderRainChart("chart-sep-rain", rainVd);
  }


  function renderActive() {
    const slice = getFilteredSlice();
    if (!slice) return;
    renderStatisticsPanel(slice);
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

  function populateDays(months, weeks) {
    if (!msDay || !yearData) return;
    let src = yearData.timestamps;
    if (months && months.length) src = src.filter(ts => months.includes(+ts.substring(5,7)));
    if (weeks  && weeks.length)  src = src.filter(ts => weeks.includes(isoWeek(ts)));
    const days = [...new Set(src.map(ts => +ts.substring(8,10)))].sort((a,b)=>a-b);
    msDay.setOptions(days.map(d => ({ value: d, label: String(d) })));
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

      await loadYears(years.length ? years : meta.years);
    }, { showAll: true });

    msMonth = createMultiSelect("ms-month", "All Months", async months => {
      sel.months = months;
      sel.days = []; sel.weeks = [];
      msDay.clear(); msWeek.clear();
      populateDays(months, []);
      populateWeeks(months);

      renderActive();
      if (months.length === 1 && sel.years.length === 1) {
        const loaders = [loadMinuteData(sel.years[0], months[0])];
        if (hasRain()) loaders.push(loadRainMinuteData(sel.years[0], months[0]));
        const loaded = await Promise.all(loaders);
        if (loaded.some(Boolean)) renderActive();
      }
    }, { showAll: true });

    msDay = createMultiSelect("ms-day", "All Days", days => {
      sel.days = days;

      renderActive();
    }, { showAll: true });

    msWeek = createMultiSelect("ms-week", "All Weeks", weeks => {
      sel.weeks = weeks;
      sel.days = [];
      msDay.clear();
      populateDays(sel.months, weeks);
      renderActive();
    }, { showAll: true });

    if (hasRain()) {
      msGauge = createMultiSelect("ms-gauge", "Gauge", async gauges => {
        sel.gauges = gauges;
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
    populateDays([defaultMonth], []);
    renderActive();

    document.querySelectorAll(".side-btn[data-side]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".side-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        selectedSide = btn.dataset.side;
        renderActive();
      });
    });

    document.getElementById("btn-reset").addEventListener("click", () => {
      sel.months = []; sel.days = []; sel.weeks = [];
      msMonth.clear(); msDay.clear(); msWeek.clear();
      populateDays([]);

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
