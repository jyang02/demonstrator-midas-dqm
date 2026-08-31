//
// dqm-evd.js -- the event display.
//
// One event, every channel, laid out so the shape of the event is readable at a
// glance rather than reconstructed from sixteen overlaid traces.
//
// Everything comes from a single `wd::scope` reply, and that is the design
// constraint rather than an implementation detail. An event display is a thing
// people point at -- "channel 3 looks odd on this one" -- so:
//
//   * every panel must show the same event as every other panel, and
//   * the phase and amplitudes printed alongside must belong to those traces,
//   * and two people on two screens must be looking at the same event.
//
// One frame from one shared source gives all three by construction. Assembling
// traces from the browser's own buffer reads and numbers from the analyzer would
// give none of them: those are different events.
//
// Layout follows the retired plotly figure, because the asymmetry was right --
// the channels are not equal. The first few carry pulses you read; the rest are
// there to tell you whether something fired.
//

(function () {
"use strict";

const LS = "dqm-evd-settings";

const state = {
  client: "wd_analyzer",
  frame: null,
  lastSeq: null,
  lastFrameAt: null,
  roles: null,
  updater: null,
  panels: new Map(),        // channel -> {wrap, div, mpg, title}
  bigChannels: [0, 1, 2, 3, 4],
  xMode: "uniform",
  sharedY: false,
  intervalMs: 1000,
};

window.addEventListener("load", function () {
  mhttpd_init(mhttpd_getParameterByName("page") || "EventDisplay", 1000);
  restore();
  build();
  boot().catch(function (e) { setError(String(e && e.message ? e.message : e)); });
});

async function boot() {
  state.roles = await loadRoles();
  state.bigChannels = DQM.asArray(state.roles["waveform channels"]).map(Number);
  if (!state.bigChannels.length) state.bigChannels = [0, 1, 2, 3, 4];

  state.updater = new BRPC.AutoUpdater(refresh, state.intervalMs);
  state.updater.onError = (e) => setError(String(e && e.message ? e.message : e));
  state.updater.start();
}

/**
 * Channel roles from the ODB, with built-in fallbacks.
 *
 * The retired figure read these from a JSON file that both the C++ stages and
 * the browser loaded independently, which meant two copies to keep in step and a
 * documented way for them to disagree. One ODB subtree cannot disagree with
 * itself, and it lands in every run's ODB dump for free.
 */
async function loadRoles() {
  const defaults = {
    "waveform channels": [0, 1, 2, 3, 4],
    "s1 channel": 0,
    "rf channel": 5,
    "nim channels": [7, 8, 9, 10, 11, 12, 13, 14, 15],
    "nim threshold V": 0.1,
    "labels": [],
  };
  try {
    const rpc = await mjsonrpc_db_get_values(
      ["/Equipment/WDAnalyzer/Settings/Channel roles"]);
    const got = rpc.result.data[0];
    if (got && rpc.result.status[0] === 1) {
      for (const key of Object.keys(defaults)) {
        for (const k of Object.keys(got)) {
          if (k.endsWith("/key")) continue;
          if (k.toLowerCase() === key.toLowerCase()) defaults[key] = got[k];
        }
      }
    }
  } catch (e) { /* built-ins are fine; the subtree is optional */ }
  return defaults;
}

// ---------------------------------------------------------------------------

async function refresh() {
  const frame = await BRPC.scope(state.client);
  if (frame === null) {
    state.frame = null;
    renderNoFrame();
    return;
  }
  const isNew = frame.frameSeq !== state.lastSeq;
  state.frame = frame;
  if (isNew) {
    state.lastSeq = frame.frameSeq;
    state.lastFrameAt = Date.now();
  }
  layout(frame);
  draw(frame);
  renderStatus(frame, isNew);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function role(name, fallback) {
  const v = state.roles ? state.roles[name] : undefined;
  return v === undefined || v === null ? fallback : v;
}

function isBig(ch) { return state.bigChannels.indexOf(ch) >= 0; }
function isRf(ch) { return ch === Number(role("rf channel", 5)); }
function isS1(ch) { return ch === Number(role("s1 channel", 0)); }
function isNim(ch) {
  return DQM.asArray(role("nim channels", [])).map(Number).indexOf(ch) >= 0;
}

function channelLabel(ch) {
  const labels = DQM.asArray(role("labels", []));
  const named = labels[ch];
  const base = ch >= 16 ? `clk ${ch - 16}` : `ch ${String(ch).padStart(2, "0")}`;
  return named ? `${base} ${named}` : base;
}

function layout(frame) {
  const big = document.getElementById("dqm-evd-big");
  const small = document.getElementById("dqm-evd-small");

  for (const ch of frame.channels) {
    if (state.panels.has(ch.channel)) continue;
    const target = isBig(ch.channel) ? big : small;
    const cls = isBig(ch.channel) ? "dqm-evd-panel-big" : "dqm-evd-panel-small";

    const wrap = el("div", { class: cls });
    const title = el("div", { class: "dqm-evd-title" }, channelLabel(ch.channel));
    const div = el("div", { class: "dqm-evd-plot" });
    wrap.appendChild(title);
    wrap.appendChild(div);
    target.appendChild(wrap);

    const mpg = new MPlotGraph(div, {
      showMenuButtons: isBig(ch.channel),
      mouseWheelZoom: true,
      title: { text: "" },
      stats: { show: false },
      legend: { show: false },
      xAxis: { title: { text: isBig(ch.channel) ? xAxisTitle() : "" } },
      yAxis: { title: { text: isBig(ch.channel) ? "V" : "" } },
    });
    div.mpg = mpg;
    mpg.addPlot({ label: "trace", type: "scatter",
                  line: { draw: true, width: 1 }, marker: { draw: false },
                  xData: [], yData: [] });
    state.panels.set(ch.channel, { wrap, div, mpg, title });
    window.setTimeout(function () { mpg.resize(); mpg.draw(); }, 0);
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw(frame) {
  const sharedRange = state.sharedY ? commonRange(frame) : null;
  const thr = Number(role("nim threshold V", 0.1));

  for (const ch of frame.channels) {
    const panel = state.panels.get(ch.channel);
    if (!panel) continue;
    // Per channel, so one unexpected value cannot blank all sixteen panels.
    // Whatever is wrong with channel 9 is not a reason to stop showing 0 to 8.
    try {
      drawChannel(frame, ch, panel, sharedRange, thr);
    } catch (e) {
      panel.title.textContent = `${channelLabel(ch.channel)} — could not draw: ${e.message}`;
      panel.wrap.classList.add("undecoded");
      if (typeof console !== "undefined") console.error("dqm-evd channel", ch.channel, e);
    }
  }
}

function drawChannel(frame, ch, panel, sharedRange, thr) {
  {
    const g = panel.mpg;
    const plot = g.param.plot[0];

    if (!ch.decoded) {
      // Greyed and labelled rather than omitted: a panel that silently vanishes
      // tells nobody the encoding mode was unreadable.
      g.setData(0, [], []);
      panel.wrap.classList.add("undecoded");
      panel.title.textContent =
        `${channelLabel(ch.channel)} — mode ${ch.encoding}, not decodable`;
      dropMarker(g);
      g.redraw();
      return;
    }
    panel.wrap.classList.remove("undecoded");

    const xs = sampleTimes(frame, ch);
    const columns = Math.max(120, Math.floor((panel.div.clientWidth || 300) * 0.9));
    const red = WDBanks.minMaxDecimate(xs, ch.volts, columns);

    plot.line.color = colourFor(ch, thr);
    if (isBig(ch.channel) && sharedRange) {
      g.param.yAxis.min = sharedRange[0];
      g.param.yAxis.max = sharedRange[1];
    } else {
      delete g.param.yAxis.min;
      delete g.param.yAxis.max;
    }
    if (isBig(ch.channel)) g.param.xAxis.title.text = xAxisTitle();

    g.setData(0, red.x, red.y);
    panel.title.textContent = titleFor(frame, ch, thr);
    markEdge(frame, ch, g, xs);
    g.redraw();
  }
}

function colourFor(ch, thr) {
  if (isRf(ch.channel)) return "#ff7f0e";
  if (isNim(ch.channel)) return firedNim(ch, thr) ? "#2ca02c" : "#b0b0b0";
  return "#1f77b4";
}

/**
 * Did a NIM channel fire?
 *
 * Baseline over the first samples, then any excursion past the threshold. The
 * retired figure used exactly this, and its value is that it is a yes/no you can
 * read from across the room rather than a trace you have to squint at.
 */
function firedNim(ch, thr) {
  const v = ch.volts;
  const n = Math.min(100, v.length);
  if (!n) return false;
  let base = 0;
  for (let i = 0; i < n; i++) base += v[i];
  base /= n;
  for (let i = 0; i < v.length; i++) if (Math.abs(v[i] - base) > thr) return true;
  return false;
}

function titleFor(frame, ch, thr) {
  let t = channelLabel(ch.channel);
  if (isRf(ch.channel)) {
    t += " — RF";
    // Guarded independently of rf_phase_deg: the two are separate keys and
    // assuming one implies the other threw here, which took the whole draw with
    // it and blanked every panel over a missing label.
    const period = frame.derived.rf_period_smp;
    if (typeof period === "number") t += ` (T=${period.toFixed(2)} smp)`;
  } else if (isNim(ch.channel)) {
    t += firedNim(ch, thr) ? "  ● fired" : "  ○";
  }
  const amp = frame.derived[`amp_ch${String(ch.channel).padStart(2, "0")}`];
  if (amp !== undefined) t += `  ${(amp * 1000).toFixed(0)} mV`;
  return t;
}

/**
 * The S1 leading edge, on the S1 panel and on the RF panel.
 *
 * On both, deliberately: one line on one trace is a number, the same line on
 * both is the phase relationship, which is the thing you actually wanted to see.
 *
 * Drawn as a two-point series rather than on the canvas, because mplot has no
 * shapes and anything painted on the canvas directly is erased by the next
 * internal redraw. The y range is pinned so a full-height marker cannot drag the
 * autoscale.
 */
function markEdge(frame, ch, g, xs) {
  const t = frame.derived.s1_time_smp;
  const show = t !== undefined && (isS1(ch.channel) || isRf(ch.channel));
  if (!show) { dropMarker(g); return; }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < ch.volts.length; i++) {
    if (ch.volts[i] < lo) lo = ch.volts[i];
    if (ch.volts[i] > hi) hi = ch.volts[i];
  }
  if (!Number.isFinite(lo)) { dropMarker(g); return; }
  const pad = (hi - lo) * 0.05 || 0.01;
  g.param.yAxis.min = lo - pad;
  g.param.yAxis.max = hi + pad;

  const x = sampleToX(frame, ch, xs, t);
  let idx = plotIndex(g, "s1 edge");
  if (idx < 0) {
    idx = g.addPlot({
      label: "s1 edge", type: "scatter",
      line: { draw: true, width: 1, style: "dashed", color: "#d62728" },
      marker: { draw: false }, xData: [], yData: [],
    });
  }
  g.setData(idx, [x, x], [lo - pad, hi + pad]);
}

function dropMarker(g) {
  // Guarded by our own lookup: mplot's findPlot() alerts on a missing label,
  // and deletePlot() splices its -1 return, removing the wrong plot.
  if (plotIndex(g, "s1 edge") >= 0) g.deletePlot("s1 edge");
}

function plotIndex(g, label) {
  const plots = (g.param && g.param.plot) || [];
  for (let i = 0; i < plots.length; i++) if (plots[i].label === label) return i;
  return -1;
}

/** Interpolate a fractional sample position onto whichever x axis is in use. */
function sampleToX(frame, ch, xs, sample) {
  if (state.xMode === "bin") return ch.firstBin + sample;
  const i = Math.max(0, Math.min(xs.length - 2, Math.floor(sample)));
  const f = sample - i;
  return xs[i] + (xs[i + 1] - xs[i]) * f;
}

function sampleTimes(frame, ch) {
  const n = ch.volts.length;
  const out = new Float64Array(n);
  if (state.xMode === "bin") {
    for (let i = 0; i < n; i++) out[i] = ch.firstBin + i;
    return out;
  }
  const step = (frame.nominalPs || 0) / 1000;      // ps -> ns
  for (let i = 0; i < n; i++) out[i] = i * step;
  return out;
}

function xAxisTitle() {
  if (state.xMode === "bin") return "sample bin";
  const ps = state.frame && state.frame.nominalPs
    ? ` — ${state.frame.nominalPs.toFixed(0)} ps/sample` : "";
  return `time (ns, uniform${ps})`;
}

/** A y range spanning every big channel, so pulse heights compare by eye. */
function commonRange(frame) {
  let lo = Infinity, hi = -Infinity;
  for (const ch of frame.channels) {
    if (!ch.decoded || !isBig(ch.channel)) continue;
    for (let i = 0; i < ch.volts.length; i++) {
      if (ch.volts[i] < lo) lo = ch.volts[i];
      if (ch.volts[i] > hi) hi = ch.volts[i];
    }
  }
  if (!Number.isFinite(lo)) return null;
  const pad = (hi - lo) * 0.05 || 0.01;
  return [lo - pad, hi + pad];
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function build() {
  const r = document.getElementById("dqm-root");
  r.innerHTML = "";

  const bar = el("div", { class: "dqm-strip" });
  bar.appendChild(labelled("update", select(
    [["500", "2 Hz"], ["1000", "1 Hz"], ["2000", "0.5 Hz"], ["0", "paused"]],
    String(state.intervalMs),
    function (v) {
      state.intervalMs = Number(v); save();
      if (!state.updater) return;
      if (Number(v) === 0) state.updater.stop();
      else { state.updater.setInterval(Number(v)); state.updater.start(); }
    })));
  bar.appendChild(labelled("x axis", select(
    [["uniform", "time (uniform ns)"], ["bin", "sample bin"]],
    state.xMode,
    function (v) { state.xMode = v; save(); if (state.frame) draw(state.frame); })));

  const shared = el("input", { type: "checkbox", id: "dqm-evd-sharedy" });
  shared.checked = state.sharedY;
  shared.onchange = function () {
    state.sharedY = this.checked; save();
    if (state.frame) draw(state.frame);
  };
  const sharedLab = el("label", { for: "dqm-evd-sharedy", class: "dqm-chip" },
                        "common y scale");
  sharedLab.insertBefore(shared, sharedLab.firstChild);
  bar.appendChild(sharedLab);

  bar.appendChild(el("span", { class: "dqm-chip", id: "dqm-evd-status" }, "…"));
  r.appendChild(bar);
  r.appendChild(el("div", { class: "dqm-diagnosis", id: "dqm-evd-diag" }, ""));

  const cols = el("div", { class: "dqm-evd-columns" });
  cols.appendChild(el("div", { id: "dqm-evd-big", class: "dqm-evd-bigcol" }));
  cols.appendChild(el("div", { id: "dqm-evd-small", class: "dqm-evd-smallcol" }));
  r.appendChild(cols);
}

function renderStatus(frame, isNew) {
  const chip = document.getElementById("dqm-evd-status");
  const diag = document.getElementById("dqm-evd-diag");
  chip.className = "dqm-chip";
  diag.className = "dqm-diagnosis";

  const age = state.lastFrameAt ? (Date.now() - state.lastFrameAt) / 1000 : null;
  const bits = [`run ${frame.runNumber}`, `event ${frame.eventNumber}`,
                `board ${frame.boardId}`, `${frame.boardTempC.toFixed(1)} °C`];
  if (frame.derived.rf_phase_deg !== undefined) {
    bits.push(`S1→RF ${frame.derived.rf_phase_deg.toFixed(1)}°`);
  }

  if (!frame.runActive && age !== null && age > 10) {
    chip.className = "dqm-chip yellow";
    chip.textContent = `frozen ${Math.round(age)} s`;
    diag.className = "dqm-diagnosis yellow";
    diag.textContent =
      `No run is active, so this is the last event the analyzer saw, ` +
      `${Math.round(age)} s ago — not a live event. ` + bits.join(" · ");
    return;
  }
  chip.className = "dqm-chip green";
  chip.textContent = isNew ? "live" : "waiting";
  diag.textContent = bits.join(" · ");

  if (frame.derived.rf_phase_deg === undefined) {
    diag.textContent +=
      "  —  no S1→RF phase for this event; the Waveforms page status says why.";
  }
}

function renderNoFrame() {
  const chip = document.getElementById("dqm-evd-status");
  const diag = document.getElementById("dqm-evd-diag");
  chip.className = "dqm-chip yellow";
  chip.textContent = "no event";
  diag.className = "dqm-diagnosis yellow";
  diag.textContent =
    `${state.client} has not decoded a waveform event yet. They are read out only ` +
    "while a run is active — set /Logger/Write data to n first if you want to look " +
    "without recording.";
}

function setError(message) {
  const chip = document.getElementById("dqm-evd-status");
  const diag = document.getElementById("dqm-evd-diag");
  if (!chip || !diag) return;
  chip.className = "dqm-chip red";
  chip.textContent = "error";
  diag.className = "dqm-diagnosis red";
  diag.textContent = `Could not read from ${state.client}: ${message}`;
}

// ---------------------------------------------------------------------------

function save() {
  try {
    window.localStorage.setItem(LS, JSON.stringify({
      client: state.client, xMode: state.xMode,
      sharedY: state.sharedY, intervalMs: state.intervalMs,
    }));
  } catch (e) { /* private browsing or quota */ }
}

function restore() {
  try {
    const o = JSON.parse(window.localStorage.getItem(LS) || "{}");
    if (o.client) state.client = o.client;
    if (o.xMode) state.xMode = o.xMode;
    if (o.sharedY !== undefined) state.sharedY = !!o.sharedY;
    if (o.intervalMs !== undefined) state.intervalMs = Number(o.intervalMs);
  } catch (e) { /* defaults are fine */ }
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "class") e.className = attrs[k]; else e.setAttribute(k, attrs[k]);
  });
  children.forEach(function (c) {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return e;
}

function select(options, current, onChange) {
  const s = el("select", {});
  options.forEach(function (o) {
    const opt = el("option", { value: o[0] }, o[1]);
    if (o[0] === current) opt.setAttribute("selected", "selected");
    s.appendChild(opt);
  });
  s.value = current;
  s.onchange = function () { onChange(this.value); };
  return s;
}

function labelled(text, node) {
  return el("span", { class: "dqm-chip" }, el("span", {}, text), node);
}

})();
