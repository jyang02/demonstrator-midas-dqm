//
// dqm-scope.js -- one event, decoded in the browser.
//
// Mechanism B, and the only page in this set that needs no analyzer and no
// accumulated state: mjsonrpc's bm_receive_event pulls a raw event out of the
// buffer as an ArrayBuffer, bkToObj() in midas.js splits it into banks,
// dqm-adbanks.js turns AD00 into volts, and mplot.js draws it.
//
// Two of the five panels here are live. calo_waveforms has no calorimeter
// frontend and no bank; event_display_position needs the channel-to-strip map,
// which is a cabling review rather than code; event_display_energy needs
// per-strip energy that is not in the data at all. Those three keep their
// reasons from the catalogue and get no renderer, which is the correct amount
// of code to write for them.
//
// On the shared read pointer (MIDAS elog 2391): mhttpd holds ONE event-buffer
// read pointer for the whole process. With get_recent:true each poll drains the
// buffer and returns the newest event through a process-global stash, so two
// browsers both keep receiving -- but they see *different* events. Nobody is
// starved and nothing is stolen; the two screens simply disagree. Making them
// agree needs a shared source, which is what an analyzer would be for. The page
// says this out loud rather than letting two shifters discover it by comparing
// screens.
//
// Loop shape: a chained setTimeout re-armed *from the response*, never a fixed
// setInterval, so a slow reply throttles the loop instead of stacking requests
// behind it.
//

