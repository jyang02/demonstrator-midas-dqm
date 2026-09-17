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
// 1D and a few hundred bins, and the two tiles that read a recent-value series
// -- the baseline block, which is not one plot but eight, one per ATAR layer in
// the two-column block the Scope tab's waveforms use, and the noise maps, which
// are three grids of one div per channel placed by strip and layer. Neither is
// drawn by mplot against the channel axis any more, and the reasons are
// different: see baselineTrend and noiseMaps. The other two are colormaps and
// start off, each with a Show plot toggle in its own tile -- see TWO_D below,
// which carries the reasoning. Off is a real off: no fetch, no draw, no timer.
//
// Nothing here knows which tab it is on, and it must not: a renderer claims a
// panel id, and where that panel sits is the spec's business. The Channels tab
// gets occupancy, hits per event, baseline, the noise maps and the amplitude
// colormap;
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

//: The recent-value series the noise tile draws, and the two numbers it reads
//: it with.
//:
//: Not a histogram: it is fetched over dqm::series rather than dqm::histogram,
//: and it is deliberately absent from /DQM/ATAR/Histograms -- the analyzer does
//: not list it in dqm::list, so probeAnalyzer would report it missing. The tile
//: says whether its own series arrived.
//:
//: Both tiles on the Channels tab now read this shape of series and neither
//: draws it against the channel axis any more. The baseline goes against time,
//: because a baseline that has walked is a walk; the noise goes against the
//: target, because "which strips are loud" is a question about where they are,
//: and the global channel number is a fact about cabling.
const NOISE = "sampic/noise_by_channel";

//: Beyond this many seconds a channel's freshest value is dimmed rather than
//: presented as now.
//:
//: Strictly less than the analyzer's horizon ("recent seconds per channel",
//: 120 s) or the state is unreachable and the dimming is dead code. 60 is also
//: the ruler BASELINE_WINDOW_S already set on this tab, and at the
//: demonstrator's rate a channel is hit every few seconds -- so a minute
//: without one is a quiet channel by any reading, which is the thing worth
//: marking without claiming it is a fault.
const NOISE_FRESH_S = 60;

//: How many interquartile ranges above the upper quartile a scale reaches
//: before it stops and starts marking cells instead.
//:
//: A scale fitted to the maximum is a scale one dead-loud channel owns: it
//: takes the top colour and the other 255 cells land in the bottom tenth of the
//: ramp, indistinguishable. So the top is cut -- but cut at a *fence*, not at a
//: percentile, and that distinction is the whole of this number.
//:
//: A percentile clip is exceeded by a fixed fraction of the population by
//: construction: clip at the 98th and 2% of cells carry the "off the scale"
//: mark on every run, healthy or not, so the mark means "top 2%" and tells a
//: reader nothing. Tukey's 1.5 x IQR above the upper quartile is a fence the
//: bulk of a well-behaved population sits entirely below, so on a normal run
//: nothing is marked and the scale simply spans the data -- and when one
//: channel really is far out, it alone is marked and the other 255 keep the
//: full ramp. The mark then means what it says.
const NOISE_FENCE = 1.5;

//: The baseline series, drawn by baselineTrend() against time.
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
// noise_by_channel -- the target as a map, three times over
// ---------------------------------------------------------------------------

//: How many channels each ranking names. Five for the reason BASELINE_OUTLIERS
//: is five: it fits under the maps without scrolling, and it is enough to show
//: a whole layer going together rather than one channel on its own.
const NOISE_RANK = 5;

//: Label every Nth strip along the bottom axis. A 2-digit number does not fit
//: in a cell, so most columns go unlabelled and the reader counts from the
//: nearest tick -- which is what an axis is.
const NOISE_LABEL_EVERY = 4;

/**
 * The middle of a sorted copy at the given fraction. Null on an empty list.
 *
 * A copy, for the reason median() takes one: the array handed in is the page's
 * own data and sorting it in place would reorder the thing being drawn.
 *
 * And a loop-free index rather than Math.min/max.apply, for the reason the old
 * scatter wrote down: apply() on a long enough array throws rather than
 * returning a wrong answer, and the point count here follows the event rate.
 */
function quantile(values, q) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const i = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))));
  return v[i];
}

/**
 * The top of a scale that one outlier must not be allowed to own.
 *
 * Tukey's upper fence. Returns null on an empty list, and may legitimately come
 * back at or below the maximum -- the caller decides whether that is a cut
 * worth making, because a fence above everything is not a clip at all.
 */
function fenceTop(values) {
  if (!values.length) return null;
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  return q3 + NOISE_FENCE * (q3 - q1);
}

