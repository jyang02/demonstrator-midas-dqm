//
// dqm-hists.js -- the analyzer-backed panels, on the Channels and Trends tabs.
//
// Six of them. Every one names a histogram or a series the `sampic` plugin
// accumulates from AD00 (src/mdqm/dqm/sampic_plugin.py), fetched over binary
// RPC and drawn by mplot. The mechanism is entirely generic -- dqm-brpc.js
// knows nothing about which histograms exist -- so the only thing this file
// adds is the one page-shaped fact: which plot belongs in which tile.
//
// Four of the six draw when their tab opens: occupancy and hits per event, both
// 1D and a few hundred bins, the noise scatter, and the baseline block -- which
// is not one plot but eight, one per ATAR layer, two columns by strip
// orientation and so four rows, laid out the way the waveforms on the Scope tab
// are. The other two are colormaps and start off, each with a Show plot toggle
// in its own tile -- see TWO_D below, which carries the reasoning. Off is a
// real off: no fetch, no draw, no timer.
//
// Nothing here knows which tab it is on, and it must not: a renderer claims a
// panel id, and where that panel sits is the spec's business. The Channels tab
// gets occupancy, hits per event, baseline, noise and the amplitude colormap;
// persistence is on Trends beside the average waveform that has been proposed
// to sit with it.
//
// What it does not claim is not an oversight. Crosstalk and the time-between-
// layers panel need a channel-to-layer map that exists nowhere, and the two
// energy panels need a calibration with an owner. Those keep the empty state
// and their own reason, which is the correct outcome and needs no code here.
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
//: The single source of this mapping. `/DQM/ATAR/Histograms` lists the same
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
//: These are not histograms and are fetched over dqm::series, not
//: dqm::histogram. They were colormaps of everything since the run started;
//: they are now the last N values on each channel. The argument for the change
//: is in RecentByChannel in sampic_plugin.py and it is about the question
//: rather than the cost: "is this channel sitting where it should" is about
//: now, and a sum over the run both fails to answer it and hides a channel
//: that has walked inside a column carrying every value it ever had.
//:
//: The cost is the happy part. A few thousand markers instead of 26316
//: rectangles is what lets these draw on open while the remaining colormaps
//: stay behind their toggle.
//:
//: Not in /DQM/ATAR/Histograms, deliberately: they are not histograms, the
//: analyzer does not list them in dqm::list, and probeAnalyzer would report
//: them as missing. Each renderer says whether its own series arrived.
//:
//: Baseline is not in here any more. It reads the same series and draws it
//: against time rather than against channel -- see BASELINE below -- because
//: "has this channel walked" is a question about the last minute and not about
//: the spread of a column. Noise keeps the scatter: what is asked of it is
//: which channel is louder than its neighbours, which is a comparison across
//: the channel axis and reads best with that axis on the plot.
const SERIES = {
  noise_by_channel:    "sampic/noise_by_channel",
};

//: The baseline series, drawn by baselineTrend() rather than seriesPanel().
const BASELINE = "sampic/baseline_by_channel";

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

// ---------------------------------------------------------------------------
// baseline_by_channel -- baseline against time, a line per channel, a panel
// per ATAR layer
// ---------------------------------------------------------------------------

//: The x span to draw before anything has arrived, in seconds.
//:
//: A plot whose only points are at t=0 has a zero-width x axis, and mplot
//: draws that as a blank frame. Sixty seconds is not a claim about the data --
//: it is the empty axis a shifter reads as "nothing yet" rather than as
//: "broken".
const BASELINE_EMPTY_SPAN_S = 60;