(function () {
"use strict";

const { el, chip, blocked } = DQMPage;

const state = {
  running: true,
  timer: null,
  intervalMs: 1000,
  lastHeader: null,
  event: null,
  seen: 0,
  emptyPolls: 0,
  error: null,
  busy: false,
  lastAt: null,
  excluded: null,          // channels the operator has explicitly unticked
  graph: null,
  cfg: null,
};

const STORE = "dqm-scope-settings";

//: Past this many traces at once the plot is a smear with a legend over it, and
//: the page says so rather than silently dropping any.
const BUSY_OVERLAY = 8;

//: Channel -> layer, read from /Equipment/SAMPIC/Settings once at load.
//:
//: null until loadChannelMap() has answered, and it stays null when the
//: settings are not there -- which is the honest state for a file whose
//: frontend never wrote them. The page then draws one panel, as it always did.
let layerMap = null;

/**
 * Which layer each readout channel is in, or null if the ODB does not say.
 *
 * Two things are needed and BOTH have to come from the ODB: the channel ids
 * themselves, and the geometry that encoded them. A pim1 pixel id becomes
 * (layer, strip) only under the base and the stride it was made with, so
 * guessing the stride gives the wrong layer and the wrong strip while looking
 * entirely plausible -- 56 of 256 channels move if 48 is assumed where the
 * file used 46. There is no default here for that reason: no geometry in the
 * ODB means no layer view, and the panel says so.
 */
async function loadChannelMap() {
  const base = "/Equipment/SAMPIC/Settings";
  let v;
  try {
    v = await DQM.getODB([
      `${base}/Channel map channel id`,
      `${base}/Channel map detector`,
      `${base}/Atar pixel id base`,
      `${base}/Atar strips per layer`,
      `${base}/Atar n layers`,
    ]);
  } catch (e) {
    return null;
  }
  const [ids, detectors, pixelBase, stride, nLayers] = v || [];
  if (!Array.isArray(ids) || !ids.length) return null;
  if (!Number.isFinite(Number(pixelBase)) || !(Number(stride) > 0)) return null;

  const byChannel = new Map();
  const layers = new Set();
  ids.forEach(function (id, i) {
    // Only channels the map calls ATAR have a layer; anything else is on the
    // same digitiser but is not a strip.
    const det = Array.isArray(detectors) ? detectors[i] : "atar";
    if (det && String(det).toLowerCase() !== "atar") return;
    const index = Number(id) - Number(pixelBase);
    if (!(index >= 0)) return;
    const layer = Math.floor(index / Number(stride));
    if (Number(nLayers) > 0 && layer >= Number(nLayers)) return;
    byChannel.set(i, layer);
    layers.add(layer);
  });
  if (!byChannel.size) return null;
  return { byChannel: byChannel, layers: Array.from(layers).sort((a, b) => a - b),
           source: `${base} (${byChannel.size} channels, ${layers.size} layers)` };
}

//: The layer a hit belongs to, or null when the map does not cover it.
function layerOf(hit) {
  if (!layerMap) return null;
  const l = layerMap.byChannel.get(hit.global_channel);
  return l === undefined ? null : l;
}

// ---------------------------------------------------------------------------
// atar_raw_waveforms -- the traces
// ---------------------------------------------------------------------------

DQMPage.register("atar_raw_waveforms", function (ctx) {
  state.cfg = ctx.cfg;
  state.intervalMs = Math.max(100, Math.round(1000 / (Number(ctx.cfg["Event Rate Hz"]) || 1)));
  restore();

  ctx.body.appendChild(el("div", { class: "dqm-strip", id: "scope-controls" },
    pauseButton(),
    chip("event", el("span", { id: "scope-serial" }, "—")),
    chip("hits", el("span", { id: "scope-nhits" }, "—")),
    chip("seen", el("span", { id: "scope-seen" }, "0")),
    chip("banks", el("span", { id: "scope-banks" }, "—"))));

  ctx.body.appendChild(el("div", { class: "dqm-strip", id: "scope-channels" }));
  ctx.body.appendChild(el("div", { class: "dqm-note", id: "scope-status" },
    "Waiting for an event…"));

  ctx.body.appendChild(el("div", { class: "dqm-note", id: "scope-layers" },
    "Reading the channel map…"));

  const plot = el("div", { class: "dqm-scope-plot", id: "scope-plot" });
  ctx.body.appendChild(plot);

  // Two browsers on this page do not see the same events, and that is a
  // property of mhttpd rather than of this page. Saying so is cheaper than two
  // shifters discovering it by comparing screens at 3am.
  ctx.body.appendChild(el("div", { class: "dqm-footnote" },
    "mhttpd holds one event-buffer read pointer for the whole process. Two "
    + "browsers on this page both keep receiving events, but they see different "
    + "ones — nothing is stolen, and nothing is synchronised either. Panels "
    + "that need every viewer to agree need an analyzer."));

  setTimeout(function () {
    // mplot's parameter shape is nested: title/xAxis.title/yAxis.title are
    // objects with a .text, and a plot's line and marker are objects with a
    // .draw. Passing the flat forms produces a graph that constructs cleanly
    // and draws nothing, which is the failure mode this whole page set is
    // about.
    state.graph = new MPlotGraph(plot, {
      title: { text: "" },
      stats: { show: false },
      legend: { show: true },
      mouseWheelZoom: true,
      xAxis: { title: { text: xAxisTitle() } },
      yAxis: { title: { text: "V" } },
      plot: [],
    });
    plot.mpg = state.graph;            // reachable from the console and the tests
    state.graphs = [{ layer: null, graph: state.graph, div: plot }];
    state.graph.resize();
    state.graph.draw();

    // One panel per layer, if the ODB says which channels are in which. Built
    // after the single graph above rather than instead of it, so a file whose
    // frontend published no settings keeps exactly the page it had.
    loadChannelMap().then(function (map) {
      layerMap = map;
      if (!map) {
        const note = document.getElementById("scope-layers");
        if (note) {
          note.textContent = "One panel for every channel: /Equipment/SAMPIC/"
            + "Settings carries no ATAR geometry, and which layer a channel is "
            + "in cannot be guessed from the bank.";
        }
        return;
      }
      buildLayerPanels(ctx.body, plot, map);
      if (state.event) draw();
    });
    // An event can easily arrive before this timeout runs -- the poll starts
    // immediately below and mhttpd may well answer first. Without this, the
    // first event is decoded, counted, tabulated and never plotted.
    if (state.event) draw();
  }, 0);

  poll();
  // A hidden tab must not go on pulling events out of a shared buffer.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.running && !state.timer) poll();
  });
});

/**
 * Replace the single plot with one per layer.
 *
 * The all-channels graph is kept as the panel for anything the map does not
 * place -- a channel on this digitiser that is not an ATAR strip still has
 * waveforms worth seeing, and dropping it silently would be the page hiding
 * hits. It is only shown when such a hit actually turns up.
 */