/** The smallest and largest of a list, without apply(). Null on empty. */
function span(values) {
  if (!values.length) return null;
  let lo = values[0], hi = values[0];
  for (let i = 1; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return { lo: lo, hi: hi };
}

/**
 * One channel's window, reduced: how many values, their mean, and the freshest.
 *
 * The freshest is the point of *least age*, not the last element of the array.
 * The analyzer does emit oldest-first and says so, but this file already
 * decided once not to rely on another process's emission order -- see
 * polylines() -- and the suite scrambles a reply on purpose to keep that
 * honest. Taking the minimum costs nothing inside a pass that is happening
 * anyway.
 *
 * `diff` is null on a channel seen once, and that is a real distinction rather
 * than a missing number: with one value the mean *is* that value, so the
 * difference is zero by construction and says nothing about whether the
 * channel moved. The map marks those instead of painting them as "did not
 * move", which is the opposite reading.
 */
function reduceByChannel(s) {
  const by = new Map();
  for (let i = 0; i < s.channel.length; i++) {
    const ch = s.channel[i];
    const v = s.value[i];
    const age = (s.age && i < s.age.length) ? s.age[i] : 0;
    let r = by.get(ch);
    if (!r) {
      r = { ch: ch, n: 0, sum: 0, newest: v, age: age };
      by.set(ch, r);
    }
    r.n += 1;
    r.sum += v;
    if (age < r.age) { r.age = age; r.newest = v; }
  }
  by.forEach(function (r) {
    r.avg = r.sum / r.n;
    // Over all n including the freshest, so that what the Average map shows is
    // exactly what the Difference map subtracted. The cost is a 1/n damping --
    // a channel seen twice shows half the move it made -- and that is stated in
    // the key rather than corrected for, because the three maps subtracting
    // cell by cell is the property that makes a stack of three readable at all.
    r.diff = r.n > 1 ? r.newest - r.avg : null;
  });
  return by;
}

/**
 * Noise RMS as the target: the window average, the freshest value, and the move.
 *
 * The scatter this replaces put RMS against the *global channel* -- so two
 * columns side by side on the plot were two channels sharing a cable, not two
 * strips sharing a neighbourhood. Its own comment said as much, and said that
 * until there was a channel map they were "not even neighbouring strips". The
 * map exists now, so the tile can be drawn against the detector: a cell per
 * channel, placed where its strip actually sits in its layer.
 *
 * **Three maps, because one number cannot answer the question.** "Which strips
 * are noisy" and "has anything got noisier just now" are different questions
 * and a single picture answers whichever one the reader assumed. The average
 * over the window is the standing state, the freshest value on each channel is
 * where it is now, and the difference is what changed. Stacked rather than side
 * by side so a column is one strip read three ways, top to bottom.
 *
 * **The freshest is not one event.** A demonstrator event is ~35 hits of 256
 * channels, so a literal per-event map would be a seventh full and the
 * difference meaningful only there. What is drawn instead is each channel's
 * most recent value whenever it arrived -- denser, and the thing that actually
 * answers "has this gone loud" -- at the price of being a mosaic of the last
 * few seconds rather than a moment. The price is paid in public: every cell
 * carries its age, and one older than NOISE_FRESH_S is dimmed.
 *
 * **Divs and not an mplot colormap**, which is the one structural choice here.
 * A cell has three states no colour scale can carry -- no value in the window,
 * a freshest value that is stale, and a channel seen once whose difference is
 * zero by construction -- and a colormap paints all three as the bottom of the
 * ramp, which is exactly the reading they must not get. 768 divs is also
 * nothing next to the 26316 rectangles the colormaps here are toggled off to
 * avoid, and it sidesteps every mplot trap this file has paid for once already.
 */
function noiseMaps(name) {
  return function (ctx) {
    const client = String(ctx.cfg["Analyzer Client"] || "").trim();
    if (!client) {
      blocked(ctx.body,
        `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, so `
        + `this panel does not know whom to ask for ${name}.`,
        ctx.panel, `${DQM.CONFIG_ROOT}/Analyzer Client`);
      return;
    }

    const covered = el("span", {}, "—");
    const depth = el("span", {}, "—");
    const staleChip = el("span", { class: "dqm-chip" }, "");
    // Always written, and not only when it is unusual. The freshest map claims
    // to be "now", and the honest size of that claim is the refresh interval
    // plus the age of the point -- a reader comparing it against the average
    // is entitled to both halves.
    const cadence = el("span", { class: "dqm-chip" },
      `every ${Math.round(REFRESH_MS / 1000)} s`);
    cadence.title = `How often the maps are refetched. The freshest value on a `
      + `channel can therefore be up to this old before its own age is counted.`;
    ctx.body.appendChild(el("div", { class: "dqm-strip" },
      chip("series", el("code", {}, name)),
      chip("channels", covered), chip("window", depth), staleChip, cadence));

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const geoNote = el("div", { class: "dqm-note" }, "Reading the channel map…");
    ctx.body.appendChild(note);
    ctx.body.appendChild(geoNote);

    // Its own readout, deliberately not the module-level one baselineTrend
    // uses. That variable is module-level only because mplot resolves a tooltip
    // by eval()ing a name from its own scope, so baselineTip cannot be a
    // closure and needs a way back to the DOM. A div grid has no such
    // constraint: a mouseenter handler closes over its own element. Sharing it
    // would let whichever tile received its first reply first take the other's
    // hover line -- a race, not an ordering.
    const readout = el("div", { class: "dqm-readout", id: "noise-readout" },
      "Hover a cell to identify its channel.");
    ctx.body.appendChild(readout);

    const maps = el("div", { class: "dqm-heat-maps", id: "noise-maps" });
    ctx.body.appendChild(maps);

    const rankBox = el("div", { class: "dqm-outliers", id: "noise-outliers" });
    ctx.body.appendChild(rankBox);

    //: The three maps, in the order they are read. `kind` is what paint()
    //: switches on and what the tests name.
    const KINDS = [
      { kind: "avg", id: "noise-map-avg", head: "Average over the window" },
      { kind: "now", id: "noise-map-now", head: "Freshest value on each channel" },
      { kind: "diff", id: "noise-map-diff", head: "Freshest minus average" },
    ];

    let map = null;
    let unit = "";
    let drawn = false;
    //: kind -> { grid, byCh: Map(channel -> cell), legendHost }
    let built = null;

    /**
     * One map's grid, built once and then only repainted.
     *
     * Rebuilding 256 cells every ten seconds would throw away the cell the
     * pointer is on halfway through a hover, and allocate 768 nodes to redraw a
     * picture that mostly has not changed. So this runs on the first reply and
     * never again; tick() writes background, className and title in place.
     *
     * Rows come from map.layers and columns from the map's own strip window,
     * never from a literal 8 by 32. That is a fixture's geometry, and
     * dqm-atar-geom.js exists precisely to refuse it: a pixel id decodes only
     * under the base and stride it was made with, and assuming 48 where the
     * file used 46 moves a fifth of the channels while looking plausible.
     */
    function buildGrid(spec, nChannels, withAxis) {
      const box = el("div", {});
      box.appendChild(el("div", { class: "dqm-subhead" }, spec.head));
      const grid = el("div", { class: "dqm-heat", id: spec.id });
      const byCh = new Map();

      if (map) {
        const lo = map.stripLo, hi = map.stripHi;
        const cols = hi - lo + 1;
        grid.style.gridTemplateColumns =
          `max-content repeat(${cols}, minmax(0, 1fr))`;
        // Reverse the map once: the grid is walked by position and needs to ask
        // "which channel is here", where ATARGeom answers "where is this
        // channel".
        const atPos = new Map();
        map.byChannel.forEach(function (layer, ch) {
          atPos.set(`${layer}:${ATARGeom.stripOf(map, ch)}`, ch);
        });
        map.layers.forEach(function (layer) {
          const orient = ATARGeom.orientationOf(map, layer);
          grid.appendChild(el("div", { class: "dqm-heat-rowlab" },
            orient ? `L${layer} ${orient.slice(0, 4)}` : `L${layer}`));
          for (let strip = lo; strip <= hi; strip++) {
            const ch = atPos.get(`${layer}:${strip}`);
            if (ch === undefined) {
              // No channel at this position: the layer is not instrumented
              // here. Not the same as a channel with no data, and not painted
              // like one.
              const gap = el("div", { class: "dqm-heat-cell dqm-heat-empty" });
              gap.title = `No channel at layer ${layer}, strip ${strip}.`;
              grid.appendChild(gap);
              continue;
            }
            grid.appendChild(cellFor(ch, layer, strip, byCh));
          }
        });
        if (withAxis) appendAxis(grid, lo, hi);
      } else {
        // No geometry is not no map. Every channel in one ribbon still answers
        // "is anything louder than the rest"; what it cannot answer is "where",
        // and it says so rather than inventing a layer.
        grid.classList.add("dqm-heat-ribbon");
        grid.style.gridTemplateColumns =
          `max-content repeat(${nChannels}, minmax(0, 1fr))`;
        grid.appendChild(el("div", { class: "dqm-heat-rowlab" }, "all"));
        for (let ch = 0; ch < nChannels; ch++) {
          grid.appendChild(cellFor(ch, null, null, byCh));
        }
      }

      box.appendChild(grid);
      const legendHost = el("div", {});
      box.appendChild(legendHost);
      maps.appendChild(box);
      return { grid: grid, byCh: byCh, legendHost: legendHost };
    }

    /** One channel's cell, with its identity on it and its hover wired. */
    function cellFor(ch, layer, strip, byCh) {
      const cell = el("div", { class: "dqm-heat-cell dqm-heat-nodata" });
      // Assigned rather than set as a data- attribute: the node test's element
      // stub populates dataset only on direct assignment, and a channel read
      // back out of a display string would make the wording load-bearing.
      cell.dataset.ch = String(ch);
      if (layer !== null) cell.dataset.layer = String(layer);
      if (strip !== null) cell.dataset.strip = String(strip);
      // No event argument: the stub calls handlers with none, and a handler
      // reaching for ev.target would work in the browser and throw under test,
      // which is the worst asymmetry available.
      cell.addEventListener("mouseenter", function () {
        readout.textContent = cell.title || `ch ${ch}`;
      });
      byCh.set(ch, cell);
      return cell;
    }

    /** The strip axis, labelled every NOISE_LABEL_EVERY columns. */
    function appendAxis(grid, lo, hi) {
      grid.appendChild(el("div", { class: "dqm-heat-rowlab" }, "strip"));
      for (let strip = lo; strip <= hi; strip++) {
        grid.appendChild(el("div", { class: "dqm-heat-collab" },
          strip % NOISE_LABEL_EVERY === 0 ? String(strip) : ""));
      }
    }

    /** Where a channel is, in words, for a title and a readout. */
    function whereText(cell, ch) {
      if (!map) return "unmapped";
      const layer = cell.dataset.layer;
      if (layer === undefined) return "unmapped";
      return `layer ${layer}, strip ${cell.dataset.strip}`;
    }

    /**
     * Paint one cell, which is the whole of what a tick does to the grid.
     *
     * The three absent states are set as classes and never as a colour, so
     * that "no value in the window", "seen once" and "off the top of the
     * scale" cannot be mistaken for measurements at the bottom of a ramp.
     */
    function paint(cell, r, kind, seq, div, windowS) {
      const ch = cell.dataset.ch;
      const where = whereText(cell, ch);
      if (!r) {
        cell.className = "dqm-heat-cell dqm-heat-nodata";
        cell.style.background = "";
        // Never "dead", and never "zero". The analyzer evicts on the way out,
        // so a channel absent from the reply is one nobody hit inside the
        // window -- which a quiet beam produces exactly as readily as a fault,
        // and this tile cannot tell the two apart.
        cell.title = `ch ${ch} — ${where} — no value in the last `
          + `${Math.round(windowS)} s.`;
        return;
      }

      const common = `ch ${ch} — ${where} — avg ${r.avg.toFixed(4)} V `
        + `from ${r.n} value${r.n === 1 ? "" : "s"}, now ${r.newest.toFixed(4)} V `
        + `(${Math.round(r.age)} s ago)`;

      if (kind === "diff") {
        if (r.diff === null) {
          cell.className = "dqm-heat-cell dqm-heat-single";
          cell.style.background = "";
          cell.title = `${common} — seen once in the window, so there is no `
            + `average to compare it against.`;
          return;
        }
        const t = div.hi > 0 ? r.diff / div.hi : 0;
        const over = Math.abs(r.diff) > div.hi;
        cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "")
          + (r.age > NOISE_FRESH_S ? " dqm-heat-stale" : "");
        cell.style.background = ATARGeom.diffColour(t);
        cell.title = `${common} — Δ ${r.diff >= 0 ? "+" : ""}`
          + `${(r.diff * 1000).toFixed(2)} mV`;
        return;
      }

      const v = kind === "now" ? r.newest : r.avg;
      const t = seq.hi > seq.lo ? (v - seq.lo) / (seq.hi - seq.lo) : 0;
      const over = v > seq.hi;
      // Stale dims the freshest map only. On the average it would be saying
      // something the average does not claim: a mean over the window is not a
      // statement about now and does not go out of date the same way.
      const stale = kind === "now" && r.age > NOISE_FRESH_S;
      cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "")
        + (stale ? " dqm-heat-stale" : "");
      cell.style.background = ATARGeom.heatColour(t);
      cell.title = common;
    }

    /**
     * Name the channels a 19px cell cannot.
     *
     * The same gap fillOutliers() closes for the baselines, and the same
     * argument: a map answers "is something out of family, and where", and
     * stops one step short of "which channel" -- which is what the ODB, the
     * frontend and the cable map all speak, and what goes in the elog. A cell
     * carries no label at all, so a map needs this more than a plot does.
     *
     * Two rankings because there are two questions. Loudest answers "which
     * strips are noisy"; moved answers "has anything changed", and a channel
     * can be top of one and nowhere near the other -- which is the case worth
     * seeing. Both rank and neither judges: there is no threshold here, and on
     * a healthy run these are simply the least average five.
     */
    function fillRanks(rows, windowS) {
      rankBox.textContent = "";
      if (!rows.length) {
        rankBox.appendChild(el("div", { class: "dqm-note" },
          `No channel has been hit in the last ${Math.round(windowS)} s, so `
          + `there is nothing to rank.`));
        return;
      }

      function table(head, sorted, withDelta) {
        rankBox.appendChild(el("div", { class: "dqm-subhead" }, head));
        const t = el("table", { class: "dqm-table" });
        t.appendChild(el("tr", {},
          el("th", {}, "channel"), el("th", {}, "layer"), el("th", {}, "strip"),
          el("th", {}, "average"), el("th", {}, "now"),
          el("th", {}, "Δ")));
        sorted.slice(0, NOISE_RANK).forEach(function (r) {
          t.appendChild(el("tr", {},
            el("td", { class: "label" }, `ch ${r.ch}`),
            el("td", {}, r.layer === null ? "—" : String(r.layer)),
            el("td", {}, r.strip === null ? "—" : String(r.strip)),
            el("td", {}, `${r.avg.toFixed(4)} V`),
            el("td", {}, `${r.newest.toFixed(4)} V`),
            // Millivolts, for the reason the baseline table uses them: the
            // moves worth reading are single mV and four decimals of a volt is
            // a column of leading zeros to count.
            el("td", {}, r.diff === null ? "seen once"
              : `${r.diff >= 0 ? "+" : ""}${(r.diff * 1000).toFixed(2)} mV`)));
        });
        rankBox.appendChild(t);
      }

      const loudest = rows.slice().sort((a, b) => b.avg - a.avg);
      table(`Loudest over the last ${Math.round(windowS)} s`, loudest);

      const moved = rows.filter((r) => r.diff !== null)
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      if (moved.length) table("Moved most from their own average", moved);

      rankBox.appendChild(el("div", { class: "dqm-footnote" },
        `${NOISE_RANK} of ${rows.length} channels, ranked. A ranking, not a `
        + `verdict: there is no threshold here, and on a healthy run these are `
        + `simply the least average channels. Several rows sharing a layer is `
        + `the shape a whole layer going together makes.`));
    }

    async function tick() {
      const s = await BRPC.json(client, "dqm::series", name);
      if (!s || !s.channel) throw new Error(`empty reply for ${name}`);
      const windowS = Number(s.window_s) || 0;
      const nChannels = Number(s.channels) || 0;
      unit = s.unit || "RMS (V)";

      if (!built) {
        built = {};
        KINDS.forEach(function (spec, i) {
          built[spec.kind] = buildGrid(spec, nChannels, i === KINDS.length - 1);
        });
        geoNote.textContent = map
          ? `One cell per channel, placed by strip and layer from ${map.source}. `
            + `The three maps share a grid, so a column is one strip read three `
            + `ways.`
          : "";
        if (!map) {
          // Yellow, not red: nothing is broken. The analyzer is answering and
          // every channel is on the ribbon -- what is missing is the geometry
          // to place them by, which is a caveat on the view and not a fault.
          geoNote.className = "dqm-diagnosis yellow";
          geoNote.textContent = `No ATAR geometry in ${ATARGeom.SETTINGS}, so `
            + `these are one row of every channel rather than a map of the `
            + `target. The layer and strip of a channel cannot be guessed: the `
            + `pixel id decodes only under the base and the stride it was made `
            + `with.`;
        }
      }

      const by = reduceByChannel(s);

      // The sequential scale spans BOTH maps, because they are read against
      // each other: the same colour has to mean the same RMS in the average and
      // in the freshest, or the comparison the stack exists for is not
      // available.
      //
      // But the fence is taken from each population separately and the WIDER
      // one wins, which is not the same as fencing the pool. A mean over n
      // values is narrower than a single value by construction -- that is what
      // averaging is -- so the pooled quartiles sit inside the average's tight
      // bulk, and a fence drawn there is one the freshest values step straight
      // over. Measured on the live analyzer: 46 of 256 cells off the top of the
      // scale and 19 distinct colours left on the freshest map, against 151 on
      // the average. Covering both distributions is what a shared scale has to
      // mean. The average then occupies the lower part of the ramp and looks
      // more uniform than the freshest -- which is a true statement about the
      // data and not an artefact of the drawing.
      const avgVals = [];
      const nowVals = [];
      const seqVals = [];
      const diffVals = [];
      const rows = [];
      by.forEach(function (r) {
        avgVals.push(r.avg);
        nowVals.push(r.newest);
        seqVals.push(r.avg, r.newest);
        if (r.diff !== null) diffVals.push(Math.abs(r.diff));
        const cell = built.avg.byCh.get(r.ch);
        rows.push({
          ch: r.ch, n: r.n, avg: r.avg, newest: r.newest, diff: r.diff,
          layer: cell && cell.dataset.layer !== undefined
            ? Number(cell.dataset.layer) : null,
          strip: cell && cell.dataset.strip !== undefined
            ? Number(cell.dataset.strip) : null,
        });
      });

      // Cut only when the cut earns itself. A fence above the largest value is
      // not a clip, and pretending it was would mark cells that are simply the
      // top of a healthy spread.
      const full = span(seqVals);
      const fa = fenceTop(avgVals);
      const fn = fenceTop(nowVals);
      const fence = (fa === null) ? fn : (fn === null ? fa : Math.max(fa, fn));
      const seq = full
        ? { lo: full.lo,
            // >= lo, not > lo: a population sitting at one value has a zero
            // IQR and a fence exactly on it, which is still the right cut --
            // the widening below keeps the scale from collapsing.
            hi: (fence !== null && fence >= full.lo && fence < full.hi)
              ? fence : full.hi,
            clipped: false }
        : { lo: 0, hi: 1, clipped: false };
      seq.clipped = !!full && seq.hi < full.hi;
      // A perfectly flat channel set is a real and good outcome and must not
      // collapse the scale onto itself, which would divide by zero and paint
      // every cell the bottom of the ramp.
      if (!(seq.hi > seq.lo)) seq.hi = seq.lo + (Math.abs(seq.lo) * 0.01 || 1e-4);

      // The same fence on the absolute move, so the diverging scale stays
      // symmetric: one number used twice, and zero stays in the middle.
      const dFull = span(diffVals);
      const dFence = fenceTop(diffVals);
      const div = dFull
        ? { hi: (dFence !== null && dFence > 0 && dFence < dFull.hi)
              ? dFence : dFull.hi,
            clipped: false }
        : { hi: 0, clipped: false };
      div.clipped = !!dFull && div.hi < dFull.hi;
      if (!(div.hi > 0)) div.hi = 1e-4;

      // Reachable from the console and from the tests, the way a graph is hung
      // off its div. The two sequential maps carry the SAME object, which is
      // what "one scale" means when it is asserted rather than described.
      built.avg.grid.dqmScale = seq;
      built.now.grid.dqmScale = seq;
      built.diff.grid.dqmDiffScale = div;

      let stale = 0;
      KINDS.forEach(function (spec) {
        const b = built[spec.kind];
        b.byCh.forEach(function (cell, ch) {
          const r = by.get(ch) || null;
          if (spec.kind === "avg" && r && r.age > NOISE_FRESH_S) stale += 1;
          paint(cell, r, spec.kind, seq, div, windowS);
        });
      });

      built.avg.legendHost.textContent = "";
      built.now.legendHost.textContent = "";
      built.diff.legendHost.textContent = "";
      const seqNote = seq.clipped
        ? `The scale stops at ${NOISE_FENCE} x IQR above the upper quartile so `
          + `that one loud channel does not flatten the rest; the highest is `
          + `${full.hi.toFixed(4)} V. Cells past the end are outlined, so they `
          + `are not read as merely the maximum.`
        : "";
      built.now.legendHost.appendChild(
        ATARGeom.heatLegend(seq.lo, seq.hi, { label: unit, note: seqNote }));
      built.diff.legendHost.appendChild(ATARGeom.diffLegend(div.hi, {
        label: "change (V)",
        note: `Freshest minus the average of the same window, which includes `
          + `it: a channel seen n times therefore shows (1 - 1/n) of the move it `
          + `made, and one seen twice shows half. Kept that way so the three `
          + `maps subtract cell by cell. A channel seen once has no comparison `
          + `and is left blank.`
          + (div.clipped ? ` Outlined cells are past the end of this scale.` : ""),
      }));

      fillRanks(rows, windowS);

      drawn = true;
      covered.textContent = nChannels ? `${by.size} of ${nChannels}` : String(by.size);
      depth.textContent = `${Math.round(windowS)} s`;
      staleChip.textContent = stale
        ? `${stale} older than ${NOISE_FRESH_S} s`
        : `all within ${NOISE_FRESH_S} s`;
      // Yellow, not red, for the reason the baseline tile gives: a quiet
      // channel is a fact about the beam as often as it is a fault.
      staleChip.className = stale ? "dqm-chip yellow" : "dqm-chip";
      staleChip.title = stale
        ? `The freshest value on ${stale} channel${stale === 1 ? " is" : "s is"} `
          + `older than ${NOISE_FRESH_S} s, so ${stale === 1 ? "its cell is" : "those cells are"} `
          + `dimmed on the freshest map. That is a quiet channel, which this `
          + `tile cannot tell from a fault.`
        : `Every channel with a value has been hit inside ${NOISE_FRESH_S} s.`;
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
        ? `"${client}" stopped answering for ${name} (${e.message}). The maps `
          + "above are the last ones it sent, and are no longer being updated."
        : `Nothing answered as "${client}" for ${name} (${e.message}). That is `
          + "the analyzer this panel is waiting for.";
    };

    // The map first, then the loop: buildGrid() needs to know whether it is
    // drawing the target or a ribbon before the first reply arrives. A map that
    // is not there resolves to null and the loop starts just the same.
    ATARGeom.load().then(function (m) {
      map = m;
      updater.start();
    });
  };
}

