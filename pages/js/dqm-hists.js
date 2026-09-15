//
// dqm-hists.js -- the analyzer-backed panels on Channels and Pulses.
//
// Six of the fifteen. Every one of them names a histogram the `sampic` plugin
// accumulates from AD00 (src/mdqm/dqm/sampic_plugin.py), fetched over binary
// RPC and drawn by mplot. The mechanism is entirely generic -- dqm-brpc.js
// knows nothing about which histograms exist -- so the only thing this file
// adds is the one page-shaped fact: which plot belongs in which tile.
//
// Four of the six draw today. The two still held back are the per-channel
// colormaps on Channels, which are one rectangle per bin -- 25600 of them each
// -- repainted on every fetch. That is what made these pages lag, and
// HELD_BACK below is the decision to stop drawing them until it is fixed
// rather than ship a page nobody can use. What is costly is bins per second
// rather than bins: persistence draws because it is small, and amplitude by
// channel draws at the same 25600 bins because a 32 s cadence makes it cheap.
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

const { el, chip, blocked, editButton, probeThisBox } = DQMPage;

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

//: The panels whose plot is held back: the tile carries an explanation instead.
//:
//: Both of these are per-channel colormaps: 256 x 100 = 25600 bins at the
//: default binning, one rectangle per bin, all of them repainted on every
//: arrival. Both are on Channels, which is what makes them worth holding --
//: they land in the same tab as each other and as occupancy and hits per
//: event, so their cost arrives all at once.
//:
//: Size is the criterion rather than dimensionality. Persistence is 2D as well
//: and draws: at 64 x 110 it is 7040 bins, under a third of one of these.
//: Amplitude by channel is a full 25600 and draws too, on Pulses, because
//: REFRESH_MS going to 10 s puts it on a 33 s cadence -- 800 bins a second
//: against the 4000 it was repainting when this set was first written, which
//: was the rate that made the page crawl. What is expensive is bins per
//: second, not bins. Measured once it was back: 1.5 ms a draw, the same as
//: persistence, and no frame over 40 ms in 40 s.
//:
//: 33 s and not the 32 the nominal binning implies, because refreshFor is
//: handed the length of what arrived rather than nx*ny, and the wire carries
//: the under- and overflow bins: (256+2) x (100+2) = 26316. Worth knowing
//: before checking one of these numbers against /DQM/Analyzer/Binning and
//: concluding the cadence is wrong.
//:
//: They stay in PANELS, and /DQM/<page>/Histograms goes on naming them, on
//: purpose. The analyzer still accumulates both and the page still asks
//: whether it publishes them, and heldBackPanel() puts that answer underneath
//: the placeholder -- so the tile says the data is there and that this file
//: chose not to paint it, rather than leaving a reader to guess which. Nothing
//: is lost by waiting, either: these are accumulating histograms, so whatever
//: arrives while they are held back is still in them when they come back.
//:
//: Taking a name out of this set puts its plot straight back, with no other
//: change anywhere.
const HELD_BACK = new Set([
  "baseline_by_channel",
  "noise_by_channel",
]);

//: How often to re-fetch a small histogram. These are accumulating histograms,
//: not a live trace: a shifter watches a shape settle over minutes, and asking
//: mhttpd -- the same process serving run control -- more often than this buys
//: nothing.
//:
//: Ten seconds rather than the two it used to be. Nothing here is a
//: measurement of the last instant: every one of these is a sum over every
//: event since the run started or since dqm::clear, so between one fetch and
//: the next the shape barely moves once there is anything in it. What the old
//: two seconds bought was a request every two seconds per tile through
//: whatever sits between the browser and mhttpd, which for anyone on a tunnel
//: is the part that is felt.
const REFRESH_MS = 10000;