function buildLayerPanels(body, firstPlot, map) {
  const note = document.getElementById("scope-layers");
  if (note) note.textContent = `One panel per ATAR layer, from ${map.source}.`;

  state.graphs = [];
  const host = el("div", { id: "scope-layer-panels" });
  body.insertBefore(host, firstPlot);

  map.layers.forEach(function (layer) {
    const title = el("div", { class: "dqm-subhead" }, `Layer ${layer}`);
    const div = el("div", { class: "dqm-scope-plot", id: `scope-plot-L${layer}` });
    host.appendChild(title);
    host.appendChild(div);
    const g = new MPlotGraph(div, {
      title: { text: "" },
      stats: { show: false },
      legend: { show: true },
      mouseWheelZoom: true,
      xAxis: { title: { text: xAxisTitle() } },
      yAxis: { title: { text: "V" } },
      plot: [],
    });
    div.mpg = g;
    g.resize();
    g.draw();
    state.graphs.push({ layer: layer, graph: g, div: div });
  });

  // The unmapped panel goes last and starts hidden.
  firstPlot.hidden = true;
  state.graphs.push({ layer: null, graph: state.graph, div: firstPlot });
}


function pauseButton() {
  const b = el("button", { class: "mbutton", id: "scope-pause" }, "Pause");
  b.addEventListener("click", function () {
    state.running = !state.running;
    b.textContent = state.running ? "Pause" : "Resume";
    if (state.running) poll();
  });
  return b;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function poll() {
  state.timer = null;
  if (!state.running || document.hidden) return;

  mjsonrpc_call("bm_receive_event", {
    buffer_name: String((state.cfg && state.cfg["Buffer"]) || "SYSTEM"),
    event_id: -1,
    trigger_mask: -1,
    // Always. GET_ALL does not make sense for a browser: we want the newest
    // event, not a backlog we can never catch up with and that would slow a
    // frontend down while we tried.
    get_recent: true,
    last_event_header: state.lastHeader,
  }, "arraybuffer").then(function (rpc) {
    if (rpc.result) {
      // A JSON reply rather than binary means no event was available.
      state.emptyPolls++;
      update();
    } else {
      onEvent(bkToObj(rpc));
    }
    rearm(state.intervalMs);
  }).catch(function (error) {
    // Anything thrown while decoding or drawing lands here too, not only a
    // transport failure, and it has to be reported rather than swallowed: a
    // bank-layout disagreement throws from decodeAD and is exactly the thing
    // this page exists to make visible.
    state.error = String((error && error.message) || error);
    update();
    rearm(Math.max(5000, state.intervalMs));
  });
}

function rearm(ms) {
  if (!state.running) return;
  state.timer = setTimeout(poll, ms);
}

function onEvent(event) {
  state.lastHeader = [event.event_id, event.trigger_mask,
                      event.serial_number, event.time_stamp];
  // A new event is the only thing that clears an error. Otherwise a transient
  // failure is reported once and then quietly wiped by the next routine status
  // update, which is how a page ends up lying about its own health.
  state.error = null;

  const decoded = ADBanks.fromEvent(event, {
    eventId: state.cfg["Event ID"],
    waveformBank: state.cfg["Waveform Bank"],
    hitTimeBank: state.cfg["Hit Time Bank"],
    collectorBank: state.cfg["Collector Bank"],
  });
  if (!decoded) { state.emptyPolls++; return update(); }

  state.event = decoded;
  state.seen++;
  state.emptyPolls = 0;
  state.lastAt = Date.now();

  renderChannelPicker();
  draw();
  update();
  updateRawEvent();
}

/**
 * Everything in the event draws unless the operator said otherwise.
 *
 * This is an opt-*out* set, and the distinction matters on this detector. SAMPIC
 * is hit-based: a typical event carries two or three hits drawn from thirty-two
 * channels, and which three differ every event. Picking a channel set from the
 * first event -- which is what a fixed-readout scope does, and what this page
 * did first -- means most events afterwards are drawn only in part, with no
 * indication that anything is missing. Measured against 500 real events from
 * run 108: one trace shown out of three hits.
 */
function excluded() {
  if (state.excluded === null) {
    state.excluded = new Set((restore().excluded || []).map(Number));
  }
  return state.excluded;
}

function renderChannelPicker() {
  const host = document.getElementById("scope-channels");
  if (!host || !state.event) return;
  // Every channel seen so far, not just this event's: a box that vanishes when
  // its channel happens not to fire is a box nobody can untick.
  state.event.channels.forEach((c) => known.add(c));
  const key = Array.from(known).sort((a, b) => a - b).join(",");
  // Rebuilt only when the set grows, so it does not fight the operator's clicks.
  if (host.dataset.channels === key) return;
  host.dataset.channels = key;
  host.innerHTML = "";

  key.split(",").filter((x) => x !== "").map(Number).forEach(function (ch) {
    const box = el("input", { type: "checkbox" });
    box.checked = !excluded().has(ch);
    box.addEventListener("change", function () {
      if (this.checked) excluded().delete(ch); else excluded().add(ch);
      save();
      draw();
    });
    const label = el("label", { class: "dqm-chip" }, box, el("span", {}, `ch ${ch}`));
    host.appendChild(label);
  });
}

//: Channels seen since the page loaded, so the picker only ever grows.
const known = new Set();

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** The axis is only in ns if somebody configured the period; otherwise samples. */
function xAxisTitle() {
  return Number(state.cfg && state.cfg["Sample Period ns"]) ? "ns" : "sample";
}

function draw() {
  if (!state.graph || !state.event) return;
  const dt = Number(state.cfg["Sample Period ns"]) || 0;

  // Rebuild the plot list rather than updating in place: mplot's deletePlot
  // splices findPlot()'s return with no check, so removing a label that is not
  // there alerts the operator and then deletes the wrong trace.
  const panels = state.graphs || [{ layer: null, graph: state.graph, div: null }];
  panels.forEach(function (p) { p.graph.param.plot = []; p.used = false; });
  const byLayer = new Map(panels.map((p) => [p.layer, p]));
  const fallback = byLayer.get(null);
  const drawn = [];

  state.event.hits.forEach(function (hit) {
    if (excluded().has(hit.global_channel)) return;
    // Its layer's panel, or the all-channels one for a channel the map does
    // not place. Never dropped: a hit the page does not draw is a hit nobody
    // sees.
    const panel = byLayer.get(layerOf(hit)) || fallback;
    // With no period configured, plot against sample index rather than a row of
    // zeros: an honest axis in the wrong unit beats every point stacked at x=0.
    const xs = dt ? ADBanks.sampleTimes(hit, dt)
                  : Array.from(hit.waveform, (_, i) => i);
    // A 64-sample hit never needs reducing; this is here so a longer waveform
    // format does not silently become a 4000-point polyline per channel.
    const cut = ADBanks.minMaxDecimate(xs, hit.waveform, 600);
    const label = `ch ${hit.global_channel}${hit.hit_number ? ` #${hit.hit_number}` : ""}`;
    panel.graph.param.plot.push({
      label: label, type: "scatter",
      line: { draw: true, width: 1, color: colourFor(hit.global_channel) },
      marker: { draw: false },
      xData: cut.x, yData: cut.y,
    });
    panel.used = true;
    drawn.push(label);
  });

  // A layer with no hit this event keeps its panel and its axes -- an empty
  // panel in a row of eight says "nothing here this time", where a vanishing
  // one makes the layers renumber themselves between events. The unmapped
  // panel is the exception: it appears only when something needs it.
  panels.forEach(function (p) {
    if (p.layer === null && p.div) p.div.hidden = state.graphs && !p.used;
    if (p.used || p.graph.param.plot.length) return;
    p.graph.param.plot.push({
      label: p.layer === null ? "no unmapped channels" : `layer ${p.layer}: no hits`,
      type: "scatter", line: { draw: true, width: 1 }, marker: { draw: false },
      xData: [], yData: [], xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
  });

  if (!drawn.length && !state.graphs) {
    // An empty plot rather than none at all: mplot with a zero-length plot list
    // draws no axes either, and a panel with no axes reads as broken rather
    // than as "no channel selected".
    state.graph.param.plot.push({
      label: "every channel unticked", type: "scatter",
      line: { draw: true, width: 1 }, marker: { draw: false },
      xData: [], yData: [],
      xMin: 0, xMax: 1, yMin: 0, yMax: 1,
    });
  }

  // mplot fills in a plot's xMin/xMax/yMin/yMax in exactly two places:
  // setData() and its ODB-loading path. This page assigns param.plot directly,
  // because setData() can replace a trace's data but cannot add or remove
  // traces and the hit count changes every event. Without the bounds, draw()
  // returns immediately after painting the background -- a white panel with no
  // axes, no trace and no error raised anywhere, which is this page set's own
  // stated failure mode arriving by a different door.
  panels.forEach(function (panel) {
    panel.graph.param.plot.forEach(function (p) {
      if (!p.xData.length) return;
      p.xMin = Math.min.apply(null, p.xData);
      p.xMax = Math.max.apply(null, p.xData);
      p.yMin = Math.min.apply(null, p.yData);
      p.yMax = Math.max.apply(null, p.yData);
    });
    // ...and calcMinMax() turns those per-plot bounds into the graph-level
    // this.xMin/this.yMax that drawYAxis() needs.
    panel.graph.calcMinMax();
  });

  state.busy = drawn.length > BUSY_OVERLAY;
  panels.forEach(function (p) { p.graph.redraw(); });
}

//: matplotlib's tab10. Channel number modulo
//: the palette: adjacent channels get different colours, which is what the eye
//: needs when several are overlaid.
const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                 "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
function colourFor(ch) { return PALETTE[ch % PALETTE.length]; }

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function update() {
  setText("scope-seen", String(state.seen));
  if (state.event) {
    setText("scope-serial", String(state.event.serial));
    setText("scope-nhits", String(state.event.hits.length));
    setText("scope-banks", state.event.bankNames.join(" "));
  }

  const status = document.getElementById("scope-status");
  if (!status) return;

  if (state.error) {
    status.className = "dqm-error";
    status.textContent = state.error;
    return;
  }
  status.className = "dqm-note";
  if (!state.event) {
    status.textContent = state.emptyPolls
      ? `No event yet after ${state.emptyPolls} polls. Nothing is writing `
        + `${state.cfg["Waveform Bank"]} into the buffer — there is no fesampic.`
      : "Waiting for an event…";
    return;
  }

  const age = state.lastAt ? Math.round((Date.now() - state.lastAt) / 1000) : 0;
  const bits = [`Event ${state.event.serial}, ${state.event.hits.length} hits on `
                + `${state.event.channels.length} channels, ${age} s ago.`];
  // AT00 says how many hits the frontend clustered, AD00 how many it wrote.
  // Those disagreeing is a real fault and nothing else would report it.
  // The spec gives no panel on this page an alarm, so there is no diagnosis
  // line to colour: the status line has to carry this itself. AT00 says how
  // many hits the frontend clustered and AD00 is how many it wrote, and nothing
  // else in the system would notice them disagreeing.
  if (state.event.timing && state.event.timing.nhits !== state.event.hits.length) {
    status.className = "dqm-diagnosis red";
    bits.push(`AT00 claims ${state.event.timing.nhits} hits but AD00 carries `
              + `${state.event.hits.length}.`);
  }
  // Same fault, one level up: AC00 is the collector's own count of what it
  // built the event from. It disagreeing with the banks that arrived means the
  // event was assembled from parts that did not belong together, which no
  // per-hit plot on this page could show.
  if (state.event.collector
      && state.event.collector.total_hits !== state.event.hits.length) {
    status.className = "dqm-diagnosis red";
    bits.push(`AC00 collected ${state.event.collector.total_hits} hits but AD00 `
              + `carries ${state.event.hits.length}.`);
  }
  // Said rather than truncated. A page that drops traces to stay readable is
  // hiding hits, and on a hit-based detector the hits are the measurement.
  if (state.busy) {
    bits.push(`${BUSY_OVERLAY}+ traces overlaid; untick channels above to read them.`);
  }
  if (!Number(state.cfg["Sample Period ns"])) {
    bits.push("No sample period is configured, so the time axis is in samples, "
              + "not ns.");
  }
  status.textContent = bits.join(" ");
}

function setText(id, text) {
  const e = document.getElementById(id);
  if (e) e.textContent = text;
}

// ---------------------------------------------------------------------------
// raw_event -- the dump you open when a plot is empty
// ---------------------------------------------------------------------------

DQMPage.register("raw_event", function (ctx) {
  ctx.body.appendChild(el("div", { class: "dqm-note", id: "raw-note" },
    "Fills from the same event as the waveforms above."));
  ctx.body.appendChild(el("div", { id: "raw-timing" }));
  ctx.body.appendChild(el("div", { id: "raw-table" }));
});

//: Microseconds, or an em dash. AT00's telemetry is zero in anything that
//: repackages a recording, so a column of "0" would read as "the readout took
//: no time" rather than "nobody reported it".
function us(v, reported) {
  return reported ? `${v}` : "—";
}

/**
 * AT00's readout telemetry and AC00's collector record, as two small tables.
 *
 * Neither is plotted anywhere: they are per-event scalars about how the DAQ
 * assembled the event, and the place to read them is beside the event they
 * describe. What they are good for is spotting an event that was built wrong --
 * a collector that disagrees with the banks it collected, or a chip whose
 * readout took far longer than its siblings.
 */
function updateTimingTables() {
  const host = document.getElementById("raw-timing");
  if (!host || !state.event) return;
  host.innerHTML = "";

  const t = state.event.timing;
  if (t) {
    // Zero throughout means the frontend does not report it, which is the case
    // for every repackaged recording. Say that once rather than tabulate zeros.
    const reported = ADBanks.AT_TELEMETRY_FIELDS.some((f) => t[f] > 0);
    host.appendChild(el("div", { class: "dqm-note" },
      reported
        ? "AT00 readout telemetry, microseconds, per chip summed and worst-case."
        : "AT00 carries no readout telemetry in this file: every field is zero, "
          + "which is what a repackaged recording writes."));

    const table = el("table", { class: "dqm-table mtable", id: "at-telemetry" });
    table.appendChild(el("tr", {},
      el("th", { class: "label" }, ""), el("th", {}, "prepare"),
      el("th", {}, "read"), el("th", {}, "decode"), el("th", {}, "total")));
    [["sum", "sum"], ["max", "max"]].forEach(function (row) {
      table.appendChild(el("tr", {},
        el("td", { class: "label" }, row[0]),
        el("td", {}, us(t[`sp_prepare_us_${row[1]}`], reported)),
        el("td", {}, us(t[`sp_read_us_${row[1]}`], reported)),
        el("td", {}, us(t[`sp_decode_us_${row[1]}`], reported)),
        el("td", {}, us(t[`sp_total_us_${row[1]}`], reported))));
    });
    host.appendChild(table);
    host.appendChild(el("div", { class: "dqm-note", id: "at-parents" },
      `${t.nparents} parent${t.nparents === 1 ? "" : "s"}, `
      + `acquisition retries ${us(t.sp_acq_retry_sum, reported)} `
      + `(worst chip ${us(t.sp_acq_retry_max, reported)}).`));
  }

  const c = state.event.collector;
  if (!c) {
    host.appendChild(el("div", { class: "dqm-note", id: "ac-note" },
      "No collector bank in this event: nothing describes how it was built."));
    return;
  }
  host.appendChild(el("div", { class: "dqm-note", id: "ac-note" },
    `AC00 collector: ${c.n_events} event${c.n_events === 1 ? "" : "s"}, `
    + `${c.total_hits} hits, stamped ${c.collector_timestamp_ns} ns.`));

  const ac = el("table", { class: "dqm-table mtable", id: "ac-timing" });
  ac.appendChild(el("tr", {},
    el("th", {}, "wait"), el("th", {}, "group build"),
    el("th", {}, "finalize"), el("th", {}, "total")));
  ac.appendChild(el("tr", {},
    el("td", {}, String(c.wait_us)), el("td", {}, String(c.group_build_us)),
    el("td", {}, String(c.finalize_us)), el("td", {}, String(c.total_us))));
  host.appendChild(ac);
}

function updateRawEvent() {
  updateTimingTables();
  const host = document.getElementById("raw-table");
  if (!host || !state.event) return;
  host.innerHTML = "";

  const note = document.getElementById("raw-note");
  if (note && state.event.timing) {
    note.textContent = `Event ${state.event.serial}, frontend timestamp `
      + `${state.event.timing.timestamp_ns} ns, banks ${state.event.bankNames.join(" ")}.`;
  }

  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {},
    el("th", { class: "label" }, "ch"), el("th", { class: "label" }, "chip/in"),
    el("th", {}, "n"), el("th", {}, "baseline V"), el("th", {}, "amplitude V"),
    el("th", {}, "peak V"), el("th", {}, "ToT ns"), el("th", {}, "t0 ns")));

  state.event.hits.forEach(function (h) {
    table.appendChild(el("tr", {},
      el("td", { class: "label" }, String(h.global_channel)),
      el("td", { class: "label" }, `${h.sampic_index}/${h.channel_index}`),
      el("td", {}, String(h.data_size)),
      el("td", {}, h.baseline.toFixed(4)),
      el("td", {}, h.amplitude.toFixed(4)),
      el("td", {}, h.peak.toFixed(4)),
      // The converter writes -1 where its source carries no time-over-threshold.
      // Printing the sentinel as a number would put -1.000 ns in a column of
      // real measurements.
      h.haveTot ? el("td", {}, h.tot_value.toFixed(3))
                : el("td", { class: "masked" }, "—"),
      el("td", {}, h.first_cell_timestamp.toFixed(1))));
  });
  host.appendChild(table);
}

// ---------------------------------------------------------------------------
// Per-viewer preferences. Never state anyone else depends on.
// ---------------------------------------------------------------------------

function restore() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}") || {};
  } catch (e) {
    return {};                        // private window, blocked site data
  }
}

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      excluded: Array.from(excluded()),
    }));
  } catch (e) { /* a preference that cannot be saved is not worth an alert */ }
}

})();