// ---------------------------------------------------------------------------
// baseline_by_channel -- baseline against time, a line per channel, a panel
// per ATAR layer
// ---------------------------------------------------------------------------

//: How far back the baseline axis reaches, in seconds. Fixed, not fitted.
//:
//: Letting the axis grow to the oldest point in the ring made it a different
//: width on every refresh, and a wide one most of the time: channels are hit
//: at very different rates, so one quiet channel's tenth-oldest value dragged
//: the axis out past three minutes and squeezed everything that mattered into
//: the last centimetre. A fixed window is a ruler -- the same distance means
//: the same time on every panel and on every reload -- which is the whole
//: argument for one y range across the eight, applied to the other axis.
//:
//: It also fixes the empty case for free: a plot whose only points are at t=0
//: has a zero-width x axis and mplot draws it as a blank frame.
//:
//: The cost is stated rather than hidden. A channel whose last ten values are
//: all older than this has nothing on the plot, and `outside` below counts
//: those so the tile can say how many rather than letting them disappear.
const BASELINE_WINDOW_S = 60;

/**
 * What mplot prints beside the crosshair when a baseline point is hovered.
 *
 * On the global because that is the only place mplot will look: it builds the
 * label with eval(<the dataset.tooltip name> + "(this)"), so a function inside
 * this file's closure is unreachable however it is registered. The page set
 * already puts dqmTempCell there for the same class of reason.
 *
 * This is the answer to "the shifter can see an outlier but cannot name it".
 * The colour says roughly where across the layer a line sits and deliberately
 * no more -- viridis makes neighbouring strips look like neighbours, which is
 * the same property that makes strip 14 and strip 17 indistinguishable. What a
 * shifter has to act on is the global channel number, because that is what the
 * ODB, the frontend and the cable map all speak, and this puts it under the
 * pointer.
 *
 * Falls back to mplot's own x/y wording for a trace with no channel on it --
 * the placeholder a layer with nothing in it carries -- rather than printing
 * "ch undefined".
 */
