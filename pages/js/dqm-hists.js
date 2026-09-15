//
// dqm-hists.js -- the analyzer-backed panels on Channels and Pulses.
//
// Six of the fifteen. Every one of them draws a histogram the `sampic` plugin
// accumulates from AD00 (src/mdqm/dqm/sampic_plugin.py), fetched over binary
// RPC and drawn by mplot. The mechanism is entirely generic -- dqm-brpc.js
// knows nothing about which histograms exist -- so the only thing this file
// adds is the one page-shaped fact: which plot belongs in which tile.
//
// The nine it does not claim are not oversights. Crosstalk and the time-between
// -layers panels need a channel-to-layer map that exists nowhere; the three
// time-vs-T0 panels need T0 in the same event record; MuPix and calorimeter
// panels need banks nothing writes; and the two energy panels on Pulses need a
// calibration with an owner. Those keep the empty state and their own reason,
// which is the correct outcome and needs no code here.
//
// `channel_health` is deliberately left unclaimed too. "Dead, noisy or
// drifting" is a verdict, not a histogram: occupancy, noise and baseline each
// answer one third of it in their own tile, and synthesising the other two
// thirds would mean inventing thresholds nobody has specified.
//

(function () {
"use strict";

const { el, chip, blocked, editButton } = DQMPage;

//: Panel id -> the histogram the analyzer publishes for it.
//:
//: The single source of this mapping. `/DQM/<page>/Histograms` lists the same
//: names for probeAnalyzer() to check against what the analyzer publishes, and
//: tests/test_panels.py asserts the two agree -- so the duplication is a
//: checked invariant rather than two places to forget.
const PANELS = {
  atar_occupancy:       "sampic/occupancy",
  hits_per_event:       "sampic/hits_per_event",
  baseline_by_channel:  "sampic/baseline_by_channel",
  noise_by_channel:     "sampic/noise_by_channel",
  pulse_persistence:    "sampic/persistence",
  amplitude_by_channel: "sampic/amplitude_by_channel",
};

//: How often to re-fetch a small histogram. These are accumulating histograms,
//: not a live trace: a shifter watches a shape settle over minutes, and asking
//: mhttpd -- the same process serving run control -- more often than this buys
//: nothing.
const REFRESH_MS = 2000;

//: Above this many bins, slow down (see refreshFor).
const BIG_HIST_CELLS = 8000;
//: Never slower than this, however large.
const MAX_REFRESH_MS = 15000;

/**
 * How often to refetch a histogram of this size.
 *
 * A per-channel colormap is 256 x 200 bins once the ATAR's channels are all
 * mapped: 51200 cells, about 208 kB on the wire, and 51200 rectangles for the
 * browser to paint. Three of those on one page at the small-histogram cadence
 * is 150000 cells every two seconds, which the browser cannot keep up with --
 * the server barely notices (mhttpd goes from 0.2% to 0.6% of a core) and the
 * tab crawls.
 *
 * Refetching that often buys nothing anyway, by this file's own argument: an
 * accumulating histogram settles over minutes. So the interval scales with the
 * size, and the cost per second stays roughly flat no matter how the channel
 * count grows.
 */
function refreshFor(cells) {
  if (!(cells > BIG_HIST_CELLS)) return REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.round(REFRESH_MS * cells / BIG_HIST_CELLS));
}

// ---------------------------------------------------------------------------
// One histogram, in one tile
// ---------------------------------------------------------------------------

function histPanel(name) {
  return function (ctx) {
    const client = String(ctx.cfg["Analyzer Client"] || "").trim();
    if (!client) {
      blocked(ctx.body,
        `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, so `
        + `this panel does not know whom to ask for ${name}.`,
        ctx.panel, `${DQM.CONFIG_ROOT}/Analyzer Client`);
      return;
    }

    const entries = el("span", {}, "—");
    const cadence = el("span", { class: "dqm-chip", id: `${name}-cadence` }, "");
    const strip = el("div", { class: "dqm-strip" },
      chip("histogram", el("code", {}, name)),
      chip("entries", entries), cadence);
    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const plotDiv = el("div", { class: "dqm-plot" });
    ctx.body.appendChild(strip);
    ctx.body.appendChild(note);
    ctx.body.appendChild(plotDiv);

    let graph = null;
    let drawn = false;

    async function build() {
      // Titles come from dqm::metadata rather than being repeated here: the
      // plugin already names its axes, and a second copy in the page is a
      // second thing to update when a binning changes.
      const meta = await BRPC.json(client, "dqm::metadata", name);
      const axes = (meta && meta.axes) || [];
      graph = new MPlotGraph(plotDiv, {
        title: { text: (meta && meta.title) || name },
        stats: { show: false },
        legend: { show: false },
        mouseWheelZoom: true,
        xAxis: { title: { text: (axes[0] && axes[0].title) || "" } },
        yAxis: { title: { text: (axes[1] && axes[1].title) || "counts" } },
        // display() fills this in; it must exist first, because it indexes
        // param.plot[index] and returns quietly when there is nothing there.
        plot: [{ label: name, type: "histogram",
                 line: { draw: true, width: 1 }, marker: { draw: false } }],
      });
      plotDiv.mpg = graph;              // reachable from the console and tests
      graph.resize();
    }

    let sized = false;

    async function tick() {
      if (!graph) await build();
      const hist = await BRPC.histogram(client, name);
      // Sized from the histogram itself, on its first arrival: the page cannot
      // know how many channels the map has until the analyzer answers.
      if (!sized) {
        sized = true;
        const cells = (hist.data && hist.data.length)
          || (hist.nx || 0) * (hist.ny || 1);
        const ms = refreshFor(cells);
        if (ms !== REFRESH_MS) {
          updater.setInterval(ms);
          // Said, not left to be discovered. A tile that repaints every 13
          // seconds with no explanation reads as a stuck tile, and the first
          // thing anyone does about a stuck tile is reload the page.
          cadence.textContent = `every ${Math.round(ms / 1000)} s`;
          cadence.title = `${cells} bins: refetched less often so the browser `
            + `keeps up. The small histograms here still update every `
            + `${REFRESH_MS / 1000} s.`;
        }
      }
      // setData() ends in calcMinMax() and redraw(), so unlike the Scope page
      // -- which assigns param.plot directly and has to do both by hand -- this
      // path needs neither.
      BRPC.display(hist, graph, 0);
      drawn = true;
      entries.textContent = String(hist.entries);
      note.className = "dqm-note";
      note.textContent = hist.entries
        ? ""
        : "The analyzer is answering and this histogram is still empty: either "
          + "no events have arrived since it was cleared, or nothing is filling it.";
    }

    const updater = new BRPC.AutoUpdater(tick, REFRESH_MS);
    updater.onError = function (e) {
      // Two different sentences on purpose. Never having drawn means the
      // analyzer is not there, which is what the other panels on this page say
      // in their own words. Having drawn and then failed means it went away,
      // and the plot on screen is now stale rather than wrong.
      note.className = "dqm-diagnosis red";
      note.textContent = drawn
        ? `"${client}" stopped answering for ${name} (${e.message}). The plot `
          + "above is the last one it sent, and is no longer being updated."
        : `Nothing answered as "${client}" for ${name} (${e.message}). That is `
          + "the analyzer these panels are waiting for.";
    };

    // Deferred for the same reason the Scope page defers: MPlotGraph reads
    // clientWidth in its constructor, and a div that has not been laid out yet
    // reports zero.
    setTimeout(function () { updater.start(); }, 0);
  };
}

Object.keys(PANELS).forEach(function (id) {
  DQMPage.register(id, histPanel(PANELS[id]));
});

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, refreshFor, REFRESH_MS, BIG_HIST_CELLS, MAX_REFRESH_MS };
}

})();
