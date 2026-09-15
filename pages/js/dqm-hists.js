//
// dqm-hists.js -- the analyzer-backed panels on Channels and Pulses.
//
// Six of the fifteen. Every one of them names a histogram the `sampic` plugin
// accumulates from AD00 (src/mdqm/dqm/sampic_plugin.py), fetched over binary
// RPC and drawn by mplot. The mechanism is entirely generic -- dqm-brpc.js
// knows nothing about which histograms exist -- so the only thing this file
// adds is the one page-shaped fact: which plot belongs in which tile.
//
// Two of the six draw when the page opens: occupancy and hits per event, both
// 1D and both a few hundred bins. The other four are colormaps and start off,
// each with a Show plot toggle in its own tile -- see TWO_D below, which
// carries the reasoning. Off is a real off: no fetch, no draw, no timer.
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
  pulse_persistence:    "sampic/persistence",
  amplitude_by_channel: "sampic/amplitude_by_channel",
};

//: Panel id -> the recent-value series the analyzer publishes for it.
//:
//: These two are not histograms and are fetched over dqm::series, not
//: dqm::histogram. They were colormaps of everything since the run started;
//: they are now the last N values on each channel, drawn as a scatter. The
//: argument for the change is in RecentByChannel in sampic_plugin.py and it is
//: about the question rather than the cost: "is this channel sitting where it
//: should" is about now, and a sum over the run both fails to answer it and
//: hides a channel that has walked inside a column carrying every value it
//: ever had.
//:
//: The cost is the happy part. A few thousand markers instead of 26316
//: rectangles is what lets these two draw on open while the remaining
//: colormaps stay behind their toggle.
//:
//: Not in /DQM/<page>/Histograms, deliberately: they are not histograms, the
//: analyzer does not list them in dqm::list, and probeAnalyzer would report
//: them as missing. seriesPanel says whether its own series arrived.
const SERIES = {
  baseline_by_channel: "sampic/baseline_by_channel",
  noise_by_channel:    "sampic/noise_by_channel",
};

//: The panels whose plot is a colormap. These are off when the page opens, and
//: each carries its own toggle.
//:
//: A colormap is one rectangle per bin. The three per-channel ones are
//: (256+2) x (100+2) = 26316 cells on the wire and persistence is 66 x 112 =
//: 7392, and mplot repaints every rectangle on every arrival. Measured
//: headless on the DAQ machine that is 1.5 ms a draw and costs nothing; on a
//: real desktop driving a real compositor, over a tunnel, it is reported as
//: making the page crawl. Both of those can be true -- headless Firefox
//: rasterises to an offscreen surface and never composites to a screen -- and
//: when the measurement and the person disagree about whether a page is
//: usable, the person is right.
//:
//: So the default is off rather than a cadence chosen on the strength of
//: numbers taken on the wrong machine. Off means off: nothing is fetched and
//: nothing is drawn until somebody asks, so a page of these costs what a page
//: of text costs. The toggle is per tile and per page load -- it deliberately
//: does not persist, because a remembered "on" would bring the slow page back
//: without saying why, which is the failure this is fixing.
//:
//: Not a permanent answer. What it buys is a page that is usable now and a
//: way to look at any one of these when it is wanted. The cost is worth
//: measuring properly on the machine that has the problem -- see the browser
//: probe in the runbook -- and the answer may well be that mplot's colormap
//: wants a canvas blit rather than a rectangle per bin.
//:
//: The 1D tiles are not in here and always draw: occupancy and hits per event
//: are a few hundred bins and have never been the problem.
//: Histogram -> the /DQM/Analyzer/Window key that caps it. The page offers an
//: Edit button straight to that path, which is the whole of "configurable by
//: the shifter": the analyzer re-reads /DQM/Analyzer every couple of seconds
//: and adopts a new cap without a restart and without resetting the plot.
const WINDOW_KEY = {
  "sampic/persistence": "persistence events",
  "sampic/amplitude_by_channel": "amplitude by channel events",
};