function baselineTip(graph) {
  const plot = graph && graph.marker
    ? graph.param.plot[graph.marker.graphIndex] : null;
  const volts = `${graph.marker.y.toFixed(4)} V`;
  // Age is the negated x, back the way it went in.
  const age = `${Math.round(-graph.marker.x)} s ago`;
  if (!plot || plot.dqmChannel === undefined) {
    say(`${volts}, ${age}`);
    return `${volts}, ${age}`;
  }
  const where = plot.dqmLayer === null || plot.dqmLayer === undefined
    ? "unmapped"
    : `layer ${plot.dqmLayer}` + (plot.dqmStrip === null ? "" : `, strip ${plot.dqmStrip}`);

  // The full sentence goes to the readout line, which is ordinary DOM and
  // cannot be clipped by anything. The canvas label keeps only what has to be
  // under the pointer -- which channel, and what it reads.
  say(`ch ${plot.dqmChannel} — ${where} — ${volts}, ${age}`);
  return `ch ${plot.dqmChannel} · ${volts}`;
}

//: The readout line, set when the tile builds. One baseline tile per page, so
//: one of these; a second would need this keyed by graph.
let readoutEl = null;

/**
 * Put the full identification somewhere it cannot be cut off.
 *
 * mplot draws its hover label to the right of the cursor and, if that would
 * overflow the right edge, flips it to `sx - 10 - w` -- with no matching check
 * against the left edge. So a label wider than the plot is clipped wherever it
 * goes, and in a panel four to a row the plot is about 185px while the full
 * sentence is nearer 270. Reported as "hovering points on the left cuts the
 * label off", which is exactly that flip running off the other side.
 *
 * mplot is a stock MIDAS resource and is not ours to patch, so the fix is to
 * stop asking it to draw something that does not fit. This is called from the
 * tooltip function on every hover, so the line follows the pointer without a
 * second mouse handler.
 *
 * It keeps the last thing hovered rather than clearing, on purpose: reading a
 * channel number and then looking down at the ranking should not blank the
 * number you just went to get.
 */
