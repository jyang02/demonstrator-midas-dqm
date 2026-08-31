//
// dqm-scope.js -- live waveforms, with no backend.
//
// MIDAS ships everything this needs: mjsonrpc's bm_receive_event pulls a raw
// event straight out of the SYSTEM buffer as an ArrayBuffer, bkToObj() in
// midas.js decodes the bank structure, dqm-wdbanks.js turns DRSV into volts, and
// mplot.js draws. No analyzer, no extra port, no daemon.
//
// On the shared read pointer (MIDAS elog 2391): mhttpd holds ONE event-buffer
// read pointer for the whole process. That sounds like two browsers would steal
// events from each other, and with get_recent:false they would. With
// get_recent:true each poll drains the buffer and returns the newest event via a
// process-global stash, so measured with two viewers at 2 Hz against 30 ev/s,
// each received every poll's worth -- 50 events, no empty polls -- with only one
// serial number in common. Nobody is starved; the two screens simply show
// different events. Making them agree needs a shared source, which is what the
// analyzer client is for.
//
// Shape of the loop is Stefan Ritt's, from the WaveDREAM browser scope this is
// modelled on: a chained setTimeout re-armed *from the response* rather than a
// fixed setInterval, so a slow reply throttles the loop instead of stacking up
// requests behind it.
//

