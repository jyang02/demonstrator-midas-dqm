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
// Loop shape is Stefan Ritt's, from the WaveDREAM browser scope: a chained
// setTimeout re-armed *from the response*, never a fixed setInterval, so a slow
// reply throttles the loop instead of stacking requests behind it.
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
  lastAt: null,
  selected: null,          // null until the first event says what exists
  graph: null,
  cfg: null,
};

const STORE = "dqm-scope-settings";

//: How many channels to overlay before it stops being a plot and starts being a
//: smear with a legend over it.
const MAX_OVERLAY = 8;

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
    state.graph.resize();
    state.graph.draw();
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
  });
  if (!decoded) { state.emptyPolls++; return update(); }

  state.event = decoded;
  state.seen++;
  state.emptyPolls = 0;
  state.lastAt = Date.now();

  if (state.selected === null) pickChannels(decoded);
  renderChannelPicker();
  draw();
  update();
  updateRawEvent();
}

/** What the frontend is actually sending, learned from the first event. */
function pickChannels(decoded) {
  const saved = restore().selected;
  state.selected = new Set();
  if (saved && saved.length) {
    saved.forEach((c) => state.selected.add(Number(c)));
  }
  if (!state.selected.size) {
    decoded.channels.slice(0, MAX_OVERLAY).forEach((c) => state.selected.add(c));
  }
}

function renderChannelPicker() {
  const host = document.getElementById("scope-channels");
  if (!host || !state.event) return;
  // Rebuilt only when the channel set changes: an event on a new channel should
  // add a box, but rebuilding every second would fight the operator's clicks.
  const key = state.event.channels.join(",");
  if (host.dataset.channels === key) return;
  host.dataset.channels = key;
  host.innerHTML = "";

  state.event.channels.forEach(function (ch) {
    const box = el("input", { type: "checkbox" });
    box.checked = state.selected.has(ch);
    box.addEventListener("change", function () {
      if (this.checked) state.selected.add(ch); else state.selected.delete(ch);
      save();
      draw();
    });
    const label = el("label", { class: "dqm-chip" }, box, el("span", {}, `ch ${ch}`));
    host.appendChild(label);
  });
}

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
  state.graph.param.plot = [];
  const drawn = [];

  state.event.hits.forEach(function (hit) {
    if (!state.selected.has(hit.channel)) return;
    // With no period configured, plot against sample index rather than a row of
    // zeros: an honest axis in the wrong unit beats every point stacked at x=0.
    const xs = dt ? ADBanks.sampleTimes(hit, dt)
                  : Array.from(hit.waveform, (_, i) => i);
    // A 64-sample hit never needs reducing; this is here so a longer waveform
    // format does not silently become a 4000-point polyline per channel.
    const cut = ADBanks.minMaxDecimate(xs, hit.waveform, 600);
    const label = `ch ${hit.channel}${hit.hit_number ? ` #${hit.hit_number}` : ""}`;
    state.graph.param.plot.push({
      label: label, type: "scatter",
      line: { draw: true, width: 1, color: colourFor(hit.channel) },
      marker: { draw: false },
      xData: cut.x, yData: cut.y,
    });
    drawn.push(label);
  });

  if (!drawn.length) {
    // An empty plot rather than none at all: mplot with a zero-length plot list
    // draws no axes either, and a panel with no axes reads as broken rather
    // than as "no channel selected".
    state.graph.param.plot.push({
      label: "no channel selected", type: "scatter",
      line: { draw: true, width: 1 }, marker: { draw: false },
      xData: [], yData: [],
    });
  }
  state.graph.redraw();
}

//: matplotlib's tab10, the set the retired DQM drew with. Channel number modulo
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
  ctx.body.appendChild(el("div", { id: "raw-table" }));
});

function updateRawEvent() {
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
      el("td", { class: "label" }, String(h.channel)),
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
      selected: state.selected ? Array.from(state.selected) : [],
    }));
  } catch (e) { /* a preference that cannot be saved is not worth an alert */ }
}

})();