//: Above this many bins, slow down (see refreshFor).
const BIG_HIST_CELLS = 8000;
//: Never slower than this, however large.
//:
//: Scaled with REFRESH_MS when that went from 2 s to 10 s, keeping the 7.5x
//: between them, because the cap is only a backstop and must not become the
//: rule. At the old 15 s it would have caught every histogram above 12000
//: bins, which is all of the per-channel ones: refreshFor would have returned
//: the cap almost every time it was asked and the flat cost-per-second it
//: exists to hold would have quietly stopped being true. The tests below pin
//: that property rather than any of these numbers, which is how this surfaced.
const MAX_REFRESH_MS = 75000;

/**
 * How often to refetch a histogram of this size.
 *
 * A per-channel colormap is 256 x 200 bins once the ATAR's channels are all
 * mapped: 51200 cells, about 208 kB on the wire, and 51200 rectangles for the
 * browser to paint. Three of those on one page at the small-histogram cadence
 * is 150000 cells on the common cadence, which the browser cannot keep up with --
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

/** What the cadence chip says, and what it explains on hover. */
function cadenceText(ms, cells) {
  const secs = Math.round(ms / 1000);
  const scaled = ms !== REFRESH_MS;
  return {
    text: `every ${secs} s`,
    // Two sentences or one, depending on whether this tile is on the common
    // cadence or has been slowed for its size. Both say the same thing first:
    // how often this tile updates. That is the question a shifter watching a
    // plot that has not moved is actually asking.
    title: scaled
      ? `${cells} bins: refetched less often than the ${REFRESH_MS / 1000} s `
        + `the smaller histograms here use, so the browser keeps up.`
      : `These are accumulating histograms rather than a live trace, so they `
        + `settle over minutes and asking more often buys nothing.`,
  };
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
        if (ms !== REFRESH_MS) updater.setInterval(ms);
        // Always, not only when the size scaled it. Said, not left to be
        // discovered: a tile that repaints every ten seconds with no
        // explanation reads as a stuck tile, and the first thing anyone does
        // about a stuck tile is reload the page. Showing it only on the slowed
        // tiles left the common cadence as the one nobody could look up --
        // which is the number most of these tiles are actually using.
        const said = cadenceText(ms, cells);
        cadence.textContent = said.text;
        cadence.title = said.title;
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

// ---------------------------------------------------------------------------
// One tile, with the plot deliberately not drawn
// ---------------------------------------------------------------------------

/**
 * The placeholder a held-back panel shows in place of its colormap.
 *
 * It fetches nothing -- not even to print an entry count. Asking for a 25600
 * bin histogram every few seconds to render one number would keep most of the
 * cost this placeholder exists to remove, and the number would be the least
 * useful thing on the tile.
 *
 * The sentence is about this page's own choice rather than about the analyzer,
 * because that is the true reason. It says the histogram is still being
 * accumulated, though, which is a claim about the analyzer -- so the box goes
 * to probeThisBox() and the probe footnote lands underneath saying whether
 * that client is answering and publishing this name. Checked, not asserted,
 * which is the whole reason the probe exists. A shifter who reads both learns
 * the thing that matters: the data is there, and it is this page that is not
 * drawing it.
 */
function heldBackPanel(name) {
  return function (ctx) {
    probeThisBox(blocked(ctx.body,
      `Held back rather than missing. The analyzer is still accumulating `
      + `${name} and this page is still asking for it; what is switched off is `
      + `drawing it. As a colormap it is one rectangle per bin repainted on `
      + `every fetch, which is what made this page lag. Remove this panel from `
      + `HELD_BACK in pages/js/dqm-hists.js to put the plot back.`,
      ctx.panel));
  };
}

Object.keys(PANELS).forEach(function (id) {
  const render = HELD_BACK.has(id) ? heldBackPanel : histPanel;
  DQMPage.register(id, render(PANELS[id]));
});

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, HELD_BACK, refreshFor, cadenceText, REFRESH_MS,
                    BIG_HIST_CELLS, MAX_REFRESH_MS };
}

})();
