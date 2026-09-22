//
// dqm-scope.js -- one event, decoded in the browser.
//
// Mechanism B, and the only page in this set that needs no analyzer and no
// accumulated state: mjsonrpc's bm_receive_event pulls a raw event out of the
// buffer as an ArrayBuffer, bkToObj() in midas.js splits it into banks,
// dqm-adbanks.js turns AD00 into volts, and mplot.js draws it.
//
// Three panels here are live, all off the same decoded event. atar_hit_positions
// draws it as two target maps -- layer up, strip across, one map per strip
// orientation, in the column order the waveforms above use. event_display_energy
// draws the charge summed per layer as a depth profile, with the event total
// beside it.
//
// Those two were one panel until the tab conversion, and splitting them is a
// return to what the spec always said: its note on event_display_energy argued
// that position and energy are two questions -- where did the charge land, and
// how deep did it get -- and that collapsing them lets the second disappear
// into the first one's readiness. They still share one channel map, one poll
// and one event, so the split is in the tiles and not in the mechanism.
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
  mapHost: null,           // the hit-position maps' host div, once it renders
  depthHost: null,         // the charge-depth profile's host div, once it renders
  chargeGraphs: null,      // one entry per layer cell in that display
};

const STORE = "dqm-scope-settings";

//: How far our legend sits inside the corner of the plot area, in CSS pixels.
const LEGEND_INSET = 4;

/**
 * The legend, in the bottom-right corner of the plot area, drawn by us.
 *
 * mplot's own legend is turned off on these plots and this replaces it, for one
 * reason: mplot draws it at the TOP-LEFT of the plot area -- hard coded to
 * (x1, y2) in its draw path, with no placement option anywhere in its
 * parameters -- and fills it opaque. On a waveform panel that corner is exactly
 * where the pre-pulse baseline sits, because a SAMPIC pulse is negative-going
 * from a high baseline: the flat run before the pulse IS the top-left of every
 * trace, and it is what a shifter reads to answer "is this channel sitting
 * where it should, and is it quiet". A layer with two traces hid twice as much,
 * and because the box is a fixed pixel width it covered more of a narrow panel
 * and not less.
 *
 * Bottom-right is empty on these plots for the same reason top-left is not: the
 * trace lives near the top of its range and comes back there after the pulse.
 *
 * A DOM overlay rather than a patched mplot.js, which is a MIDAS resource this
 * page set is a guest in and must not fork. It is also not a new idea here --
 * heatLegend, diffLegend and stripLegend are all hand-built -- and it buys a
 * legend that can be selected and read by a screen reader, which a canvas
 * cannot. pointer-events: none in the stylesheet keeps drag-to-zoom working
 * through it.
 *
 * Positioned from `graph.x2` and `graph.y1`, the plot-area bounds mplot's
 * draw() computes, so the box tracks the axis labels rather than guessing an
 * inset: a y axis that grows a digit moves the plot area, and a legend pinned
 * to the host would drift out of the corner it is supposed to be in. When those
 * are not readable -- before the first draw, and under the node suite, which
 * has no layout -- the stylesheet's own corner is the fallback and the rows are
 * still built, so what it SAYS is testable even where where it sits is not.
 */
function placeLegend(div, graph) {
  if (!div || !graph) return;
  const plots = (graph.param.plot || []).filter((p) => p.label);
  let box = div.dqmLegend;
  if (!plots.length) {
    if (box) box.hidden = true;
    return;
  }
  if (!box) {
    box = el("div", { class: "dqm-plot-legend" });
    div.appendChild(box);
    div.dqmLegend = box;
  }
  box.hidden = false;
  box.textContent = "";
  plots.forEach(function (p) {
    const swatch = el("span", { class: "dqm-plot-legend-swatch" });
    swatch.style.background = (p.line && p.line.color) || "#666";
    box.appendChild(el("div", { class: "dqm-plot-legend-row" },
      swatch, el("span", {}, p.label)));
  });

  const cv = graph.canvas;
  const w = cv ? cv.clientWidth : 0;
  const h = cv ? cv.clientHeight : 0;
  // Scaled, because the canvas may be painting a bitmap from the last layout
  // into a box of a slightly different size -- see the max-width rule on
  // .dqm-scope-plot canvas. One frame of 0.4%, but the arithmetic is free.
  if (w && h && cv.width && cv.height
      && isFinite(graph.x2) && isFinite(graph.y1)) {
    const sx = w / cv.width;
    const sy = h / cv.height;
    box.style.right = `${Math.max(0, Math.round(w - graph.x2 * sx)) + LEGEND_INSET}px`;
    box.style.bottom = `${Math.max(0, Math.round(h - graph.y1 * sy)) + LEGEND_INSET}px`;
  } else {
    box.style.right = "";
    box.style.bottom = "";
  }
}

