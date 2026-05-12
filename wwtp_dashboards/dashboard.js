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
  const WWL_COLOR   = "#6ee7a0";
  const AXIS_COLOR  = "rgba(180,192,208,0.45)";
  const SPLIT_COLOR = "rgba(180,192,208,0.07)";
  const TIP_BG      = "#17273a";
  const TIP_BORDER  = "rgba(122,156,199,0.28)";

  let meta        = null;
  let yearData    = null;
  let minuteCache = {};
  let charts      = {};
  let savedZoom   = null;
  let rerendering = false;

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

  const sel = { years: [], months: [], days: [], weeks: [] };
  let msYear = null, msMonth = null, msDay = null, msWeek = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
  const avg    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0)/v.length : null; };
  const sum    = arr => { const v = arr.filter(x => x != null); return v.length ? v.reduce((a,b)=>a+b,0) : null; };
  const maxVal = arr => { const v = arr.filter(x => x != null); return v.length ? Math.max(...v) : null; };

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
    return {
      plant: datasets[0].plant, fid: datasets[0].fid,
      pumps: allPumps,
      timestamps: datasets.flatMap(d => d.timestamps),
      flow:        datasets.flatMap(d => d.flow),
      wwl:         datasets.flatMap(d => d.wwl),
      pump_status: Object.fromEntries(allPumps.map(p => [
        p, datasets.flatMap(d => d.pump_status[p] || new Array(d.timestamps.length).fill(null))
      ])),
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
      if (!data) throw new Error("Not found");
      yearData = data;
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
    try {
      await loadScript(PLANT_CONFIG.dataDir + key + "_min.js");
      const data = window.__wwtp_min && window.__wwtp_min[key];
      if (data) minuteCache[key] = data;
      return data || null;
    } catch (e) { return null; }
  }

  function minuteKey() {
    return (sel.years.length === 1 && sel.months.length === 1)
      ? `${sel.years[0]}_${String(sel.months[0]).padStart(2, "0")}`
      : null;
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

    const fi = arr => arr.filter((_,i) => mask[i]);
    const tsFilt   = fi(timestamps);
    const flowFilt = fi(flow);
    const wwlFilt  = fi(wwl);
    const pumpFilt = {};
    pumps.forEach(p => { pumpFilt[p] = fi(pump_status[p]); });

    return { timestamps: tsFilt, flow: flowFilt, wwl: wwlFilt, pump_status: pumpFilt, pumps, granularity: gran };
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
      return filterActivePumps(aggregateDaily(
        filtered.timestamps,
        filtered.flow,
        filtered.wwl,
        filtered.pump_status,
        filtered.pumps
      ));
    }
    return filterActivePumps(filtered);
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

  function tooltip() {
    return {
      trigger: "axis",
      backgroundColor: TIP_BG, borderColor: TIP_BORDER,
      textStyle: { color: "#eff5fb", fontSize: 12 },
      axisPointer: { type: "shadow" },
      formatter: params => {
        let out = '<div style="margin-bottom:4px;font-weight:600">' + params[0].axisValue + '</div>';
        params.forEach(p => {
          if (p.value == null || p.value === "-") return;
          const v = typeof p.value === "number"
            ? (Number.isInteger(p.value) ? p.value : +p.value.toFixed(2))
            : p.value;
          out += p.marker + " " + p.seriesName + "&nbsp;&nbsp;<b>" + v + "</b><br/>";
        });
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

  function makeComboOption(vd, overlayKey, overlayName, overlayColor, lineWidth) {
    const { timestamps, pump_status, pumps, granularity } = vd;
    const overlay = vd[overlayKey];
    return {
      backgroundColor: "transparent",
      tooltip: tooltip(),
      legend: legend([...pumps, overlayName]),
      grid: { left: 70, right: 70, top: 44, bottom: 52 },
      dataZoom: dataZoom(timestamps, granularity),
      xAxis: xAxisOpt(timestamps, granularity),
      yAxis: [yAxisLeft("Pump Status (0/1)"), yAxisRight(overlayName)],
      series: [
        ...pumps.map((pid, i) => ({
          name: pid, type: "bar", stack: "pumps", yAxisIndex: 0,
          itemStyle: { color: PUMP_COLORS[i % PUMP_COLORS.length] },
          data: pump_status[pid], barMaxWidth: 24,
        })),
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

  function renderStatisticsPanel(slice) {
    const fmt = v => v == null ? "—" : v.toFixed(2);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = fmt(v); };
    const daily  = ts => ts.substring(0, 10);
    const weekly = ts => isoWeekInfo(ts).key;
    for (const [sig, values] of [["flow", slice.flow], ["wwl", slice.wwl]]) {
      const d = summarizeGroupedStats(slice.timestamps, values, daily);
      const w = summarizeGroupedStats(slice.timestamps, values, weekly);
      set(`stat-${sig}-d-min`,  d.min);  set(`stat-${sig}-d-mean`, d.mean);  set(`stat-${sig}-d-max`, d.max);
      set(`stat-${sig}-w-min`,  w.min);  set(`stat-${sig}-w-mean`, w.mean);  set(`stat-${sig}-w-max`, w.max);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function initChart(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (charts[id]) { charts[id].dispose(); delete charts[id]; }
    charts[id] = echarts.init(el, null, { renderer: "canvas" });
    charts[id].group = "wwtp";
    echarts.connect("wwtp");
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

  function renderCombined(vd) {
    const c1 = initChart("chart-flow");
    if (c1) { c1.setOption(makeComboOption(vd, "flow", "Flow, MGD", FLOW_COLOR, 2)); attachZoomListener(c1); }
    const c2 = initChart("chart-wwl");
    if (c2) c2.setOption(makeComboOption(vd, "wwl", "WWL, ft", WWL_COLOR, 2.5));
  }

  function renderSeparate(vd) {
    const c1 = initChart("chart-sep-pumps");
    if (c1) c1.setOption(makePumpsSepOption(vd));
    const c2 = initChart("chart-sep-wwl");
    if (c2) c2.setOption(makeSingleOption(vd.timestamps, vd.wwl, WWL_COLOR, "WWL, ft", vd.granularity));
    const c3 = initChart("chart-sep-flow");
    if (c3) { c3.setOption(makeSingleOption(vd.timestamps, vd.flow, FLOW_COLOR, "Flow, MGD", vd.granularity)); attachZoomListener(c3); }
  }

  function renderActive() {
    const slice = getFilteredSlice();
    if (!slice) return;
    renderStatisticsPanel(slice);
    const vd = getViewData();
    if (!vd) return;
    const active = document.querySelector(".tab-pane.active");
    if (!active) return;
    if (active.id === "tab-combined") renderCombined(vd);
    else renderSeparate(vd);
  }

  // ── Dropdowns ─────────────────────────────────────────────────────────────
  const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function populateMonths() {
    if (!yearData || !msMonth) return;
    const months = [...new Set(yearData.timestamps.map(ts => +ts.substring(5,7)))].sort((a,b)=>a-b);
    msMonth.setOptions(months.map(m => ({ value: m, label: MO[m-1] })));
  }

  function populateDays(months) {
    if (!msDay || !yearData) return;
    const src = months.length
      ? yearData.timestamps.filter(ts => months.includes(+ts.substring(5,7)))
      : yearData.timestamps;
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
      await loadYears(years.length ? years : meta.years);
    }, { showAll: true });

    msMonth = createMultiSelect("ms-month", "All Months", months => {
      sel.months = months;
      sel.days = []; sel.weeks = [];
      msDay.clear(); msWeek.clear();
      populateDays(months);
      populateWeeks(months);
      renderActive();
    }, { showAll: true });

    msDay = createMultiSelect("ms-day", "All Days", async days => {
      sel.days = days;
      renderActive();
      if (days.length === 1 && sel.months.length === 1) {
        const loaded = await loadMinuteData(sel.years[0], sel.months[0]);
        if (loaded) renderActive();
      }
    }, { showAll: true });

    msWeek = createMultiSelect("ms-week", "All Weeks", weeks => {
      sel.weeks = weeks;
      renderActive();
    }, { showAll: true });

    // Populate year options and load the most recent year by default
    const sortedYears = meta.years.slice().sort((a,b) => b - a);
    msYear.setOptions(sortedYears.map(y => ({ value: y, label: String(y) })));
    const defaultYear = meta.years[meta.years.length - 1];
    sel.years = [defaultYear];
    msYear.setSelected([defaultYear]);
    await loadYears([defaultYear]);

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