const TWO_D = new Set([
  "amplitude_by_channel",
  "pulse_persistence",
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

function histPanel(name, twoD) {
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
    // Written only for a rolling histogram, and by the same argument the
    // cadence chip is always written: a plot showing the last thousand events
    // and a plot showing the whole run look identical, and the difference
    // decides what a shifter concludes from it.
    const windowChip = el("span", { class: "dqm-chip", id: `${name}-window` }, "");
    const strip = el("div", { class: "dqm-strip" },
      chip("histogram", el("code", {}, name)),
      chip("entries", entries), cadence, windowChip);
    ctx.body.appendChild(strip);

    // The off state, built before the plot so it reads above it. Kept in the
    // DOM and hidden rather than removed: probeAnalyzer() footnotes it once,
    // after the first paint and never again, so a box that is taken out and
    // rebuilt on a toggle comes back without the one line saying whether the
    // analyzer is answering.
    const offBox = twoD ? probeThisBox(blocked(ctx.body,
      `Off by default. This is a colormap -- one rectangle per bin, and this `
      + `one has tens of thousands of them -- and repainting it is what made `
      + `this page crawl. While it is off nothing is fetched and nothing is `
      + `drawn, so the tile costs what a paragraph costs. Show plot draws it; `
      + `the toggle lasts until the page is reloaded.`,
      ctx.panel)) : null;

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const plotDiv = el("div", { class: "dqm-plot" });
    ctx.body.appendChild(note);
    ctx.body.appendChild(plotDiv);

    let graph = null;
    let drawn = false;
    let rolling = false;

    async function build() {
      // Titles come from dqm::metadata rather than being repeated here: the
      // plugin already names its axes, and a second copy in the page is a
      // second thing to update when a binning changes.
      const meta = await BRPC.json(client, "dqm::metadata", name);
      const axes = (meta && meta.axes) || [];
      rolling = !!(meta && meta.rolling);
      if (rolling) {
        // The path is the one a shifter edits, so it is offered rather than
        // described. dlgOdbEdit is what every other configurable value on
        // these pages uses.
        const path = `${DQM.CONFIG_ROOT}/Analyzer/Window/${WINDOW_KEY[name] || ""}`;
        windowChip.appendChild(el("span", {}, ""));
        // "Edit cap" and not "events": a button whose label is a word from the
        // sentence beside it reads as part of the sentence, which is how the
        // one knob on this page manages to be invisible.
        windowChip.appendChild(editButton(path, "Edit cap"));
      }
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
      if (rolling) {
        // dqm::metadata rather than the histogram payload, because the wire
        // format carries counts and an entry total and has nowhere to put a
        // window. One small JSON call on the tile's own cadence.
        const m = await BRPC.json(client, "dqm::metadata", name);
        if (m && m.rolling) {
          // The count that is actually in the plot, not the setting. They are
          // different by up to a factor of two by construction, and claiming
          // the setting would be claiming a number the plot does not have.
          windowChip.firstChild.textContent = `last ${m.window} of max ${m.cap} events `;
          windowChip.title = `A rolling plot: it holds the most recent events `
            + `rather than the whole run, and swaps half a window at a time, so `
            + `the count sits between half the cap and the cap. Edit the cap at `
            + `${DQM.CONFIG_ROOT}/Analyzer/Window.`;
        }
      }
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

    if (!twoD) {
      // Deferred for the same reason the Scope page defers: MPlotGraph reads
      // clientWidth in its constructor, and a div that has not been laid out
      // yet reports zero.
      setTimeout(function () { updater.start(); }, 0);
      return;
    }

    // A colormap: off until asked for. The button lives in the strip, beside
    // the chips, so it is in the same place on every one of these tiles and is
    // reachable in both states -- a control that only exists in the off state
    // is one you cannot find again once you have used it.
    const toggle = el("button", { class: "mbutton", id: `${name}-toggle` }, "");
    strip.appendChild(toggle);

    let on = false;
    function setOn(next) {
      on = next;
      toggle.textContent = on ? "Hide plot" : "Show plot";
      toggle.title = on
        ? `Stop drawing ${name}, and stop fetching it.`
        : `Draw ${name}. Nothing is being fetched for this tile until you do.`;
      // Display rather than removal, so the graph survives a hide and the
      // second Show is instant. plotDiv must be visible before the updater
      // runs: MPlotGraph reads clientWidth in its constructor and a hidden div
      // reports zero, which is the blank-plot failure this page has hit before.
      if (offBox) offBox.style.display = on ? "none" : "";
      note.style.display = on ? "" : "none";
      plotDiv.style.display = on ? "" : "none";
      if (on) updater.start();
      else updater.stop();
    }
    toggle.addEventListener("click", function () { setOn(!on); });
    setOn(false);
  };
}

// ---------------------------------------------------------------------------
// One recent-value series, as a scatter
// ---------------------------------------------------------------------------

/**
 * Baseline or noise: the last N values on each channel, channel against value.
 *
 * Always on, unlike the colormaps. depth x channels is a few thousand markers
 * at the default depth of 10, which is the size the tiles above are toggled
 * off to avoid.
 *
 * What a reader is looking for here is a column out of line with its
 * neighbours -- every channel saw the same beam, so a channel whose baseline
 * has walked stands proud of the row. The scatter shows the spread within a
 * channel at the same time, which is the difference between a channel that has
 * moved and one that is merely noisy, and which a single mean per channel
 * would have thrown away.
 */
function seriesPanel(name) {
  return function (ctx) {
    const client = String(ctx.cfg["Analyzer Client"] || "").trim();
    if (!client) {
      blocked(ctx.body,
        `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, so `
        + `this panel does not know whom to ask for ${name}.`,
        ctx.panel, `${DQM.CONFIG_ROOT}/Analyzer Client`);
      return;
    }

    const points = el("span", {}, "\u2014");
    const depth = el("span", {}, "\u2014");
    const oldest = el("span", { class: "dqm-chip" }, "");
    const strip = el("div", { class: "dqm-strip" },
      chip("series", el("code", {}, name)),
      chip("points", points), chip("per channel", depth), oldest);
    const note = el("div", { class: "dqm-note" }, "Asking the analyzer\u2026");
    const plotDiv = el("div", { class: "dqm-plot" });
    ctx.body.appendChild(strip);
    ctx.body.appendChild(note);
    ctx.body.appendChild(plotDiv);

    let graph = null;
    let drawn = false;

    function build(s) {
      graph = new MPlotGraph(plotDiv, {
        title: { text: s.title || name },
        stats: { show: false },
        legend: { show: false },
        // Off for the reason every plot on these pages has it off: mplot
        // cancels the wheel inside the axis window and the page cannot then be
        // scrolled past the tile.
        mouseWheelZoom: false,
        xAxis: { title: { text: "channel" } },
        yAxis: { title: { text: s.unit || "" } },
        plot: [{
          label: name,
          type: "scatter",
          // The whole point: markers and no line. A line through points
          // ordered by channel would draw a shape across channels that has no
          // meaning -- neighbouring channels are neighbouring *electronics*,
          // and until there is a channel map they are not even neighbouring
          // strips.
          line: { draw: false },
          marker: { draw: true, size: 2, style: "circle" },
        }],
      });
      plotDiv.mpg = graph;
      graph.resize();
    }

    async function tick() {
      const s = await BRPC.json(client, "dqm::series", name);
      if (!s || !s.channel) throw new Error(`empty reply for ${name}`);
      if (!graph) build(s);

      // xData/yData directly rather than through BRPC.display(), which is for
      // the binned wire format and would have nothing to do here.
      //
      // And then the four bounds by hand, which is the whole reason this is
      // more than two lines. mplot computes xMin/xMax/yMin/yMax in setData()
      // and its ODB path and nowhere else, so a plot whose data was assigned
      // directly has them undefined -- and draw() fills the background and
      // returns early on exactly that, leaving a uniformly white canvas with
      // no exception, graph.error still null and a clean console. The Scope
      // page has been caught by this before; see the same dance there.
      const plot = graph.param.plot[0];
      plot.xData = s.channel;
      plot.yData = s.value;

      // The x axis is every channel the analyzer knows about, not the range
      // the data happens to span. A channel nobody has hit is the thing this
      // tile exists to show, and it can only show it as a gap if the axis
      // holds still while channels come and go.
      plot.xMin = 0;
      plot.xMax = s.channels;

      let lo = 0, hi = 1;
      if (s.value.length) {
        lo = hi = s.value[0];
        // A loop rather than Math.min.apply: depth is an ODB setting, and
        // apply() on a long enough array throws rather than returning a wrong
        // answer, which would be a fine bug to hit at 3am on a raised depth.
        for (let i = 1; i < s.value.length; i++) {
          if (s.value[i] < lo) lo = s.value[i];
          if (s.value[i] > hi) hi = s.value[i];
        }
        // Padded so points do not sit on the frame, and never zero-height: a
        // channel set that is perfectly flat is a real and good outcome here,
        // and it must not collapse the axis onto itself.
        const pad = (hi - lo) * 0.05 || Math.abs(hi) * 0.01 || 0.01;
        lo -= pad;
        hi += pad;
      }
      plot.yMin = lo;
      plot.yMax = hi;

      // calcMinMax() turns the per-plot bounds into the graph-level ones that
      // drawYAxis() reads. Without it the axis has nothing to label.
      graph.calcMinMax();
      graph.redraw();

      drawn = true;
      points.textContent = String(s.channel.length);
      depth.textContent = String(s.depth);
      // The honest part. Channels are hit at very different rates, so the
      // oldest point on the plot can be far older than the newest, and a tile
      // that did not say so would be quietly claiming these are one moment.
      const maxAge = s.age && s.age.length ? Math.max.apply(null, s.age) : 0;
      oldest.textContent = `oldest ${Math.round(maxAge)} s`;
      oldest.title = `Every channel's last ${s.depth} values, so a channel that `
        + `is rarely hit carries older points than a busy one. This is the age `
        + `of the oldest point drawn.`;
      note.className = "dqm-note";
      note.textContent = s.channel.length
        ? ""
        : "The analyzer is answering and has recorded nothing on any channel "
          + "yet: either no events have arrived, or nothing is filling it.";
    }

    const updater = new BRPC.AutoUpdater(tick, REFRESH_MS);
    updater.onError = function (e) {
      note.className = "dqm-diagnosis red";
      note.textContent = drawn
        ? `"${client}" stopped answering for ${name} (${e.message}). The plot `
          + "above is the last one it sent, and is no longer being updated."
        : `Nothing answered as "${client}" for ${name} (${e.message}). That is `
          + "the analyzer this panel is waiting for.";
    };

    setTimeout(function () { updater.start(); }, 0);
  };
}

Object.keys(PANELS).forEach(function (id) {
  DQMPage.register(id, histPanel(PANELS[id], TWO_D.has(id)));
});

Object.keys(SERIES).forEach(function (id) {
  DQMPage.register(id, seriesPanel(SERIES[id]));
});

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, SERIES, TWO_D, refreshFor, cadenceText,
                    REFRESH_MS, BIG_HIST_CELLS, MAX_REFRESH_MS };
}

})();