/**
 * Run after mplot has actually painted.
 *
 * `redraw()` defers to requestAnimationFrame, so the plot-area bounds the
 * legend is positioned from do not exist yet when it returns. Queuing our own
 * frame puts us after mplot's in the same queue. Synchronous where there is no
 * rAF at all, which is the node suite: the callback still runs, and placement
 * falls back to the stylesheet.
 */
function afterDraw(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else fn();
}

//: Past this many traces at once the plot is a smear with a legend over it, and
//: the page says so rather than silently dropping any.
const BUSY_OVERLAY = 8;

//: The ATAR channel map, or null while it is being read and if it is not there.
//:
//: Read once per page load by dqm-atar-geom.js and shared with the Channels
//: tab, which builds the same eight-panel block for baselines. It stays null
//: when the settings are not there -- which is the honest state for a file
//: whose frontend never wrote them. The page then draws one panel, as it
//: always did.
let layerMap = null;

//: This page's two questions of the map. They take the hit rather than a bare
//: channel number, which is what every call site here has.
function layerOf(hit) { return ATARGeom.layerOf(layerMap, hit.global_channel); }
function stripOf(hit) { return ATARGeom.stripOf(layerMap, hit.global_channel); }

const orientationOf = ATARGeom.orientationOf;
const loadChannelMap = ATARGeom.load;

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

  ctx.body.appendChild(el("div", { id: "scope-channels" }));
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
      legend: { show: false },            // ours instead; see placeLegend
      // False, not for want of wanting it: a tile that keeps the wheel is a
      // tile the page cannot be scrolled past. mplot cancels every wheel
      // event inside the axis window, so with the cursor over a plot the
      // page stands still while the axes silently zoom, which reads as a
      // frozen page rather than as a feature -- and it bites hardest when
      // the plot is the first tile, where the cursor already is. There is no
      // modifier to gate it on; mplot's option is a boolean. Zooming is not
      // lost: drag along an axis still zooms, and the tile's own reset
      // button still restores the range.
      mouseWheelZoom: false,
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
        [["scope-ed-note", "No hit-position display: it plots against strip "
            + "position, and /Equipment/SAMPIC/Settings carries no ATAR "
            + "geometry to place a channel on a layer or a strip."],
         ["scope-depth-note", "No depth profile: charge is summed per layer, "
            + "and /Equipment/SAMPIC/Settings carries no ATAR geometry to say "
            + "which layer a channel is in."]].forEach(function (pair) {
          const note = document.getElementById(pair[0]);
          if (note) { note.className = "dqm-diagnosis"; note.textContent = pair[1]; }
        });
        return;
      }
      buildLayerPanels(ctx.body, plot, map);
      // The two charge tiles below may have rendered before this resolved, in
      // which case their hosts are waiting and empty.
      fillChargeHosts(map);
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
  if (note) {
    note.textContent = `One panel per ATAR layer, in two columns by strip `
      + `orientation, from ${map.source}.`;
  }

  state.graphs = [];
  // The two-column-by-parity host, which with eight layers is four rows. Built
  // in dqm-atar-geom.js because the baseline tiles on the Channels tab are
  // read in the same block, and two files laying out the target by hand is two
  // files to disagree about which column is which coordinate.
  const host = el("div", { class: "dqm-layer-grid", id: "scope-layer-panels" });
  body.insertBefore(host, firstPlot);
  const columns = ATARGeom.layerColumns(host, map, "scope");

  map.layers.forEach(function (layer) {
    const col = columns.get(layer % 2);
    const orient = orientationOf(map, layer);
    const title = el("div", { class: "dqm-subhead" },
      orient ? `Layer ${layer} (${orient})` : `Layer ${layer}`);
    const div = el("div", { class: "dqm-scope-plot", id: `scope-plot-L${layer}` });
    col.appendChild(title);
    col.appendChild(div);
    const g = new MPlotGraph(div, {
      title: { text: "" },
      stats: { show: false },
      legend: { show: false },            // ours instead; see placeLegend
      // False, not for want of wanting it: a tile that keeps the wheel is a
      // tile the page cannot be scrolled past. mplot cancels every wheel
      // event inside the axis window, so with the cursor over a plot the
      // page stands still while the axes silently zoom, which reads as a
      // frozen page rather than as a feature -- and it bites hardest when
      // the plot is the first tile, where the cursor already is. There is no
      // modifier to gate it on; mplot's option is a boolean. Zooming is not
      // lost: drag along an axis still zooms, and the tile's own reset
      // button still restores the range.
      mouseWheelZoom: false,
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

//: How many hidden channels the closed picker names before it counts the rest.
//:
//: Six fits the summary line at the width the tile actually has. Past that the
//: line wraps and the picker is taking the space back that collapsing it was
//: supposed to save.
const PICKER_NAMED = 6;

/**
 * The channel picker: a disclosure, not a wall of boxes.
 *
 * One checkbox per channel ever seen was fine at run 108's thirty-two and is
 * not fine at the demonstrator's 256 -- a block of 256 chips above the plot,
 * which is most of a screen spent on a control almost nobody touches. Closed,
 * this is one line.
 *
 * **The summary has to say what is hidden, and that is not decoration.** The
 * whole argument for an opt-out set, two functions up, is that a partly drawn
 * event with no sign that anything is missing is the failure this page already
 * made once. Folding the boxes away would recreate it exactly -- the traces
 * would be missing and the only evidence would be behind a click -- so the
 * closed line names the excluded channels and marks itself when there are any.
 * A picker that collapsed silently would be worse than the wall it replaced.
 *
 * Open state is deliberately not remembered. It defaults closed, which is the
 * point of the change, and a remembered "open" would bring the wall back on
 * some other day with nothing to say why.
 */
function renderChannelPicker() {
  const host = document.getElementById("scope-channels");
  if (!host || !state.event) return;
  // Every channel seen so far, not just this event's: a box that vanishes when
  // its channel happens not to fire is a box nobody can untick.
  state.event.channels.forEach((c) => known.add(c));
  const key = Array.from(known).sort((a, b) => a - b).join(",");
  // Rebuilt only when the set grows, so it does not fight the operator's
  // clicks -- and the summary is refreshed either way, because a box ticked
  // inside it changes the line without changing the set.
  if (host.dataset.channels !== key) {
    host.dataset.channels = key;
    const previous = document.getElementById("scope-picker");
    const wasOpen = !!(previous && previous.open);
    host.innerHTML = "";

    const box = el("details", { class: "dqm-picker", id: "scope-picker" });
    // Growing the channel set must not shut the picker under the hand of
    // somebody in the middle of using it.
    if (wasOpen) box.open = true;
    box.appendChild(el("summary", { id: "scope-picker-summary" }, ""));

    const grid = el("div", { class: "dqm-picker-grid", id: "scope-picker-grid" });
    key.split(",").filter((x) => x !== "").map(Number).forEach(function (ch) {
      const tick = el("input", { type: "checkbox" });
      tick.checked = !excluded().has(ch);
      tick.addEventListener("change", function () {
        if (this.checked) excluded().delete(ch); else excluded().add(ch);
        save();
        summarisePicker();
        draw();
      });
      grid.appendChild(el("label", { class: "dqm-chip" },
        tick, el("span", {}, `ch ${ch}`)));
    });
    box.appendChild(grid);
    host.appendChild(box);
  }
  summarisePicker();
}

/** The closed picker's one line: how many draw, and which do not. */
function summarisePicker() {
  const line = document.getElementById("scope-picker-summary");
  if (!line) return;
  const all = Array.from(known).sort((a, b) => a - b);
  const off = all.filter((ch) => excluded().has(ch));
  line.className = off.length ? "dqm-picker-hiding" : "";
  if (!off.length) {
    line.textContent = `Channels: all ${all.length} drawn`;
    return;
  }
  const named = off.slice(0, PICKER_NAMED).map((ch) => `ch ${ch}`).join(", ");
  const rest = off.length - PICKER_NAMED;
  line.textContent = `Channels: ${all.length - off.length} of ${all.length} drawn `
    + `\u2014 hiding ${named}${rest > 0 ? ` and ${rest} more` : ""}`;
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
    // Coloured by strip position, not by channel: within a layer panel the
    // layer is already the heading, so what a trace still has to say is where
    // across the layer it sat. Two layers' traces at the same strip then share
    // a colour, which is the point -- a track crossing the target shows as the
    // same colour appearing down both columns.
    const strip = stripOf(hit);
    const label = (strip === null ? `ch ${hit.global_channel}` : `strip ${strip}`)
      + (hit.hit_number ? ` #${hit.hit_number}` : "");
    panel.graph.param.plot.push({
      label: label, type: "scatter",
      line: { draw: true, width: 1,
              color: strip === null ? colourFor(hit.global_channel)
                : stripColour(strip, layerMap.stripLo, layerMap.stripHi) },
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
  // One frame later, because that is when mplot's own draw has run and the
  // plot-area bounds the legend is placed from exist.
  afterDraw(function () {
    panels.forEach(function (p) {
      placeLegend(p.div || p.graph.parentDiv, p.graph);
    });
  });

  // The charge display is the same event, so it is redrawn from here rather
  // than from its own loop. One place decides what is on screen.
  drawChargeDisplay();
}

//: The strip-position ramp and the fallback palette both live in
//: dqm-atar-geom.js, because the Channels tab's baseline tiles colour their
//: lines by the same strip position and the two views have to agree: a strip
//: that is teal in the waveform above is teal in the baseline beside it.
const stripColour = ATARGeom.stripColour;
const colourFor = ATARGeom.colourFor;

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
// event_display_energy -- the target, and how deep the track got
// ---------------------------------------------------------------------------
//
// Two views of one event, because they answer two questions and neither
// answers the other.
//
// The maps are the target seen end-on, one per strip orientation: strip across,
// layer up, one marker per hit sized and coloured by charge. That is where the
// particle went -- a track reads as a diagonal, a stop as a diagonal that ends.
// Eight separate charge-against-strip plots could not show that; the shape was
// spread across eight axes and had to be assembled by eye.
//
// The profile is the total charge in each layer against depth, which is the
// panel's own question: a muon that stops deposits more as it slows, so the
// curve rises and peaks where it stopped. A particle that went straight
// through leaves it flat. No amount of staring at the maps answers that, since
// the eye is bad at summing marker areas.
//
// Charge is encoded twice on the maps, as area and as colour. Redundant on
// purpose: area carries magnitude at a glance and colour survives the markers
// overlapping, which they do when two strips either side of a track both fire.

/**
 * The waveform's integral, baseline-subtracted, in V.ns.
 *
 * Called charge and not energy, which is the more honest of the two names for
 * what this is: the integral of a voltage over time, which is a charge up to
 * the input impedance, and is a *deposited energy* only after a per-channel
 * calibration that does not exist. That calibration is the blocker the two
 * energy panels on the Trends and Proposed tabs already name. Even "charge" is uncalibrated here --
 * hence V.ns on the axis rather than coulombs.
 *
 * Baseline-subtracted and sign-flipped so it comes out positive: the pulses are
 * negative-going from a baseline near 0.75 V, so a raw integral would be
 * dominated by the baseline's own area and would *fall* as the pulse grew.
 *
 * Over the whole record rather than an integration window around the peak.
 * With no window defined anywhere, picking one here would be inventing a
 * calibration constant in the middle of a display -- and decode_hit already
 * truncates to data_size, so this is the real record and never zero padding.
 */
function chargeOf(hit, dt) {
  const w = hit.waveform;
  if (!w || !w.length) return 0;
  const base = hit.baseline;
  let sum = 0;
  for (let i = 0; i < w.length; i++) sum += base - w[i];
  // Without a sample period, the integral is in volt-samples. Reported anyway
  // rather than zeroed: the shape across strips is the point here, and the
  // axis title says which unit it is in.
  return dt ? sum * dt : sum;
}

//: What the charge axis is in, which depends on whether a sample period is set.
function dtLabel() {
  return Number(state.cfg && state.cfg["Sample Period ns"])
    ? "charge (V·ns)" : "charge (V·samples)";
}

//: Marker diameter for a charge, in px -- mplot's marker.size is a diameter,
//: it draws arc(x, y, size / 2). sqrt so that *area* is proportional to charge:
//: area is what the eye reads, and scaling the diameter linearly would make a
//: twice-as-large deposit look four times as big.
//:
//: The floor is well clear of zero because a marker's job here is first to say
//: a strip fired at all. A hit that deposited almost nothing is still a hit,
//: and shrinking it to a dot loses the position, which is the other half of
//: what this map is for.
const MARK_MIN = 7;
const MARK_MAX = 28;
function markerSize(charge, maxCharge) {
  if (!(maxCharge > 0) || !(charge > 0)) return MARK_MIN;
  const t = Math.sqrt(Math.min(1, charge / maxCharge));
  return MARK_MIN + t * (MARK_MAX - MARK_MIN);
}

/**
 * Fill whichever of the two charge hosts have rendered, now that the map is in.
 *
 * Both tiles depend on the same channel map and either may render first -- they
 * are separate panels on one tab, and the order the catalogue puts them in is
 * not something either renderer should have to know.
 */
function fillChargeHosts(map) {
  if (state.mapHost) {
    const note = document.getElementById("scope-ed-note");
    if (note) note.textContent = mapsNote(map);
    buildHitMaps(state.mapHost, map);
  }
  if (state.depthHost) {
    const note = document.getElementById("scope-depth-note");
    if (note) note.textContent = depthNote(map);
    buildDepthProfile(state.depthHost, map);
  }
}

/**
 * Build the two target maps.
 *
 * Which orientation goes on the left is read from the ODB rather than assumed,
 * the same way the waveform columns do it -- a target built the other way round
 * would otherwise put every label on the wrong side.
 */
function buildHitMaps(host, map) {
  if (!host || host.dataset.built) return;
  host.dataset.built = "1";
  host.innerHTML = "";

  const evens = map.layers.filter((L) => L % 2 === 0);
  const odds = map.layers.filter((L) => L % 2 === 1);
  const evenOrient = evens.length ? orientationOf(map, evens[0]) : null;
  // Vertical strips measure x. Default to evens-on-the-left when the ODB does
  // not say, which is the order the waveform columns above use.
  const leftIsEven = evenOrient !== "horizontal";
  const cols = leftIsEven ? [evens, odds] : [odds, evens];

  const row = el("div", { class: "dqm-ed-row" });
  host.appendChild(row);
  state.chargeMaps = [];

  cols.forEach(function (layers) {
    const cell = el("div", { class: "dqm-ed-cell" });
    row.appendChild(cell);
    if (!layers.length) return;
    const orient = orientationOf(map, layers[0]);
    const coord = orient === "horizontal" ? "y" : "x";
    cell.appendChild(el("div", { class: "dqm-subhead dqm-col-head" },
      `${coord} view — ${orient || "unknown"} strips, layers `
      + layers.join(", ")));
    const div = el("div", { class: "dqm-scope-plot", id: `scope-ed-map-${coord}` });
    cell.appendChild(div);
    const g = new MPlotGraph(div, {
      title: { text: "" },
      stats: { show: false },
      legend: { show: false },
      mouseWheelZoom: false,
      xAxis: { title: { text: `${coord} (strip centre)` } },
      yAxis: { title: { text: "layer" } },
      plot: [],
    });
    div.mpg = g;
    state.chargeMaps.push({ coord: coord, layers: layers, graph: g, div: div });
  });
  // Sized only once both cells are in the row. auto-fit collapses a track with
  // nothing in it, so while the x cell is the row's only child it spans the
  // whole row; sized then, its bitmap is twice its final width, and the canvas's
  // max-width scales that down with the aspect ratio kept -- a map drawn at half
  // the height of the y view beside it, until the window next resizes.
  state.chargeMaps.forEach(function (m) { m.graph.resize(); });
}

/**
 * Build the depth profile and the total beside it.
 *
 * "Total edep" is a chip and not a plot on purpose: it is one number about this
 * event, and the rule this page set follows is that a value nobody is asking a
 * temporal question about is a chip. It is charge, in V*ns, and the label says
 * so -- calling it energy would need the calibration nobody owns.
 */
function buildDepthProfile(host, map) {
  if (!host || host.dataset.built) return;
  host.dataset.built = "1";
  host.innerHTML = "";

  const foot = el("div", { class: "dqm-ed-profile" });
  host.appendChild(foot);
  foot.appendChild(el("div", { class: "dqm-subhead dqm-col-head" },
    "Charge against depth — every layer, both orientations"));
  const totals = el("div", { class: "dqm-strip", id: "scope-depth-totals" });
  foot.appendChild(totals);
  totals.appendChild(chip("total", el("span", { id: "scope-depth-total" }, "—"), "V·ns"));
  totals.appendChild(chip("layers hit", el("span", { id: "scope-depth-nlayers" }, "—"), ""));
  const pdiv = el("div", { class: "dqm-scope-plot", id: "scope-ed-profile" });
  foot.appendChild(pdiv);
  const pg = new MPlotGraph(pdiv, {
    title: { text: "" },
    stats: { show: false },
    legend: { show: false },
    mouseWheelZoom: false,
    xAxis: { title: { text: "layer (beam enters at the lowest)" } },
    yAxis: { title: { text: dtLabel() } },
    plot: [],
  });
  pdiv.mpg = pg;
  state.chargeProfile = { graph: pg, div: pdiv, layers: map.layers.slice() };
  pg.resize();
}

/**
 * Draw the current event. Same event as the waveforms above it.
 *
 * Called from draw(), so there is exactly one place that decides which event is
 * on screen and both sections follow it -- including the pause button and the
 * channel ticks, which is the behaviour anyone comparing the two would assume
 * without being told.
 */
function drawChargeDisplay() {
  if (!state.event) return;
  // Guarded separately from here down: the maps and the profile are two tiles
  // now and either can be absent -- a channel map that never arrived leaves
  // both unbuilt, and a renderer that threw leaves one.
  if (!layerMap) return;
  const dt = Number(state.cfg["Sample Period ns"]) || 0;

  // One pass over the hits, since both views are the same event read two ways.
  const hits = [];
  const perLayer = new Map();
  state.event.hits.forEach(function (hit) {
    if (excluded().has(hit.global_channel)) return;
    const layer = layerOf(hit);
    const strip = stripOf(hit);
    // A channel the map cannot place has no position to plot against, so it is
    // left out here rather than guessed at. It is still drawn as a waveform in
    // the unmapped panel above, which is where a hit nobody can place belongs.
    if (layer === null || strip === null) return;
    const q = chargeOf(hit, dt);
    hits.push({ layer: layer, strip: strip, q: q });
    perLayer.set(layer, (perLayer.get(layer) || 0) + q);
  });

  let qMax = 0;
  hits.forEach(function (h) { if (h.q > qMax) qMax = h.q; });

  const xLo = layerMap.stripLo - 0.5;
  const xHi = layerMap.stripHi + 0.5;

  (state.chargeMaps || []).forEach(function (m) {
    m.graph.param.plot = [];
    const lo = Math.min.apply(null, m.layers) - 0.5;
    const hi = Math.max.apply(null, m.layers) + 0.5;
    const mine = hits.filter((h) => m.layers.indexOf(h.layer) >= 0);

    // One plot per hit, because mplot's marker size and colour are per *plot*
    // and there is no per-point form. A dozen one-point plots an event is
    // nothing, and it is the only way to size each marker by its own charge.
    mine.forEach(function (h) {
      m.graph.param.plot.push({
        label: `L${h.layer} s${h.strip}`,
        type: "scatter",
        line: { draw: false },
        // lineColor/fillColor, not color: mplot's drawMarker() reads exactly
        // those two and silently ignores anything else, so a `color` here
        // draws every marker in the default dark and the colour half of the
        // encoding goes missing with no error.
        marker: { draw: true, style: "circle",
                  size: markerSize(h.q, qMax),
                  lineColor: "#00000055",
                  fillColor: stripColour(h.q, 0, qMax || 1) },
        xData: [h.strip], yData: [h.layer],
        xMin: xLo, xMax: xHi, yMin: lo, yMax: hi,
      });
    });
    // An empty view keeps its axes: a map with no markers says "nothing in
    // this projection", where a blank panel says the page is broken.
    if (!mine.length) {
      m.graph.param.plot.push({
        label: "no hits in this view", type: "scatter",
        line: { draw: false }, marker: { draw: false },
        xData: [], yData: [], xMin: xLo, xMax: xHi, yMin: lo, yMax: hi,
      });
    }
    m.graph.calcMinMax();
    m.graph.redraw();
  });

  if (state.chargeProfile) {
    const p = state.chargeProfile;
    // Only the layers that recorded something. A layer with no hit did not
    // measure zero charge, it measured nothing, and drawing it at zero says
    // the first when the data only supports the second -- which on an event
    // that fired every other layer turned the profile into a sawtooth that
    // read as the deposition swinging up and down.
    const xs = [];
    const ys = [];
    p.layers.forEach(function (L) {
      const q = perLayer.get(L) || 0;
      if (q > 0) { xs.push(L); ys.push(q); }
    });
    let hi = 0;
    ys.forEach(function (v) { if (v > hi) hi = v; });

    // The axis still spans every layer, which is the part that must not follow
    // the data. Fitted to the layers that fired, a track stopping at layer 3
    // would draw exactly like one crossing all eight -- the same curve, filling
    // the same width -- and where it stopped is the whole question. Against a
    // fixed axis the line simply ends early, and the empty space to the right
    // is the answer.
    const axLo = Math.min.apply(null, p.layers) - 0.5;
    const axHi = Math.max.apply(null, p.layers) + 0.5;
    p.graph.param.plot = [{
      label: "charge per layer",
      type: "scatter",
      // The line still joins across a skipped layer. Left that way because the
      // gap is already visible as the wider step along a fixed axis, and
      // breaking the curve into segments made an event that alternates layers
      // read as several unrelated tracks.
      line: { draw: true, width: 2, color: "#1f77b4" },
      marker: { draw: true, size: 7, style: "circle",
                lineColor: "#1f77b4", fillColor: "#1f77b4" },
      xData: xs, yData: ys,
      xMin: axLo, xMax: axHi,
      yMin: 0, yMax: (hi > 0 ? hi : 1) * 1.1,
    }];
    p.graph.calcMinMax();
    p.graph.redraw();

    // The total is over every layer that recorded something, which is the same
    // set the curve is drawn from -- so the number and the plot cannot disagree
    // about what "this event" means.
    let total = 0;
    ys.forEach(function (v) { total += v; });
    setText("scope-depth-total", total > 0 ? total.toPrecision(4) : "—");
    setText("scope-depth-nlayers", xs.length ? `${xs.length} of ${p.layers.length}` : "—");
  }
}

DQMPage.register("atar_hit_positions", function (ctx) {
  const note = el("div", { class: "dqm-note", id: "scope-ed-note" },
    "Reading the channel map…");
  const host = el("div", { id: "scope-ed-panels" });
  ctx.body.appendChild(note);
  ctx.body.appendChild(host);
  state.mapHost = host;

  // The map may already be in hand: this panel renders after the waveform one,
  // and whether its load has resolved yet is a race nobody should have to win.
  if (layerMap) {
    note.textContent = mapsNote(layerMap);
    buildHitMaps(host, layerMap);
    if (state.event) drawChargeDisplay();
  }
});

DQMPage.register("event_display_energy", function (ctx) {
  const note = el("div", { class: "dqm-note", id: "scope-depth-note" },
    "Reading the channel map…");
  const host = el("div", { id: "scope-depth-panels" });
  ctx.body.appendChild(note);
  ctx.body.appendChild(host);
  state.depthHost = host;

  if (layerMap) {
    note.textContent = depthNote(layerMap);
    buildDepthProfile(host, layerMap);
    if (state.event) drawChargeDisplay();
  }
});

function mapsNote(map) {
  return `The event shown above, from ${map.source}. Each map is the target `
    + `end-on -- strip across, layer up, one map per strip orientation, marker `
    + `area and colour both the charge. A channel the map cannot place is left `
    + `out here and still drawn as a waveform above, which is where a hit `
    + `nobody can place belongs.`;
}

function depthNote(map) {
  return `The same event, from ${map.source}: the charge in each layer, and the `
    + `total over the layers that recorded any. A layer with no hit is left out `
    + `rather than drawn at zero -- it did not measure zero, it measured `
    + `nothing. Charge is the baseline-subtracted integral of the waveform, `
    + `which is an energy only after a calibration nobody owns, hence V·ns.`;
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

// The colour ramp is exported so it can be tested across the whole strip range
// rather than only across the strips one fixture event happens to light -- the
// first attempt at testing it did exactly that, and passed with the ramp taken
// out, because every hit in that event was on strip 0.
//
// Re-exported rather than defined here since the ramp moved to
// dqm-atar-geom.js: what the test is pinning is that *this page's* traces are
// coloured by strip position, and it should keep failing if this file stops
// reaching for it.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { stripColour, colourFor, PICKER_NAMED,
                     VIRIDIS: ATARGeom.VIRIDIS, RAMP_TOP: ATARGeom.RAMP_TOP,
                     PALETTE: ATARGeom.PALETTE };
}

})();