/**
 * Baseline against time: one line per channel, one panel per ATAR layer.
 *
 * Two changes from the scatter this used to be, and they are the same change.
 *
 * The **axis** is time, not channel. A baseline that has walked is a walk --
 * it has a direction and a moment it started -- and channel-against-value can
 * only ever show it as a column that has become taller, which is also what a
 * channel that got noisier looks like. Against time the two separate on sight:
 * a walk slopes and noise fattens. The series already carries the age of every
 * point, so this needs nothing from the analyzer that was not already on the
 * wire.
 *
 * The **panels** are the target. 256 lines on one plot is a mat, and the
 * question underneath "which channel has walked" is nearly always "is it one
 * channel or is it a layer" -- a bias that has sagged takes a whole layer with
 * it. So the layers are eight panels in the two-column block the waveforms on
 * the Scope tab use, which puts one strip orientation down each column and
 * makes the whole target four rows tall. A shifter comparing a baseline with
 * the waveform that produced it moves their eye between two grids of the same
 * shape.
 *
 * What it does not have is a legend: 32 lines per panel would be a key taller
 * than the plot. The colour carries the strip position instead, on the same
 * viridis ramp the waveforms use, so a line's place across its layer is
 * readable without one and a channel is the same colour in both views.
 *
 * The window is short and the tile says so. This is the analyzer's ring --
 * the last `depth` values on each channel, ten by default -- so the axis
 * reaches back as far as those go and no further, which on a quiet channel is
 * minutes and on a busy one is seconds. Trending a baseline across a whole run
 * is a different tile and wants MIDAS history, not this ring.
 */