(function () {
"use strict";

const state = {
  running: true,
  intervalMs: 500,
  lastHeader: [],          // [event_id, trigger_mask, serial, timestamp]
  widths: null,            // the run's DRS cell-width table, once we have seen it
  widthsFromSerial: null,
  frame: null,
  lastFrameAt: null,
  seen: 0,
  emptyPolls: 0,
  xMode: "uniform",        // bin | uniform | calibrated
  channels: null,          // null until the first event tells us what exists
  selected: new Set(),
  showClock: false,
  timer: null,
  plot: null,
  error: null,
};

const LS = "dqm-scope-settings";

window.addEventListener("load", function () {
  mhttpd_init(mhttpd_getParameterByName("page") || "Scope", 1000);
  restore();
  build();
  poll();
  // A hidden tab must not go on pulling 33 kB events out of a shared buffer.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.running && !state.timer) poll();
  });
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function poll() {
  state.timer = null;
  if (!state.running || document.hidden) return;

  mjsonrpc_call("bm_receive_event", {
    buffer_name: "SYSTEM",
    event_id: -1,
    trigger_mask: -1,
    // Always. Ritt, elog 2394: "GET_ALL does not make sense for browsers, you
    // don't want to slow down any frontend." We want the newest event, not a
    // backlog we can never catch up with.
    get_recent: true,
    last_event_header: state.lastHeader,
  }, "arraybuffer").then(function (rpc) {
    if (rpc.result) {
      // A JSON reply means no event was available (status 209).
      state.emptyPolls++;
      updateStatus();
    } else {
      onEvent(bkToObj(rpc));
    }
    rearm(state.intervalMs);
  }).catch(function (error) {
    // Anything thrown while decoding or drawing lands here too, not just a
    // transport failure -- and it must be reported rather than swallowed.
    setError(String(error && error.message ? error.message : error), error);
    rearm(Math.max(5000, state.intervalMs));
  });
}

function rearm(ms) {
  if (!state.running) return;
  state.timer = window.setTimeout(poll, ms);
}

function onEvent(event) {
  state.lastHeader = [event.event_id, event.trigger_mask,
                      event.serial_number, event.time_stamp];
  // A new event is the only thing that clears an error. Otherwise a transient
  // failure would be reported once and then quietly wiped by the next routine
  // status update, which is how a page ends up lying about its own health.
  state.error = null;

  const frame = WDBanks.decodeEvent(event, state.widths);
  if (!frame) return;                 // some other equipment's event

  if (frame.widths && !frame.widthsAreCached) {
    state.widths = frame.widths;
    state.widthsFromSerial = event.serial_number;
  }
  state.frame = frame;
  state.lastFrameAt = Date.now();
  state.seen++;
  state.emptyPolls = 0;

  if (state.channels === null) discoverChannels(frame);
  draw();
  updateStatus();
}

/** What the board is actually sending, learned from the first event. */
function discoverChannels(frame) {
  state.channels = frame.channels.map((c) => c.channel);
  const saved = restore().selected;
  if (saved && saved.length) {
    saved.forEach((c) => { if (state.channels.indexOf(c) >= 0) state.selected.add(c); });
  }
  if (!state.selected.size) {
    // A handful, not all eighteen. Sixteen overlaid traces on one axis is a
    // smear with a legend covering it, and the two DRS clock channels are
    // diagnostics rather than signal. Five matches what the retired DQM drew by
    // default (`waveform_channels: [0..4]`), and "all" is one click away.
    frame.channels.forEach(function (c) {
      if (c.channel < 5 && c.decoded) state.selected.add(c.channel);
    });
    if (!state.selected.size) {
      frame.channels.forEach(function (c) {
        if (c.decoded && state.selected.size < 5) state.selected.add(c.channel);
      });
    }
  }
  buildChannelControls();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function draw() {
  const frame = state.frame;
  const div = document.getElementById("dqm-scope-plot");
  if (!frame || !div) return;

  if (!state.plot) {
    state.plot = new MPlotGraph(div, {
      showMenuButtons: true,
      mouseWheelZoom: true,
      title: { text: "" },
      xAxis: { title: { text: xAxisTitle() } },
      yAxis: { title: { text: "V" } },
      stats: { show: false },
      legend: { show: true },
    });
    div.mpg = state.plot;
    window.addEventListener("resize", function () { state.plot.resize(); });
    // MPlotGraph sizes its canvas from parentDiv.clientWidth/clientHeight
    // (mplot.js:1178). The div is laid out by CSS after this tick, so without a
    // deferred resize the canvas keeps whatever size it had at construction --
    // which is why the plot came out a third of its width.
    window.setTimeout(function () { state.plot.resize(); state.plot.redraw(); }, 0);
  }

  const g = state.plot;
  g.param.xAxis.title.text = xAxisTitle();
  // The legend is drawn inside the plot area, one row per series. Past a handful
  // of channels it covers the traces it is annotating.
  g.param.legend.show = state.selected.size <= 6;

  // How many screen columns we have to spend, for the min/max reduction.
  const columns = Math.max(200, Math.floor((div.clientWidth || 900) * 0.9));

  const wanted = frame.channels.filter((c) => state.selected.has(c.channel));
  for (const c of wanted) {
    const label = channelLabel(c.channel);
    let idx = plotIndex(g, label);
    if (idx < 0) {
      idx = g.addPlot({
        label: label,
        type: "scatter",
        line: { draw: true, width: 1 },
        marker: { draw: false },
        xData: [], yData: [],
      });
    }
    if (!c.decoded || !c.volts) {
      // Encoding mode 11 rebins adaptively and the per-bin factors are not in
      // this bank, so there is no honest trace to draw. Empty and labelled,
      // never a plausible-looking wrong one.
      g.setData(idx, [], []);
      continue;
    }
    const xs = WDBanks.sampleTimes(frame, c.channel, state.xMode, c.volts.length);
    const red = WDBanks.minMaxDecimate(xs, c.volts, columns);
    g.setData(idx, red.x, red.y);
  }

  // Drop plots for channels no longer selected, so the legend matches reality.
  // Guarded by our own lookup, never by findPlot -- see plotIndex() below.
  for (const c of frame.channels) {
    if (state.selected.has(c.channel)) continue;
    const label = channelLabel(c.channel);
    if (plotIndex(g, label) >= 0) g.deletePlot(label);
  }

  g.redraw();
}

/**
 * Index of a plot by label, or -1. Do not use MPlotGraph's own findPlot() here.
 *
 * findPlot() raises a browser alert() when the label is not found
 * (mplot.js:967-979) -- it is written for callers that already know the plot
 * exists, not as an existence test, and using it as one puts a modal dialog in
 * front of the operator every time a channel is switched on.
 *
 * The same call is why deletePlot() must be guarded: it does
 * `splice(this.findPlot(label), 1)` with no check, so on a missing label it
 * alerts *and* then splices index -1, silently removing the last plot instead.
 */
function plotIndex(g, label) {
  const plots = (g.param && g.param.plot) || [];
  for (let i = 0; i < plots.length; i++) {
    if (plots[i].label === label) return i;
  }
  return -1;
}

function channelLabel(ch) {
  return ch >= 16 ? `clk ${ch - 16}` : `ch ${String(ch).padStart(2, "0")}`;
}

function xAxisTitle() {
  const f = state.frame;
  if (state.xMode === "bin") return "sample bin";
  if (state.xMode === "calibrated") {
    if (!f || !f.widths) return "time (ns) — no calibration table, showing uniform";
    return f.widthsAreCached
      ? `time (ns, calibrated — table cached from an earlier event)`
      : `time (ns, calibrated — live table)`;
  }
  const ps = f && f.nominalPs ? ` — ${f.nominalPs} ps/sample` : "";
  return `time (ns, uniform${ps})`;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function build() {
  const root = document.getElementById("dqm-root");
  root.innerHTML = "";

  const bar = el("div", { class: "dqm-strip" });

  const runBtn = el("button", { class: "mbutton", id: "dqm-runbtn" }, "Pause");
  runBtn.onclick = function () {
    state.running = !state.running;
    runBtn.textContent = state.running ? "Pause" : "Resume";
    if (state.running) poll();
    else if (state.timer) { window.clearTimeout(state.timer); state.timer = null; }
  };
  bar.appendChild(runBtn);

  bar.appendChild(labelled("update", select(
    [["200", "5 Hz"], ["500", "2 Hz"], ["1000", "1 Hz"], ["2000", "0.5 Hz"]],
    String(state.intervalMs),
    function (v) { state.intervalMs = Number(v); save(); })));

  bar.appendChild(labelled("x axis", select(
    [["uniform", "time (uniform ns)"], ["bin", "sample bin"],
     ["calibrated", "time (calibrated ns)"]],
    state.xMode,
    function (v) { state.xMode = v; save(); draw(); })));

  bar.appendChild(el("span", { class: "dqm-chip", id: "dqm-scope-status" }, "starting…"));
  root.appendChild(bar);

  root.appendChild(el("div", { class: "dqm-strip", id: "dqm-scope-channels" }));
  root.appendChild(el("div", { class: "dqm-diagnosis", id: "dqm-scope-diag" }, ""));
  root.appendChild(el("div", { class: "dqm-scope-plot", id: "dqm-scope-plot" }));
  root.appendChild(el("div", { class: "dqm-footnote" },
    "Reads the SYSTEM buffer directly through mhttpd — no analyzer, no extra process. " +
    "mhttpd shares one buffer read pointer across all browsers, but with get_recent " +
    "that costs nothing: two people watching at once each see events at the full poll " +
    "rate, just not the same ones."));
}

function buildChannelControls() {
  const holder = document.getElementById("dqm-scope-channels");
  if (!holder) return;
  holder.innerHTML = "";
  holder.appendChild(el("span", {}, "channels"));

  state.channels.forEach(function (ch) {
    const id = `dqm-ch-${ch}`;
    const box = el("input", { type: "checkbox", id: id });
    box.checked = state.selected.has(ch);
    box.onchange = function () {
      if (this.checked) state.selected.add(ch);
      else state.selected.delete(ch);
      save();
      draw();
    };
    const lab = el("label", { for: id, class: "dqm-chip" }, channelLabel(ch));
    lab.insertBefore(box, lab.firstChild);
    holder.appendChild(lab);
  });

  const all = el("button", { class: "mbutton" }, "all");
  all.onclick = function () { state.channels.forEach((c) => state.selected.add(c)); refreshBoxes(); };
  const none = el("button", { class: "mbutton" }, "none");
  none.onclick = function () { state.selected.clear(); refreshBoxes(); };
  holder.appendChild(all);
  holder.appendChild(none);
}

function refreshBoxes() {
  state.channels.forEach(function (ch) {
    const box = document.getElementById(`dqm-ch-${ch}`);
    if (box) box.checked = state.selected.has(ch);
  });
  save();
  draw();
}

function updateStatus() {
  const chip = document.getElementById("dqm-scope-status");
  const diag = document.getElementById("dqm-scope-diag");
  if (!chip || !diag) return;
  if (state.error) return;          // do not paint over a live error

  chip.className = "dqm-chip";
  diag.className = "dqm-diagnosis";

  if (!state.frame) {
    chip.className = "dqm-chip yellow";
    chip.textContent = "no events yet";
    diag.className = "dqm-diagnosis yellow";
    // The usual cause by far, and not a fault.
    diag.textContent =
      "Nothing is producing waveform events. They are read out only while a run is " +
      "active, so start one — set /Logger/Write data to n first if you want to look " +
      "without recording to disk.";
    return;
  }

  const age = (Date.now() - state.lastFrameAt) / 1000;
  const f = state.frame;
  const b = f.board || {};
  const bits = [`event ${b.eventNumber !== undefined ? b.eventNumber : "?"}`];
  if (b.boardId !== undefined) bits.push(`board ${b.boardId}`);
  if (f.temperatureC !== null) bits.push(`${f.temperatureC.toFixed(1)} °C`);
  bits.push(`${state.seen} seen`);

  if (age > 10) {
    chip.className = "dqm-chip red";
    chip.textContent = `last event ${Math.round(age)} s ago`;
    diag.className = "dqm-diagnosis red";
    diag.textContent =
      `The traces below are ${Math.round(age)} s old, not live. The run may have ` +
      `stopped, or another browser may be taking the events — mhttpd shares one ` +
      `read pointer across all of them.`;
  } else {
    chip.className = "dqm-chip green";
    chip.textContent = "live";
    diag.textContent = bits.join(" · ");
  }

  const undecoded = f.channels.filter((c) => !c.decoded);
  if (undecoded.length) {
    diag.textContent += `  —  ${undecoded.length} channel(s) in encoding mode ` +
      `${undecoded[0].encoding} (adaptive rebinning), which cannot be decoded from ` +
      `this bank alone and are drawn empty rather than wrongly.`;
  }
}

function setError(message, cause) {
  state.error = message;
  // Keep the stack where a developer will find it. The page says what is wrong;
  // the console says where.
  if (cause && typeof console !== "undefined" && console.error) {
    console.error("dqm-scope:", cause);
  }
  const chip = document.getElementById("dqm-scope-status");
  const diag = document.getElementById("dqm-scope-diag");
  if (!chip || !diag) return;
  chip.className = "dqm-chip red";
  chip.textContent = "error";
  diag.className = "dqm-diagnosis red";
  diag.textContent = `Scope stopped: ${message}. Retrying every few seconds; ` +
    `see the browser console for details.`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function save() {
  try {
    window.localStorage.setItem(LS, JSON.stringify({
      intervalMs: state.intervalMs,
      xMode: state.xMode,
      selected: Array.from(state.selected),
    }));
  } catch (e) { /* private browsing, quota: not worth interrupting anyone */ }
}

function restore() {
  try {
    const raw = window.localStorage.getItem(LS);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (o.intervalMs) state.intervalMs = Number(o.intervalMs);
    if (o.xMode) state.xMode = o.xMode;
    return o;
  } catch (e) { return {}; }
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "class") e.className = attrs[k];
    else e.setAttribute(k, attrs[k]);
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