function say(text) {
  if (readoutEl) readoutEl.textContent = text;
}
if (typeof window !== "undefined") window.dqmBaselineTip = baselineTip;

//: How many channels the outlier table names. Five fits under the block
//: without scrolling and is enough to show a whole layer beginning to sag as
//: several rows sharing a layer number.
const BASELINE_OUTLIERS = 5;

//: The middle value, on a copy: the caller's array is the plot's own data.
function median(values) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

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
 * The window is short and the tile says so. The axis is a fixed
 * BASELINE_WINDOW_S seconds and the analyzer keeps a little more than that, so
 * what is drawn is every value every channel has produced in the last minute
 * -- not a fixed number of values per channel, which used to mean the two ends
 * of one plot were showing windows differing by a factor of thirty. Trending a
 * baseline across a whole run is a different tile and wants MIDAS history.
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
    // Held rather than inlined: the hover text is written on the whole chip in
    // tick(), so that pointing at the word "drawn" explains it and not only
    // pointing at the number.
    const drawnChip = chip("drawn", depth);
    ctx.body.appendChild(el("div", { class: "dqm-strip" },
      chip("series", el("code", {}, name)),
      chip("points", points), drawnChip, oldest));

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const geoNote = el("div", { class: "dqm-note" }, "Reading the channel map…");
    ctx.body.appendChild(note);
    ctx.body.appendChild(geoNote);

    // The eight-panel block, and below it the panel for anything the map does
    // not place. That one is a real panel and not a silent drop: a channel on
    // this digitiser that is not an ATAR strip still has a baseline worth
    // watching. It is hidden until such a channel turns up -- and it is also
    // the only panel when there is no geometry at all.
    const host = el("div", { class: "dqm-layer-quad", id: "baseline-layer-panels" });
    const soloHead = el("div", { class: "dqm-subhead", id: "baseline-unmapped-head" },
      "Channels the map does not place");
    const solo = el("div", { class: "dqm-plot", id: "baseline-plot-all" });
    ctx.body.appendChild(host);
    ctx.body.appendChild(soloHead);
    ctx.body.appendChild(solo);

    // The outlier readout, under the block. See fillOutliers() for why it
    // ranks rather than judges.
    const outlierBox = el("div", { class: "dqm-outliers", id: "baseline-outliers" });
    ctx.body.appendChild(outlierBox);
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
      // mplot's own hover: mouseEvent() finds the nearest point within 10 px,
      // records which trace it belongs to in marker.graphIndex, and then builds
      // its label by eval()ing the function this dataset key names. So the
      // readout costs a function and an attribute rather than a mousemove
      // handler and a hit test of our own.
      //
      // It has to be reachable by name from mplot's scope, which means the
      // global -- the same reason this page set already hangs dqmTempCell
      // there. Assigned once, below, not per graph.
      div.dataset.tooltip = "dqmBaselineTip";
      g.resize();
      return g;
    }

    function build() {
      panels = [];
      if (map) {
        // The ramp's key above the block, because the colour is the only thing
        // naming a line: there is no legend on the panels and there cannot be
        // one at 32 lines apiece. Built by dqm-atar-geom.js from the same
        // stripLo/stripHi the lines are coloured with, so it cannot describe a
        // ramp the plot is not using.
        ctx.body.insertBefore(ATARGeom.stripLegend(map), host);
        readoutEl = el("div", { class: "dqm-readout", id: "baseline-readout" },
          "Hover a point to identify its channel.");
        ctx.body.insertBefore(readoutEl, host);
        // Straight into a four-column grid in layer order, so eight layers
        // fall into two rows of four. No grouping by strip orientation, unlike
        // the waveforms on Scope: which way a layer's strips run decides how a
        // *track* is read, and a baseline is a baseline whichever way the
        // strip lies. Grouping by something this tile does not ask about would
        // be a parity for the reader to decode before they could find layer 5.
        map.layers.forEach(function (layer) {
          const cell = el("div", { class: "dqm-layer-cell" });
          const div = el("div", { class: "dqm-plot", id: `baseline-plot-L${layer}` });
          cell.appendChild(el("div", { class: "dqm-subhead" }, `Layer ${layer}`));
          cell.appendChild(div);
          host.appendChild(cell);
          panels.push({ layer: layer, graph: graphIn(div, ""), div: div, used: false });
        });
        geoNote.textContent = `One panel per ATAR layer, from ${map.source}. `
          + `The axis is the last ${BASELINE_WINDOW_S} seconds on every panel, `
          + `and the ramp below is the one the waveforms on the Scope tab use, `
          + `so a channel is the same colour in both views.`;
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
        readoutEl = el("div", { class: "dqm-readout", id: "baseline-readout" },
          "Hover a point to identify its channel.");
        ctx.body.insertBefore(readoutEl, host);
      }
      // Last, and hidden while the map places everything -- but shown from the
      // start when it is the only panel there is, so the tile is not blank
      // while the first reply is in flight.
      if (!map) solo.hidden = false;
      panels.push({ layer: null, graph: graphIn(solo, ""), div: solo, used: false });
      byLayer = new Map(panels.map((p) => [p.layer, p]));
    }

    /**
     * Name the channels sitting furthest from the pack.
     *
     * The plot answers "is something out of family, and roughly where"; it
     * stops one step short of "which channel", because the only thing naming a
     * line is its colour and the ramp is deliberately smooth. This closes that
     * step without a mouse: the channels are named outright, so the answer
     * survives being read over a shoulder or pasted into the elog.
     *
     * **It ranks, it does not judge.** This page set refused to build
     * `channel_health` on the grounds that "dead, noisy or drifting" is a
     * verdict rather than a histogram, and that synthesising one would mean
     * inventing thresholds nobody has specified. That reasoning applies here
     * exactly: "the five furthest from the median, and by how much" is a fact
     * about this minute, where "channel 137 is bad" is a threshold no one has
     * set. So there is no colour, no alarm and no verdict -- a run where the
     * five furthest are all 2 mV out is a healthy run, and the table looks the
     * same as it does on a sick one. Reading it is the shifter's job.
     *
     * Ranked against the median of *every* channel rather than of its own
     * layer, with the layer in the table. A whole layer sagging then appears
     * as several rows sharing a layer number, which is the "one channel or one
     * layer" question the eight panels exist to ask, answered in the readout
     * as well as in the picture. Against a per-layer median that case would
     * cancel out and show nothing.
     *
     * The median, not the mean, on both axes of this: one channel stuck at 0 V
     * would drag a mean far enough to make every healthy channel look like an
     * outlier, which is the failure that matters most here.
     */
    function fillOutliers(rows, allValues) {
      outlierBox.textContent = "";
      const mid = median(allValues);
      if (mid === null || !rows.length) {
        outlierBox.appendChild(el("div", { class: "dqm-note" },
          `No channel has been hit in the last ${BASELINE_WINDOW_S} seconds, so `
          + `there is nothing to rank.`));
        return;
      }

      rows.forEach(function (r) { r.delta = r.v - mid; });
      rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const top = rows.slice(0, BASELINE_OUTLIERS);

      outlierBox.appendChild(el("div", { class: "dqm-subhead" },
        `Furthest from the median (${mid.toFixed(4)} V)`));

      const table = el("table", { class: "dqm-table" });
      table.appendChild(el("tr", {},
        el("th", {}, "channel"), el("th", {}, "layer"), el("th", {}, "strip"),
        el("th", {}, "baseline"), el("th", {}, "\u0394 from median")));
      top.forEach(function (r) {
        // Millivolts for the delta and volts for the value: the deltas worth
        // reading here are single mV, and four decimal places of a volt is a
        // column of leading zeros to count.
        const mv = r.delta * 1000;
        table.appendChild(el("tr", {},
          el("td", { class: "label" }, `ch ${r.ch}`),
          el("td", {}, r.layer === null || r.layer === undefined ? "\u2014" : String(r.layer)),
          el("td", {}, r.strip === null ? "\u2014" : String(r.strip)),
          el("td", {}, `${r.v.toFixed(4)} V`),
          el("td", {}, `${mv >= 0 ? "+" : ""}${mv.toFixed(1)} mV`)));
      });
      outlierBox.appendChild(table);
      outlierBox.appendChild(el("div", { class: "dqm-footnote" },
        `The ${top.length} channels of ${rows.length} sitting furthest from the `
        + `median of every channel, over the last ${BASELINE_WINDOW_S} seconds. `
        + `A ranking, not a verdict: there is no threshold here, and on a `
        + `healthy run these are simply the five least average channels. `
        + `Several rows sharing one layer is the shape a sagging layer makes.`));
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

      const xLo = -BASELINE_WINDOW_S;
      let yLo = 0, yHi = 0, any = false;
      //: Channels whose every point is older than the window, and so are drawn
      //: nowhere. Counted rather than dropped quietly.
      let outside = 0;
      //: One entry per channel that has a line, and every in-window value
      //: behind the median the ranking is against. Gathered in the same pass
      //: that builds the traces rather than in a second walk of the series.
      const ranked = [];
      const allValues = [];
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
          // The identity as fields, not only inside the label. The hover
          // readout below needs the channel back out of the trace it is
          // pointing at, and parsing it out of a display string would make the
          // wording of a label load-bearing.
          dqmChannel: ch, dqmStrip: strip, dqmLayer: panel.layer,
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
        // Only what the window can show. A channel that walked three minutes
        // ago is off the left of every panel, and letting it set the y range
        // would stretch all eight around a line nobody can see -- the axis
        // would say something had moved and the plot would show nothing that
        // had.
        const inWindow = [];
        for (let i = 0; i < ys.length; i++) {
          if (xs[i] < -BASELINE_WINDOW_S) continue;
          inWindow.push(ys[i]);
          if (!any) { yLo = yHi = ys[i]; any = true; }
          if (ys[i] < yLo) yLo = ys[i];
          if (ys[i] > yHi) yHi = ys[i];
        }
        if (!inWindow.length) {
          // Outside the window entirely: it has no line to be an outlier of,
          // and ranking it on values nobody can see would put a channel in the
          // table that is not in the picture.
          outside++;
        } else {
          // The channel's own median, so one glitched reading does not promote
          // a healthy channel into the table.
          ranked.push({ ch: ch, layer: panel.layer, strip: strip,
                        v: median(inWindow) });
          for (let i = 0; i < inWindow.length; i++) allValues.push(inWindow[i]);
        }
      });

      // Nothing inside the window at all: keep an axis rather than collapsing
      // it, so the panels read as "nothing recent" instead of as broken.
      if (!any) { yLo = 0; yHi = 1; }

      // Padded so lines do not sit on the frame, and never zero-height: a set
      // of channels sitting at exactly one voltage is a real and good outcome,
      // and it must not collapse the axis onto itself.
      const pad = (yHi - yLo) * 0.05 || Math.abs(yHi) * 0.01 || 0.01;
      yLo -= pad;
      yHi += pad;

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

      fillOutliers(ranked, allValues);

      // The unmapped panel appears only when something needs it, and is the
      // only panel when there is no geometry at all.
      const showSolo = !map || fallback.used;
      solo.hidden = !showSolo;
      soloHead.hidden = !(showSolo && map);

      drawn = true;
      points.textContent = String(s.channel.length);
      // What is on the axis, not what the analyzer holds: the two differ on
      // purpose -- the analyzer keeps headroom so a slow fetch never arrives to
      // find the left-hand end already evicted -- and the number worth reading
      // beside a plot is the one the plot is drawn to.
      depth.textContent = `${BASELINE_WINDOW_S} s`;
      drawnChip.title = `The axis. The analyzer keeps `
        + `${Math.round(s.window_s || 0)} s per channel, deliberately more, so `
        + `the drawn window is always fully covered.`;
      // The honest part, and the price of a fixed axis. Channels are hit at
      // very different rates, so a quiet one's last ten values can all predate
      // the window and it is then drawn nowhere at all. A tile that let those
      // channels simply go missing would be the opposite of what it is for.
      oldest.textContent = outside
        ? `${outside} channel${outside === 1 ? "" : "s"} older than the window`
        : `every channel within ${BASELINE_WINDOW_S} s`;
      // Yellow, not red: a quiet channel is a fact about the beam as often as
      // it is a fault, and this tile cannot tell which.
      oldest.className = outside ? "dqm-chip yellow" : "dqm-chip";
      oldest.title = outside
        ? `The axis is the last ${BASELINE_WINDOW_S} seconds. ${outside === 1
            ? "This channel has" : "These channels have"} not been hit inside `
          + `it, so they have no line on any panel. That is the plot being `
          + `honest about a quiet channel, not a channel that has gone.`
        : `The axis is the last ${BASELINE_WINDOW_S} seconds, and every channel `
          + `the analyzer knows about has been hit inside it.`;
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

DQMPage.register("noise_by_channel", noiseMaps(NOISE));
DQMPage.register("baseline_by_channel", baselineTrend(BASELINE));

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, NOISE, BASELINE, TWO_D, refreshFor, cadenceText,
                    REFRESH_MS, BIG_HIST_CELLS, MAX_REFRESH_MS,
                    BASELINE_WINDOW_S, NOISE_FRESH_S, NOISE_FENCE };
}

})();