function baselineTrend(name) {
  return function (ctx) {
    const client = String(ctx.cfg["Analyzer Client"] || "").trim();
    if (!client) {
      blocked(ctx.body,
        `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, so `
        + `this panel does not know whom to ask for ${name}.`,
        ctx.panel, `${DQM.CONFIG_ROOT}/Analyzer Client`);
      return;
    }

    const points = el("span", {}, "—");
    const depth = el("span", {}, "—");
    const oldest = el("span", { class: "dqm-chip" }, "");
    ctx.body.appendChild(el("div", { class: "dqm-strip" },
      chip("series", el("code", {}, name)),
      chip("points", points), chip("per channel", depth), oldest));

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const geoNote = el("div", { class: "dqm-note" }, "Reading the channel map…");
    ctx.body.appendChild(note);
    ctx.body.appendChild(geoNote);

    // The eight-panel block, and below it the panel for anything the map does
    // not place. That one is a real panel and not a silent drop: a channel on
    // this digitiser that is not an ATAR strip still has a baseline worth
    // watching. It is hidden until such a channel turns up -- and it is also
    // the only panel when there is no geometry at all.
    const host = el("div", { class: "dqm-layer-grid", id: "baseline-layer-panels" });
    const soloHead = el("div", { class: "dqm-subhead", id: "baseline-unmapped-head" },
      "Channels the map does not place");
    const solo = el("div", { class: "dqm-plot", id: "baseline-plot-all" });
    ctx.body.appendChild(host);
    ctx.body.appendChild(soloHead);
    ctx.body.appendChild(solo);
    // Both hidden until there is something to say: before the first reply the
    // page does not yet know whether there is any geometry, and an empty
    // "channels the map does not place" heading under a tile that has not
    // drawn is a fault report about nothing.
    soloHead.hidden = true;
    solo.hidden = true;

    let map = null;
    let panels = null;          // [{ layer, graph, div, used }]
    let byLayer = null;         // layer (or null) -> that entry
    let unit = "";
    let drawn = false;

    //: One graph, built the way every plot on these pages is: no wheel zoom,
    //: no stats box, and the axis titles set here because the data assignment
    //: below never goes through setData().
    function graphIn(div, title) {
      const g = new MPlotGraph(div, {
        title: { text: title },
        stats: { show: false },
        // See the docstring: 32 lines is a key taller than the plot, and the
        // colour ramp is what names the line instead.
        legend: { show: false },
        // Off for the reason every plot on these pages has it off: mplot
        // cancels the wheel inside the axis window and the page cannot then be
        // scrolled past the tile.
        mouseWheelZoom: false,
        xAxis: { title: { text: "seconds ago (0 = now)" } },
        yAxis: { title: { text: unit } },
        plot: [],
      });
      div.mpg = g;
      g.resize();
      return g;
    }

    function build() {
      panels = [];
      if (map) {
        const columns = ATARGeom.layerColumns(host, map, "baseline");
        map.layers.forEach(function (layer) {
          const orient = ATARGeom.orientationOf(map, layer);
          const div = el("div", { class: "dqm-plot", id: `baseline-plot-L${layer}` });
          const col = columns.get(layer % 2);
          col.appendChild(el("div", { class: "dqm-subhead" },
            orient ? `Layer ${layer} (${orient})` : `Layer ${layer}`));
          col.appendChild(div);
          panels.push({ layer: layer, graph: graphIn(div, ""), div: div, used: false });
        });
        geoNote.textContent = `One panel per ATAR layer, in two columns by strip `
          + `orientation, from ${map.source}. Lines are coloured by strip `
          + `position, on the ramp the waveforms on the Scope tab use, so a `
          + `channel is the same colour in both views.`;
      } else {
        // No geometry is not no plot. Every channel on one panel still answers
        // "has anything walked", and it says why it cannot answer "which
        // layer" rather than inventing one.
        // Yellow, not red: nothing is broken. The analyzer is answering and
        // the baselines are on the plot -- what is missing is the geometry to
        // sort them by, which is a caveat on the view and not a fault.
        geoNote.className = "dqm-diagnosis yellow";
        geoNote.textContent = `No ATAR geometry in ${ATARGeom.SETTINGS}, so this `
          + `is one panel with every channel on it rather than eight by layer. `
          + `The layer of a channel cannot be guessed: the pixel id decodes only `
          + `under the base and the stride it was made with.`;
      }
      // Last, and hidden while the map places everything -- but shown from the
      // start when it is the only panel there is, so the tile is not blank
      // while the first reply is in flight.
      if (!map) solo.hidden = false;
      panels.push({ layer: null, graph: graphIn(solo, ""), div: solo, used: false });
      byLayer = new Map(panels.map((p) => [p.layer, p]));
    }

    /**
     * The series as one polyline per channel, oldest point first.
     *
     * x is the *negative* age, so now is 0 at the right and the past runs off
     * to the left, which is the direction a trend is read in. points() already
     * emits each channel oldest-first, but this sorts anyway: relying on the
     * emission order of another process to keep a polyline from zigzagging is
     * a coupling that would break silently and look like noise.
     */
    function polylines(s) {
      const byChannel = new Map();
      for (let i = 0; i < s.channel.length; i++) {
        const ch = s.channel[i];
        let pts = byChannel.get(ch);
        if (!pts) { pts = []; byChannel.set(ch, pts); }
        pts.push([-(s.age[i] || 0), s.value[i]]);
      }
      byChannel.forEach(function (pts) { pts.sort((a, b) => a[0] - b[0]); });
      return byChannel;
    }

    async function tick() {
      const s = await BRPC.json(client, "dqm::series", name);
      if (!s || !s.channel) throw new Error(`empty reply for ${name}`);
      if (!panels) { unit = s.unit || ""; build(); }

      const lines = polylines(s);

      // Rebuilt rather than updated in place, for the reason the Scope page
      // gives: mplot's deletePlot splices findPlot()'s return with no check, so
      // removing a label that is not there deletes the wrong trace.
      panels.forEach(function (p) { p.graph.param.plot = []; p.used = false; });
      const fallback = byLayer.get(null);

      let xLo = 0, yLo = 0, yHi = 0, any = false;
      lines.forEach(function (pts, ch) {
        // Its layer's panel, or the unmapped one. Never dropped.
        const panel = byLayer.get(ATARGeom.layerOf(map, ch)) || fallback;
        const strip = ATARGeom.stripOf(map, ch);
        const colour = strip === null ? ATARGeom.colourFor(ch)
          : ATARGeom.stripColour(strip, map.stripLo, map.stripHi);
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        panel.graph.param.plot.push({
          label: strip === null ? `ch ${ch}` : `ch ${ch} (strip ${strip})`,
          type: "scatter",
          line: { draw: true, width: 1, color: colour },
          // Markers as well as the line, which the waveform traces do not do.
          // A channel that was hit once in the window is a single point, and
          // with a line alone it would be drawn as nothing at all -- a channel
          // silently missing from a plot that exists to show channels.
          //
          // lineColor/fillColor, not color: mplot's drawMarker() reads exactly
          // those two and silently ignores anything else, so a `color` here
          // draws every marker in the default dark and the strip encoding goes
          // missing with no error. And size is a diameter -- it draws
          // arc(x, y, size / 2) -- so 4 is the 2px dot this wants, small
          // enough not to swallow a ten-point line and large enough that a
          // channel hit once is still on the plot.
          marker: { draw: true, size: 4, style: "circle",
                    lineColor: colour, fillColor: colour },
          xData: xs, yData: ys,
        });
        panel.used = true;
        for (let i = 0; i < ys.length; i++) {
          if (!any) { yLo = yHi = ys[i]; any = true; }
          if (ys[i] < yLo) yLo = ys[i];
          if (ys[i] > yHi) yHi = ys[i];
          if (xs[i] < xLo) xLo = xs[i];
        }
      });

      // Padded so lines do not sit on the frame, and never zero-height: a set
      // of channels sitting at exactly one voltage is a real and good outcome,
      // and it must not collapse the axis onto itself.
      const pad = (yHi - yLo) * 0.05 || Math.abs(yHi) * 0.01 || 0.01;
      yLo -= pad;
      yHi += pad;
      if (!(xLo < 0)) xLo = -BASELINE_EMPTY_SPAN_S;

      // One x range and one y range across all eight, deliberately. Per-panel
      // autoscaling would give a layer sitting flat at 0.74 V the same picture
      // as one that has walked 40 mV, each filling its own frame, and the
      // comparison down the column -- which is the whole reason these are
      // eight panels of one plot rather than eight plots -- would be a
      // comparison of two different rulers.
      panels.forEach(function (p) {
        if (!p.used) {
          // A layer with nothing this cycle keeps its panel and its axes. An
          // empty panel in a block of eight says "nothing here"; a vanishing
          // one makes the layers renumber themselves between refreshes.
          p.graph.param.plot.push({
            label: p.layer === null ? "no unmapped channels"
                                    : `layer ${p.layer}: nothing yet`,
            type: "scatter",
            line: { draw: true, width: 1 }, marker: { draw: false },
            xData: [], yData: [],
          });
        }
        // Every plot, including the empty placeholder. mplot fills xMin/xMax/
        // yMin/yMax in setData() and its ODB path and nowhere else, and draw()
        // paints the background and returns the moment plot[0].xMin is
        // undefined -- a white panel, no axes, no exception and graph.error
        // still null. calcMinMax() then lifts these into the graph-level
        // bounds drawYAxis() reads.
        p.graph.param.plot.forEach(function (pl) {
          pl.xMin = xLo; pl.xMax = 0;
          pl.yMin = yLo; pl.yMax = yHi;
        });
        p.graph.calcMinMax();
        p.graph.redraw();
      });

      // The unmapped panel appears only when something needs it, and is the
      // only panel when there is no geometry at all.
      const showSolo = !map || fallback.used;
      solo.hidden = !showSolo;
      soloHead.hidden = !(showSolo && map);

      drawn = true;
      points.textContent = String(s.channel.length);
      depth.textContent = String(s.depth);
      // The honest part. Channels are hit at very different rates, so the
      // oldest point on the plot can be far older than the newest, and a tile
      // that did not say so would be quietly claiming these are one window.
      const maxAge = s.age && s.age.length ? Math.max.apply(null, s.age) : 0;
      oldest.textContent = `reaches back ${Math.round(maxAge)} s`;
      oldest.title = `Every channel's last ${s.depth} values, so a channel that `
        + `is rarely hit reaches further back than a busy one. This is the age `
        + `of the oldest point drawn, and the left-hand end of the axis.`;
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
        ? `"${client}" stopped answering for ${name} (${e.message}). The panels `
          + "above are the last ones it sent, and are no longer being updated."
        : `Nothing answered as "${client}" for ${name} (${e.message}). That is `
          + "the analyzer this panel is waiting for.";
    };

    // The map first, then the loop: build() needs to know whether there are
    // eight panels or one before the first reply arrives. A map that is not
    // there resolves to null and the loop starts just the same.
    ATARGeom.load().then(function (m) {
      map = m;
      updater.start();
    });
  };
}

Object.keys(PANELS).forEach(function (id) {
  DQMPage.register(id, histPanel(PANELS[id], TWO_D.has(id)));
});

Object.keys(SERIES).forEach(function (id) {
  DQMPage.register(id, seriesPanel(SERIES[id]));
});

DQMPage.register("baseline_by_channel", baselineTrend(BASELINE));

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, SERIES, BASELINE, TWO_D, refreshFor, cadenceText,
                    REFRESH_MS, BIG_HIST_CELLS, MAX_REFRESH_MS,
                    BASELINE_EMPTY_SPAN_S };
}

})();
