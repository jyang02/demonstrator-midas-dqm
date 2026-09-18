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
// -- baseline and noise, which are the same renderer twice. Each is three grids
// of one div per channel placed by strip and layer: a long average, a short one
// and the difference, over a pair of windows the ODB sets. Neither is drawn by
// mplot against the channel axis any more, and neither against time; see
// channelMaps for what that bought and what it cost. The other two are
// colormaps and start off, each with a Show plot toggle in its own tile -- see
// TWO_D below, which carries the reasoning. Off is a real off: no fetch, no
// draw, no timer.
//
// Nothing here knows which tab it is on, and it must not: a renderer claims a
// panel id, and where that panel sits is the spec's business -- which is why
// moving the amplitude colormap from Channels to Scope was an edit to the spec
// and not to this file.
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
  // Charge, not energy. The panel keeps the id the spec and the wishlist cite;
  // the quantity is the honest one, because the volts-to-MeV calibration that
  // would make it an energy does not exist and has no owner.
  energy_vs_amplitude:  "sampic/charge_vs_amplitude",
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

//: The baseline series, drawn by channelMaps() as the target.
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
  "energy_vs_amplitude",
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
      `Off by default -- a colormap of tens of thousands of rectangles. `
      + `Show plot draws it, until the page is reloaded.`,
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
// atar_occupancy -- hits per channel, as the target
// ---------------------------------------------------------------------------

/**
 * Occupancy as a map: one cell per channel, placed by strip and layer.
 *
 * The question on this tile is "is the beam hitting the target where we put
 * it", and a bar chart against the global channel cannot answer it at all.
 * That axis is the readout order -- fe_board * 64 + channel -- so a beam spot
 * sitting in one corner of the target arrives as four disconnected clumps of
 * bars, and "where" has to be reconstructed in the reader's head from a cable
 * map. On the grid it is a spot, and whether it is the spot anybody intended
 * is one look.
 *
 * Read against the noise maps below it, which is why it is the same grid: a
 * strip that is dark here and loud there is a different fault from one that is
 * dark in both.
 *
 * **The scale starts at zero, not at the quietest channel.** Counts are a
 * ratio quantity -- half the hits means half the hits -- and a scale fitted to
 * the minimum would put the quietest channel at the bottom of the ramp whether
 * it had taken nine hundred hits or none, which is the one distinction this
 * tile exists to make. Zero itself gets its own mark rather than the ramp's
 * darkest colour, because "never hit" and "hardly hit" are a dead channel and
 * a live one.
 */
function occupancyMap(name) {
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
    const live = el("span", {}, "—");
    const cadence = el("span", { class: "dqm-chip" }, "");
    ctx.body.appendChild(el("div", { class: "dqm-strip" },
      chip("histogram", el("code", {}, name)),
      chip("entries", entries), chip("channels hit", live), cadence));

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const geoNote = el("div", { class: "dqm-note" }, "Reading the channel map…");
    ctx.body.appendChild(note);
    ctx.body.appendChild(geoNote);

    const readout = el("div", { class: "dqm-readout", id: "occupancy-readout" },
      "Hover a cell to identify its channel.");
    ctx.body.appendChild(readout);

    const keyHost = el("div", {});
    const mapHost = el("div", { class: "dqm-heat-maps", id: "occupancy-map" });
    ctx.body.appendChild(keyHost);
    ctx.body.appendChild(mapHost);

    const rankBox = el("div", { class: "dqm-outliers", id: "occupancy-outliers" });
    ctx.body.appendChild(rankBox);

    let map = null;
    let built = null;
    let drawn = false;
    let sized = false;

    async function tick() {
      const hist = await BRPC.histogram(client, name);
      // One bin per channel exactly -- the analyzer's `chan()` axis is lo=0,
      // hi=nch -- so bin i is channel i. data carries under- and overflow at
      // the ends, hence the offset; neither can hold anything here, because a
      // channel index outside the axis is a channel that does not exist.
      const nch = (hist.nBins && hist.nBins[0]) || 0;
      const counts = [];
      for (let i = 0; i < nch; i++) counts.push(Number(hist.data[i + 1]) || 0);

      if (!built) {
        built = ATARGeom.heatGrid(map, {
          id: "occupancy-grid", channels: nch, axis: true,
          onHover: function (chs, cell) {
            readout.textContent = cell.title || ATARGeom.chLabel(chs);
          },
        });
        mapHost.appendChild(built.grid);
        geoNote.textContent = "";
        geoNote.title = map
          ? `Channel map from ${map.source}. The same grid the noise maps use.`
          : "";
        geoNote.hidden = !!map;
        if (!map) {
          // Yellow, not red: the analyzer is answering and every channel is on
          // the ribbon. What is missing is the geometry to place them by, which
          // is a caveat on the view rather than a fault.
          geoNote.className = "dqm-diagnosis yellow";
          geoNote.textContent = `No ATAR geometry in ${ATARGeom.SETTINGS}: `
            + `one row of every channel, not a map.`;
          geoNote.title = `Without it this cannot answer where the beam is `
            + `landing, only how much each channel took. The layer and strip `
            + `of a channel cannot be guessed: a pixel id decodes only under `
            + `the base and the stride it was made with.`;
        }
      }

      if (!sized) {
        sized = true;
        const said = cadenceText(refreshFor(counts.length), counts.length);
        cadence.textContent = said.text;
        cadence.title = said.title;
      }

      // One row per POSITION, not per channel. Under ping-pong a strip is two
      // channels and a deposit lands on whichever was not used last, so the
      // strip's occupancy is the sum over its channels -- and the sum is what
      // this tile's question wants, because "where is the beam landing" is
      // answered by the strip and not by which half of a pair happened to take
      // a given hit. Splitting the two across two maps would make a reader add
      // them back up by eye, off two scales fitted separately.
      const total = Number(hist.entries) || 0;
      const rows = [];
      built.byPos.forEach(function (pos) {
        const per = pos.channels.map((ch) => counts[ch] || 0);
        let v = 0;
        per.forEach(function (c) { v += c; });
        rows.push({
          chs: pos.channels, per: per, v: v, cell: pos.cell,
          layer: pos.layer, strip: pos.strip,
        });
      });

      // Zero at the bottom, always. See the docstring: counts are a ratio
      // quantity and a scale fitted to the minimum would hide the difference
      // between a channel that took none and one that took nine hundred.
      //
      // Fitted to what is drawn -- the per-position sums -- and not to the raw
      // per-channel counts. A scale taken from the channels while the cells
      // show pairs would be low by a factor of two under ping-pong, and every
      // cell in the beam spot would sit past the top of its own ramp.
      const values = rows.map((r) => r.v);
      const withHits = counts.filter((c) => c > 0);
      const top = span(values) || { lo: 0, hi: 0 };
      const fence = fenceTop(values);
      const hi = (fence !== null && fence > 0 && fence < top.hi) ? fence : top.hi;
      const scale = { lo: 0, hi: hi > 0 ? hi : 1, clipped: hi < top.hi };
      built.grid.dqmScale = scale;

      rows.forEach(function (r) {
        const cell = r.cell;
        const v = r.v;
        const where = ATARGeom.whereText(map, cell);
        const who = ATARGeom.chLabel(r.chs);
        // How the pair divided, which is the number that says whether the
        // ping-pong alternation is working. Only when there IS a pair: on a
        // one-channel strip it would be the same number twice.
        const split = r.chs.length > 1
          ? ` — split ${r.per.join("/")} across ${r.chs.join(", ")}` : "";
        const share = total ? ` (${(100 * v / total).toFixed(2)}% of all hits)` : "";
        if (v === 0) {
          cell.className = "dqm-heat-cell dqm-heat-zero";
          cell.style.background = "";
          // "No hits", never "dead". A channel outside the beam spot takes
          // none either, and this tile shows which of those two it is by where
          // the cell sits -- not by anything it could say in a sentence.
          cell.title = `${who} — ${where} — no hits this run.`;
          return;
        }
        const over = v > scale.hi;
        cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "");
        cell.style.background = ATARGeom.heatColour(v / scale.hi);
        cell.title = `${who} — ${where} — ${v} hit${v === 1 ? "" : "s"}${share}`
          + split;
      });

      keyHost.textContent = "";
      keyHost.appendChild(ATARGeom.heatLegend(0, scale.hi, {
        id: "occupancy-key",
        label: "hits",
        note: "zero anchored" + (scale.clipped ? ", top clipped" : ""),
        detail: `The scale starts at zero rather than at the quietest channel, `
          + `so a pale cell really is a busy channel and not merely the busiest `
          + `of a quiet set. A channel with no hits at all is left blank rather `
          + `than drawn at the bottom of the ramp.`
          + (scale.clipped
            ? ` The top stops at ${NOISE_FENCE} x IQR above the upper quartile `
              + `so one hot channel does not flatten the rest; the highest is `
              + `${top.hi}, and cells past the end are outlined.`
            : ""),
        decimals: 0,
      }));

      fillRanks(rows, withHits.length, counts.length);

      drawn = true;
      entries.textContent = String(total);
      live.textContent = `${withHits.length} of ${counts.length}`;
      note.className = "dqm-note";
      note.textContent = total
        ? ""
        : "The analyzer is answering and has recorded no hits yet: either no "
          + "events have arrived, or nothing is filling it.";
    }

    /**
     * Both ends of the map, named: the quietest channels and the busiest.
     *
     * A cell carries no label, and the channel number is what the ODB, the
     * frontend, the cable map and the elog all speak. So the map stops one
     * step short of the thing a shifter has to type, and these two tables are
     * that step -- which is why they are worth the width even where the map is
     * already legible.
     *
     * The two ends fail differently, and that is the argument for showing them
     * together rather than picking one. The quiet end is a field of dark cells
     * in which the channel that took nothing looks like its neighbours that
     * took three, so nothing but a ranking finds it. The busy end is obvious
     * as a shape -- a beam spot is bright, and its middle is where you expect
     * -- but "which channel is at the top and by how much" is not something a
     * colour ramp answers, least of all when the scale is clipped and several
     * cells are drawn at the fence. Side by side they also read as one
     * distribution: five and five out of the same set, so how far apart the
     * hits columns are is the spread of the run.
     *
     * Neither ranks a verdict, for the reason the noise ranking does not: a
     * channel outside the beam spot is quiet because the beam is not there,
     * and a channel at the top is busy because the beam is on it, both of
     * which are facts about the run rather than about the channel. No
     * threshold here could tell those from a fault. Where the cell sits on the
     * map is what settles it, and that is the reader's to read.
     */
    function fillRanks(rows, hit, all) {
      rankBox.textContent = "";
      if (!rows.length) return;

      // What a row is, which under ping-pong is a strip and otherwise a
      // channel. The tables rank whatever the map draws, so the heading has to
      // follow the cell rather than assert one or the other.
      const paired = built.paired;
      const what = paired ? "strips" : "channels";

      // One flex row of two columns rather than two stacked tables: they have
      // the same columns and are five rows each, so side by side they compare
      // in one look and cost no scrolling. The noise tile stacks its two
      // because they answer different questions with different columns.
      const pair = el("div", { class: "dqm-rank-row" });

      function column(head, sorted) {
        const box = el("div", { class: "dqm-rank-col" });
        box.appendChild(el("div", { class: "dqm-subhead" }, head));
        const t = el("table", { class: "dqm-table" });
        t.appendChild(el("tr", {},
          el("th", {}, "channel"), el("th", {}, "layer"), el("th", {}, "strip"),
          el("th", {}, "hits")));
        sorted.forEach(function (r) {
          t.appendChild(el("tr", {},
            el("td", { class: "label" }, ATARGeom.chLabel(r.chs)),
            el("td", {}, r.layer === null ? "—" : String(r.layer)),
            el("td", {}, r.strip === null ? "—" : String(r.strip)),
            el("td", {}, String(r.v))));
        });
        box.appendChild(t);
        return box;
      }

      // Sorted copies, not the caller's array: `rows` is what the map was just
      // drawn from and is read again on the next tick.
      const quiet = rows.slice().sort((a, b) => a.v - b.v).slice(0, MAP_RANK);
      const busy = rows.slice().sort((a, b) => b.v - a.v).slice(0, MAP_RANK);
      pair.appendChild(column(`Quietest ${what}`, quiet));
      pair.appendChild(column(`Busiest ${what}`, busy));
      rankBox.appendChild(pair);

      // Measured rather than asserted, and worth measuring: the two ends meet
      // whenever fewer than ten channels carry distinct counts, which a bench
      // setup does by having ten channels and a flat run does by having them
      // all on the same number. Then the tie-break decides the rows and the
      // tie-break is document order, which means nothing. The footnote says so
      // rather than letting five arbitrary channels read as a finding.
      const shared = quiet.filter((r) => busy.indexOf(r) >= 0).length;
      const dead = rows.filter((r) => r.v === 0).length;
      const foot = el("div", { class: "dqm-footnote" },
        `${quiet.length} at each end of ${rows.length} ${what}, ${dead} took `
        + `nothing at all \u2014 a ranking, not a verdict`);
      foot.title = `A ${paired ? "strip" : "channel"} outside the beam spot is `
        + `quiet because the beam is not there, and one at the top is busy `
        + `because it is; where a cell sits on the map above is what tells `
        + `either from one that has gone.`
        + (paired
          ? ` Of ${all} readout channels, ${hit} took at least one hit; a strip `
            + `is two of them under ping-pong, so a strip with hits can still `
            + `have a dead half, which is what the table below finds.`
          : "")
        + (shared
          ? ` ${shared} of these rows appear in both tables: too few ${what} `
            + `carry distinct counts for the two ends to be different ${what}, `
            + `so which ones are listed is the order they are stored in and not `
            + `a measurement.`
          : "");
      rankBox.appendChild(foot);

      // After that footnote, which belongs to the two tables above it and says
      // "the table below" about this one.
      if (paired) fillUneven(rows);
    }

    /**
     * The pairs whose two channels did not share the hits evenly.
     *
     * Ping-pong sends a strip's deposit to whichever of its two channels was
     * not used last, so over a run the split is even by construction. A pair
     * that is not even is a fault in that alternation -- one channel stuck
     * busy, or one that stopped taking data while its partner covered for it,
     * which is the failure this whole mode makes possible and which no map of
     * the strip can show: the sum is right while the halves are not.
     *
     * Ranked by |a - b| / sqrt(a + b) and not by the raw fraction, which is
     * the one decision here worth defending. An even split is a binomial at
     * p = 0.5, so sqrt(a + b) is the spread it should have and this is how
     * many of those a pair sits from even. The raw fraction makes a strip that
     * took three hits, two on one channel, look worse than a strip that took
     * eight hundred split 440/360 -- the first is what an even split does all
     * the time and the second is a real imbalance. Dividing by the expected
     * spread is what tells them apart, and it needs no threshold to do it:
     * a quiet pair cannot climb this table, which is what a cut on the count
     * would have been for.
     */
    function fillUneven(rows) {
      const pairs = rows.filter((r) => r.chs.length > 1 && r.v > 0);
      if (!pairs.length) return;
      pairs.forEach(function (r) {
        let lo = r.per[0], hi = r.per[0];
        r.per.forEach(function (c) { if (c < lo) lo = c; if (c > hi) hi = c; });
        r.gap = hi - lo;
        r.z = r.gap / Math.sqrt(r.v);
      });
      // Only the pairs a perfect alternation could not have produced. See
      // UNEVEN_MIN_GAP: 0 and 1 are what the mode does when it is working, so
      // a run with nothing above that has no table rather than a table of
      // zeroes.
      const sorted = pairs.filter((r) => r.gap > UNEVEN_MIN_GAP)
        .sort((a, b) => b.z - a.z);
      if (!sorted.length) return;

      rankBox.appendChild(el("div", { class: "dqm-subhead" }, "Most uneven pairs"));
      const t = el("table", { class: "dqm-table" });
      t.appendChild(el("tr", {},
        el("th", {}, "channels"), el("th", {}, "layer"), el("th", {}, "strip"),
        el("th", {}, "split"), el("th", {}, "hits"), el("th", {}, "σ from even")));
      sorted.slice(0, MAP_RANK).forEach(function (r) {
        t.appendChild(el("tr", {},
          el("td", { class: "label" }, ATARGeom.chLabel(r.chs)),
          el("td", {}, r.layer === null ? "—" : String(r.layer)),
          el("td", {}, r.strip === null ? "—" : String(r.strip)),
          el("td", {}, r.per.join(" / ")),
          el("td", {}, String(r.v)),
          el("td", {}, r.z.toFixed(1))));
      });
      rankBox.appendChild(t);

      const even = pairs.length - sorted.length;
      const foot = el("div", { class: "dqm-footnote" },
        `${Math.min(MAP_RANK, sorted.length)} of ${sorted.length} pairs `
        + `splitting by more than ${UNEVEN_MIN_GAP}, worst `
        + `${sorted[0].z.toFixed(1)}\u03c3`
        + (even ? `; ${even} within ${UNEVEN_MIN_GAP} and not listed` : "")
        + ` \u2014 a ranking, not a verdict`);
      foot.title = `Pairs splitting by ${UNEVEN_MIN_GAP} or less are left out: `
        + `perfect alternation puts |a-b| at 0, or at 1 when the pair has taken `
        + `an odd number of hits, so that is the healthy state and not a `
        + `finding. With none above it this table does not appear.\n\n`
        + `Ping-pong puts a strip's deposit on whichever of its two `
        + `channels was not used last, so the split is even by construction and `
        + `a pair that is not even is a fault in that alternation -- which the `
        + `map above cannot show, because the strip's total is right while its `
        + `halves are not. Ranked by |a-b| / sqrt(a+b), the number of standard `
        + `deviations an even split would have: a pair with few hits cannot `
        + `climb this table on noise alone, which is what a cut on the count `
        + `would otherwise be for. A couple of sigma is ordinary on a long run.`;
      rankBox.appendChild(foot);
    }

    const updater = new BRPC.AutoUpdater(tick, REFRESH_MS);
    updater.onError = function (e) {
      note.className = "dqm-diagnosis red";
      note.textContent = drawn
        ? `"${client}" stopped answering for ${name} (${e.message}). The map `
          + "above is the last one it sent, and is no longer being updated."
        : `Nothing answered as "${client}" for ${name} (${e.message}). That is `
          + "the analyzer this panel is waiting for.";
    };

    // The map first, then the loop, for the reason the noise tile does it:
    // heatGrid needs to know whether it is drawing the target or a ribbon
    // before the first reply arrives.
    ATARGeom.load().then(function (m) {
      map = m;
      updater.start();
    });
  };
}

// ---------------------------------------------------------------------------
// noise_by_channel and baseline_by_channel -- the target as a map, three times
// over, from one renderer
// ---------------------------------------------------------------------------

//: How many channels a map's ranking names. Five: it fits under a map without
//: scrolling, and it is enough to show a whole layer going together rather than
//: one channel on its own. Shared by all three maps on the Channels tab, which
//: ask the same thing of it -- a cell carries no label, so a map stops one step
//: short of naming what a shifter has to act on.
const MAP_RANK = 5;

//: The smallest split a pair has to show before it is worth a row.
//:
//: Perfect alternation can only ever put |a - b| at 0 or 1 -- 1 exactly when
//: the pair has taken an odd number of hits, so one channel keeps the spare.
//: A difference of 1 is therefore the largest the mode can produce by
//: construction, and everything at or under it is the healthy state rather
//: than a finding. With no pair above it the table does not appear at all: a
//: ranking of differences that are all zero is five rows saying nothing, and
//: the tile is already telling that story by being absent.
const UNEVEN_MIN_GAP = 1;

/**
 * The middle of a sorted copy at the given fraction. Null on an empty list.
 *
 * A copy, not in place: the array handed in is the page's own data, and sorting
 * it would reorder the thing being drawn.
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

/**
 * A configured number, or the built-in default when the ODB says nothing usable.
 *
 * A window of zero, a negative one or a key somebody blanked would each divide
 * the maps into nothing, and a page that draws an empty tile because an ODB
 * edit went wrong is the failure this page set exists to avoid. Falling back is
 * silent on purpose: the chips print what was actually used, so a value that
 * did not take is visible where a reader is already looking.
 */
function positiveOr(value, fallback) {
  const n = Number(value);
  return (isFinite(n) && n > 0) ? n : fallback;
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
 * One channel's window, reduced over two nested windows: the long average, the
 * recent average, and the move between them.
 *
 * Both cuts are made here, by age, over the one reply the analyzer already
 * sent. That is the whole reason they can be knobs: neither costs an analyzer
 * round trip, neither resets anything, and changing one cannot lose history the
 * other still needs. The short window is a subset of the long one by
 * construction -- the caller clamps it -- which is what makes the difference
 * map a difference rather than two unrelated numbers.
 *
 * The recent average replaced a single freshest value, and the reason is that a
 * demonstrator event is ~35 hits of 256 channels: one value per channel is one
 * hit, so the map jumped between refreshes by the width of the noise on a
 * single sample and a reader could not tell that from a channel moving. An
 * average over a few seconds is the same claim with the sampling noise taken
 * out of it. `newest` and `age` survive for the tooltip, which is where "when
 * was this channel last hit" is still worth having.
 *
 * `age` is the *least* age, not the last element of the array. The analyzer
 * does emit oldest-first and says so, but this file already decided once not to
 * rely on another process's emission order, and the suite scrambles a reply on
 * purpose to keep that honest. Taking the minimum costs
 * nothing inside a pass that is happening anyway, and both window cuts are on
 * age rather than on position for the same reason.
 *
 * Two null states, and they are different facts:
 *
 * - `recent` is null when nothing arrived inside the short window. The channel
 *   has a standing average and no present, which is a quiet channel -- and this
 *   tile cannot tell a quiet channel from a dead one, so it says the first.
 * - `diff` is null when there is nothing to subtract: either no recent value,
 *   or every value in the long window is also in the short one, in which case
 *   the two averages are the same arithmetic and the difference is zero by
 *   construction rather than by measurement. The map marks both instead of
 *   painting them as "did not move", which is the opposite reading.
 *
 * A channel with nothing inside the long window is dropped entirely: it is not
 * a channel this tile has anything to say about, and the maps draw it as absent
 * exactly as they draw one the analyzer never mentioned.
 */
function reduceByChannel(s, longS, shortS) {
  const by = new Map();
  for (let i = 0; i < s.channel.length; i++) {
    const ch = s.channel[i];
    const v = s.value[i];
    const age = (s.age && i < s.age.length) ? s.age[i] : 0;
    let r = by.get(ch);
    if (!r) {
      r = { ch: ch, n: 0, sum: 0, nRecent: 0, sumRecent: 0,
            newest: null, age: Infinity };
      by.set(ch, r);
    }
    if (age <= longS) {
      r.n += 1;
      r.sum += v;
      if (age < r.age) { r.age = age; r.newest = v; }
    }
    if (age <= shortS) { r.nRecent += 1; r.sumRecent += v; }
  }
  const out = new Map();
  by.forEach(function (r, ch) {
    if (!r.n) return;
    r.avg = r.sum / r.n;
    r.recent = r.nRecent ? r.sumRecent / r.nRecent : null;
    // The long average includes the short window's values, so that what the
    // Average map shows is exactly what the Difference map subtracted. The cost
    // is a damping -- the move shows at (1 - nRecent/n) of its size -- and that
    // is stated in the key rather than corrected for, because the three maps
    // subtracting cell by cell is the property that makes a stack of three
    // readable at all.
    r.diff = (r.recent !== null && r.n > r.nRecent) ? r.recent - r.avg : null;
    out.set(ch, r);
  });
  return out;
}

/**
 * A grid position's channels, reduced to the one record the three maps draw.
 *
 * Under ping-pong a strip is two channels and both have their own pedestal and
 * their own noise -- they are two amplifiers, not two samples of one. So this
 * does not average them. It **picks one**, by a rule the tile states, and draws
 * that channel's average, recent and difference throughout.
 *
 * Picking rather than averaging is what keeps the stack subtracting cell by
 * cell, which is the property the three maps are read on. Reduce each map
 * separately -- max of the averages here, max of the recents there -- and the
 * difference map would be one channel's present minus the other's past on any
 * cell where the two crossed, which is a number about nothing.
 *
 * What the picked channel cannot show is the partner, and that is exactly what
 * the fourth map is for: `gap` is the second channel's long average minus the
 * first's, **in map order**, whichever of the two the maps above are drawing.
 * Map order rather than drawn-first because the sign has to stay stable -- a
 * difference whose reference flipped when the pick flipped would change colour
 * without anything changing in the detector.
 */
function reduceAtPosition(pos, by, pair) {
  const recs = pos.channels.map((ch) => by.get(ch) || null);
  const live = [];
  recs.forEach(function (r, i) { if (r) live.push(i); });
  const pick = live.length
    ? (live.length === 1 ? live[0] : pair.pick(recs, live))
    : null;
  // Exactly two, and both reporting. A position with one channel has no
  // partner, and one whose partner said nothing inside the long window has
  // nothing to subtract -- which is a different fact from a gap of zero, and
  // the map marks it as such rather than painting it at the middle of the ramp.
  const gap = (recs.length === 2 && recs[0] && recs[1])
    ? recs[1].avg - recs[0].avg : null;
  return { chs: pos.channels, recs: recs, pick: pick, gap: gap,
           r: pick === null ? null : recs[pick] };
}

/**
 * A per-channel quantity as the target: a long average, a short one, and the
 * move between. Both recent-value tiles on the Channels tab are this function.
 *
 * The scatter this replaces put RMS against the *global channel* -- so two
 * columns side by side on the plot were two channels sharing a cable, not two
 * strips sharing a neighbourhood. Its own comment said as much, and said that
 * until there was a channel map they were "not even neighbouring strips". The
 * map exists now, so the tile can be drawn against the detector: a cell per
 * channel, placed where its strip actually sits in its layer.
 *
 * **One renderer, two tiles.** The baseline was eight mplot panels of value
 * against time until it was this, and the argument for that shape was real:
 * a baseline that has walked is a walk, with a direction and a moment it
 * started, and a map of one value per channel could only show it as a cell that
 * had changed colour. Two windows answer most of it -- the difference map is
 * signed, so which way and how far survive -- and what is genuinely gone is
 * *when* it started and the difference on sight between a slope and fattening
 * noise. Traded for a Channels tab where both tiles are the same grid read the
 * same way, a strip is the same cell on both, and there is one implementation
 * to be right rather than two. Trending a baseline across a run was always a
 * different tile wanting MIDAS history, and still is.
 *
 * What the tiles do not share is `spec.rank`: see fillRanks.
 *
 * **Three maps, because one number cannot answer the question.** "Which strips
 * are noisy" and "has anything got noisier just now" are different questions
 * and a single picture answers whichever one the reader assumed. The long
 * average is the standing state, the short one is where the channel is now, and
 * the difference is what changed. Stacked rather than side by side so a column
 * is one strip read three ways, top to bottom.
 *
 * **Both windows are settings**, `/DQM/<page>/Noise Window Seconds` and
 * `Noise Recent Seconds`, with an Edit button on each chip. They are knobs and
 * not constants because the right numbers follow the beam rate and what a shift
 * is chasing, and because they cost nothing: both cuts are made by the page,
 * by age, over the one series the analyzer already sent, so changing either
 * resets no history and asks the analyzer for nothing.
 *
 * **Neither map is one event.** A demonstrator event is ~35 hits of 256
 * channels, so a literal per-event map would be a seventh full and the
 * difference meaningful only there. The short map used to be each channel's
 * single freshest value whenever it arrived, which was denser but carried the
 * noise on one sample -- the map moved between refreshes by more than most of
 * what it was meant to show, and it had to be dimmed cell by cell to admit how
 * old it was. A window says the same thing without either problem: the age is
 * bounded by the window, and averaging inside it is what takes the single-hit
 * scatter out.
 *
 * **Divs and not an mplot colormap**, which is the one structural choice here.
 * A cell has states no colour scale can carry -- no value in the long window,
 * no value in the short one, and no older values to compare the short one
 * against -- and a colormap paints them all as the bottom of the ramp, which is
 * exactly the reading they must not get. 768 divs is also
 * nothing next to the 26316 rectangles the colormaps here are toggled off to
 * avoid, and it sidesteps every mplot trap this file has paid for once already.
 */
function channelMaps(spec) {
  const name = spec.name;
  return function (ctx) {
    const client = String(ctx.cfg["Analyzer Client"] || "").trim();
    if (!client) {
      blocked(ctx.body,
        `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, so `
        + `this panel does not know whom to ask for ${name}.`,
        ctx.panel, `${DQM.CONFIG_ROOT}/Analyzer Client`);
      return;
    }

    // What the two maps are asked to average over, before the clamps below.
    // Read once at build, like every other page-side setting: loadConfig runs
    // at boot, so an edit applies on the next page load. The Edit buttons go to
    // the keys themselves rather than describing them, which is what every
    // other configurable value on these pages does.
    //
    // A pair of keys per tile rather than one pair for both: a baseline walk
    // and a noise excursion happen on different timescales, and a shifter
    // narrowing one window to chase something must not silently move the other.
    const LONG_PATH = `${DQM.CONFIG_ROOT}/${ctx.page}/${spec.longKey}`;
    const SHORT_PATH = `${DQM.CONFIG_ROOT}/${ctx.page}/${spec.shortKey}`;
    const wantLong = positiveOr(ctx.cfg[spec.longKey], 120);
    const wantShort = positiveOr(ctx.cfg[spec.shortKey], 10);

    const covered = el("span", {}, "—");
    const longChipValue = el("span", {}, "—");
    const shortChipValue = el("span", {}, "—");
    const quietChip = el("span", { class: "dqm-chip" }, "");

    const longChip = chip("average over", longChipValue);
    longChip.appendChild(editButton(LONG_PATH, "Edit"));
    longChip.title = `The long window: the standing state each channel is in. `
      + `Capped by what the analyzer keeps, which is its own setting.`;
    const shortChip = chip("recent over", shortChipValue);
    shortChip.appendChild(editButton(SHORT_PATH, "Edit"));
    // The refresh interval used to be a chip of its own. It is one sentence
    // about a number nobody tunes, and it was sitting in the row a reader scans
    // for the two that matter, so it moves here -- onto the chip whose claim it
    // qualifies. The short map is the one that says "now", and the honest size
    // of that claim is its own window plus however long since the last fetch.
    shortChip.title = `The short window: where each channel is now. Must be `
      + `under the long one, or there is nothing left for the difference map `
      + `to subtract. The maps are refetched every `
      + `${Math.round(REFRESH_MS / 1000)} s, so a recent average can be that `
      + `much older than its own window.`;

    ctx.body.appendChild(el("div", { class: "dqm-strip" },
      chip("series", el("code", {}, name)),
      chip("channels", covered), longChip, shortChip, quietChip));

    // Empty on the happy path. It carries the one thing a pair of knobs can do
    // that a pair of constants could not: be set to something the data cannot
    // honour. A window silently narrowed is a map labelled with a number it is
    // not drawing.
    const cfgNote = el("div", { class: "dqm-note" }, "");
    cfgNote.hidden = true;
    ctx.body.appendChild(cfgNote);

    const note = el("div", { class: "dqm-note" }, "Asking the analyzer…");
    const geoNote = el("div", { class: "dqm-note" }, "Reading the channel map…");
    ctx.body.appendChild(note);
    ctx.body.appendChild(geoNote);

    // One readout per tile, closed over by that tile's own hover handlers and
    // keyed by the slug. Two tiles run this function on the same tab, so a
    // shared readout would let whichever received its first reply first take
    // the other's hover line -- a race, not an ordering.
    const readout = el("div", { class: "dqm-readout", id: `${spec.slug}-readout` },
      "Hover a cell to identify its channel.");
    ctx.body.appendChild(readout);

    const maps = el("div", { class: "dqm-heat-maps", id: `${spec.slug}-maps` });
    ctx.body.appendChild(maps);

    const rankBox = el("div", { class: "dqm-outliers", id: `${spec.slug}-outliers` });
    ctx.body.appendChild(rankBox);

    //: The three maps, in the order they are read. `kind` is what paint()
    //: switches on and what the tests name. The headings are written each tick
    //: rather than fixed here: they name the window each map averages over, and
    //: that is a setting -- and one the page may have had to clamp, in which
    //: case the heading has to say the number actually drawn.
    const KINDS = [
      { kind: "avg", id: `${spec.slug}-map-avg` },
      { kind: "now", id: `${spec.slug}-map-now` },
      { kind: "diff", id: `${spec.slug}-map-diff` },
    ];
    //: The fourth map, drawn only where a position has two channels. It is the
    //: one thing the three above cannot say under ping-pong: they draw one of
    //: the pair, so a partner sitting somewhere else is invisible on all three
    //: while the strip looks perfectly ordinary. Absent entirely on a map with
    //: one channel per strip, where it would be a grid of blanks asserting that
    //: nothing has a partner.
    const PAIR_KIND = { kind: "pair", id: `${spec.slug}-map-pair` };

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
    /** One map: its heading, its grid, and the grid's place in the block. */
    function buildGrid(spec, nChannels, withAxis) {
      const box = el("div", {});
      const head = el("div", { class: "dqm-subhead" }, "");
      box.appendChild(head);
      const built = ATARGeom.heatGrid(map, {
        id: spec.id, channels: nChannels, axis: withAxis,
        onHover: function (chs, cell) {
          readout.textContent = cell.title || ATARGeom.chLabel(chs);
        },
      });
      box.appendChild(built.grid);
      maps.appendChild(box);
      built.head = head;
      return built;
    }

    /**
     * Paint one cell, which is the whole of what a tick does to the grid.
     *
     * The three absent states are set as classes and never as a colour, so
     * that "no value in the window", "seen once" and "off the top of the
     * scale" cannot be mistaken for measurements at the bottom of a ramp.
     */
    function paint(cell, pos, kind, seq, div, pairDiv, win) {
      const r = pos.r;
      const where = ATARGeom.whereText(map, cell);
      const who = ATARGeom.chLabel(pos.chs);
      // Which of a pair is on screen, said on every cell that has a pair. A
      // map drawing one of two channels without saying which one is a map
      // whose reader will attribute what they see to the wrong amplifier.
      const drew = (pos.chs.length > 1 && pos.r)
        ? ` (showing ch ${pos.chs[pos.pick]}, ${spec.pair.why})` : "";
      const ch = who + drew;

      // The partner map, which is about the pair rather than about either
      // channel, so it shares none of the states below.
      if (kind === "pair") {
        if (pos.gap === null) {
          cell.className = "dqm-heat-cell dqm-heat-single";
          cell.style.background = "";
          cell.title = `${who} — ${where} — `
            + (pos.chs.length < 2
              ? `one channel at this strip, so there is no partner to compare.`
              : `only one of the pair reported inside the last `
                + `${Math.round(win.longS)} s, so there is nothing to compare `
                + `it against. A pair with a silent half is what the ranking `
                + `below names.`);
          return;
        }
        const t = pairDiv.hi > 0 ? pos.gap / pairDiv.hi : 0;
        const over = Math.abs(pos.gap) > pairDiv.hi;
        cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "");
        cell.style.background = ATARGeom.diffColour(t);
        cell.title = `${who} — ${where} — ch ${pos.chs[1]} minus ch `
          + `${pos.chs[0]}, ${pos.gap >= 0 ? "+" : ""}`
          + `${(pos.gap * 1000).toFixed(2)} mV over the last `
          + `${Math.round(win.longS)} s `
          + `(${pos.recs[0].avg.toFixed(4)} V and `
          + `${pos.recs[1].avg.toFixed(4)} V). Two channels on one strip are `
          + `two amplifiers, so a gap here is a fact about the readout and not `
          + `about the beam.`;
        return;
      }

      if (!r) {
        cell.className = "dqm-heat-cell dqm-heat-nodata";
        cell.style.background = "";
        // Never "dead", and never "zero". The analyzer evicts on the way out,
        // so a channel absent from the reply is one nobody hit inside the
        // window -- which a quiet beam produces exactly as readily as a fault,
        // and this tile cannot tell the two apart.
        cell.title = `${who} — ${where} — no value in the last `
          + `${Math.round(win.longS)} s.`;
        return;
      }

      const recent = r.recent === null
        ? `nothing in the last ${Math.round(win.shortS)} s`
        : `recent ${r.recent.toFixed(4)} V from ${r.nRecent} `
          + `value${r.nRecent === 1 ? "" : "s"}`;
      const common = `${ch} — ${where} — avg ${r.avg.toFixed(4)} V `
        + `from ${r.n} value${r.n === 1 ? "" : "s"} over `
        + `${Math.round(win.longS)} s, ${recent}`
        + (r.newest === null ? "" : `, last hit ${Math.round(r.age)} s ago`);

      if (kind === "diff") {
        if (r.diff === null) {
          cell.className = "dqm-heat-cell dqm-heat-single";
          cell.style.background = "";
          // Two ways to have nothing to subtract, and they are different facts
          // about the channel rather than one missing number. Saying which is
          // the whole reason this state is a class and not a colour.
          cell.title = `${common} — `
            + (r.recent === null
              ? `no recent value to compare against the average.`
              : `every value in the ${Math.round(win.longS)} s window is also `
                + `inside the last ${Math.round(win.shortS)} s, so the two `
                + `averages are the same arithmetic and their difference is `
                + `zero by construction rather than by measurement.`);
          return;
        }
        const t = div.hi > 0 ? r.diff / div.hi : 0;
        const over = Math.abs(r.diff) > div.hi;
        cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "");
        cell.style.background = ATARGeom.diffColour(t);
        cell.title = `${common} — Δ ${r.diff >= 0 ? "+" : ""}`
          + `${(r.diff * 1000).toFixed(2)} mV`;
        return;
      }

      const v = kind === "now" ? r.recent : r.avg;
      // The recent map's own absent state, and the reason the staleness dimming
      // this tile used to carry is gone. That dimming existed because the map
      // drew each channel's freshest value whenever it arrived, so a cell could
      // be a minute old while claiming to be now. A window says so outright: a
      // channel with nothing inside it has no recent value to draw, which is
      // the same fact without asking anyone to read an opacity.
      if (v === null) {
        cell.className = "dqm-heat-cell dqm-heat-nodata";
        cell.style.background = "";
        cell.title = `${common} — nothing to average for the recent map.`;
        return;
      }
      const t = seq.hi > seq.lo ? (v - seq.lo) / (seq.hi - seq.lo) : 0;
      const over = v > seq.hi;
      cell.className = "dqm-heat-cell" + (over ? " dqm-heat-over" : "");
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
    function fillRanks(rows, win, positions) {
      rankBox.textContent = "";
      if (!rows.length) {
        rankBox.appendChild(el("div", { class: "dqm-note" },
          `No channel has been hit in the last ${Math.round(win.longS)} s, so `
          + `there is nothing to rank.`));
        return;
      }

      function table(head, sorted, extra) {
        rankBox.appendChild(el("div", { class: "dqm-subhead" }, head));
        const t = el("table", { class: "dqm-table" });
        t.appendChild(el("tr", {},
          el("th", {}, "channel"), el("th", {}, "layer"), el("th", {}, "strip"),
          // The column heads name their windows, because with both of them
          // settable "average" and "recent" are no longer self-describing --
          // and a table beside a map has to agree with the map's own heading.
          el("th", {}, `avg ${Math.round(win.longS)} s`),
          el("th", {}, `recent ${Math.round(win.shortS)} s`),
          el("th", {}, "Δ"),
          extra ? el("th", {}, extra.head) : null));
        sorted.slice(0, MAP_RANK).forEach(function (r) {
          t.appendChild(el("tr", {},
            el("td", { class: "label" }, `ch ${r.ch}`),
            el("td", {}, r.layer === null ? "—" : String(r.layer)),
            el("td", {}, r.strip === null ? "—" : String(r.strip)),
            el("td", {}, `${r.avg.toFixed(4)} V`),
            el("td", {}, r.recent === null ? "none"
              : `${r.recent.toFixed(4)} V`),
            // Millivolts, for the reason the baseline table has always used
            // them: the moves worth reading are single mV and four decimals of
            // a volt is a column of leading zeros to count.
            el("td", {}, r.diff === null ? "—"
              : `${r.diff >= 0 ? "+" : ""}${(r.diff * 1000).toFixed(2)} mV`),
            extra ? el("td", {}, extra.cell(r)) : null));
        });
        rankBox.appendChild(t);
      }

      // "Has this moved between the two windows" is the same question whatever
      // is being averaged, so that table is common and always drawn. A tile may
      // put one of its own in front of it -- what "out of family" means being
      // exactly what the two tiles cannot agree on -- and a tile with no second
      // question to ask omits it.
      if (spec.rank) {
        const primary = spec.rank(rows, win);
        table(primary.head, primary.sorted, primary.extra);
      }

      const moved = rows.filter((r) => r.diff !== null)
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      if (moved.length) {
        table(`Moved most: last ${Math.round(win.shortS)} s against the `
              + `${Math.round(win.longS)} s average`, moved);
      }

      const foot = el("div", { class: "dqm-footnote" },
        `${MAP_RANK} of ${rows.length} \u2014 a ranking, not a verdict`);
      foot.title = `There is no threshold here, and on a healthy run these are `
        + `simply the least average channels. Several rows sharing a layer is `
        + `the shape a whole layer going together makes.`;
      rankBox.appendChild(foot);

      // Last, and after that footnote, which counts the rows of the per-channel
      // tables above it. This one is the question neither of them can ask: both
      // rank channels against the run, and this ranks a strip's two channels
      // against each other. A channel can sit in the middle of every
      // distribution on the tab and still be nothing like its own partner,
      // which under ping-pong is one strip reading two ways depending on which
      // trigger it caught.
      if (built.pair) pairTable(positions, win);
    }

    /**
     * The strips whose two ping-pong channels disagree most.
     *
     * Its own table rather than a column on the ones above, because it ranks a
     * different thing: those rank channels against the run, this ranks a
     * strip's two channels against each other. Both halves can sit in the
     * middle of every distribution on the tab and still be nothing like one
     * another, which is one strip reading two ways depending on which trigger
     * it caught -- and the maps cannot show it, because they draw one of the
     * two.
     *
     * No threshold and no verdict, for the reason the tables above give: two
     * channels are two amplifiers and a standing offset between them is
     * ordinary. What this names is where the offsets are largest, and the
     * reader decides whether that is the cabling or a fault.
     */
    function pairTable(positions, win) {
      const pairs = (positions || []).filter((p) => p.gap !== null);
      if (!pairs.length) return;
      const sorted = pairs.slice()
        .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));

      rankBox.appendChild(el("div", { class: "dqm-subhead" }, "Partners furthest apart"));
      const t = el("table", { class: "dqm-table" });
      t.appendChild(el("tr", {},
        el("th", {}, "channels"), el("th", {}, "layer"), el("th", {}, "strip"),
        el("th", {}, "first"), el("th", {}, "second"), el("th", {}, "gap")));
      sorted.slice(0, MAP_RANK).forEach(function (pp) {
        const cell = built.avg.byCh.get(pp.chs[0]);
        t.appendChild(el("tr", {},
          el("td", { class: "label" }, ATARGeom.chLabel(pp.chs)),
          el("td", {}, cell && cell.dataset.layer !== undefined
            ? cell.dataset.layer : "—"),
          el("td", {}, cell && cell.dataset.strip !== undefined
            ? cell.dataset.strip : "—"),
          el("td", {}, `${pp.recs[0].avg.toFixed(4)} V`),
          el("td", {}, `${pp.recs[1].avg.toFixed(4)} V`),
          el("td", {}, `${pp.gap >= 0 ? "+" : ""}`
            + `${(pp.gap * 1000).toFixed(2)} mV`)));
      });
      rankBox.appendChild(t);

      const foot = el("div", { class: "dqm-footnote" },
        `${Math.min(MAP_RANK, sorted.length)} of ${pairs.length} pairs over `
        + `${Math.round(win.longS)} s \u2014 a ranking, not a verdict`);
      foot.title = `Second channel minus first, in the order the channel map `
        + `lists them. Two channels on one strip are two amplifiers, so a `
        + `standing gap between them is ordinary and no threshold here could `
        + `tell one from a fault; what settles it is whether the cell on the `
        + `partner map looks like its neighbours.`;
      rankBox.appendChild(foot);
    }

    async function tick() {
      const s = await BRPC.json(client, "dqm::series", name);
      if (!s || !s.channel) throw new Error(`empty reply for ${name}`);
      const horizon = Number(s.window_s) || 0;
      const nChannels = Number(s.channels) || 0;
      unit = s.unit || spec.unit;

      // The clamps, and the sentence each one owes the reader.
      //
      // Neither is a correction the page can make quietly. A long window wider
      // than what the analyzer keeps would draw 120 s of data under a heading
      // saying 300; a short window that reaches the long one leaves the
      // difference map with nothing to subtract on any channel, so every cell
      // goes blank and a reader would be entitled to read that as the detector
      // rather than as the setting. Clamped here, said below.
      const longS = horizon > 0 ? Math.min(wantLong, horizon) : wantLong;
      const shortS = Math.min(wantShort, longS);
      const win = { longS: longS, shortS: shortS };
      const caveats = [];
      if (horizon > 0 && wantLong > horizon) {
        caveats.push(`The average window is set to ${Math.round(wantLong)} s, `
          + `but the analyzer keeps ${Math.round(horizon)} s per channel, so `
          + `${Math.round(longS)} s is what is drawn. Raising `
          + `${DQM.CONFIG_ROOT}/Analyzer/Binning/recent seconds per channel is `
          + `what would make the longer window available.`);
      }
      if (wantShort > longS) {
        caveats.push(`The recent window is set to ${Math.round(wantShort)} s, `
          + `which is not shorter than the ${Math.round(longS)} s average, so `
          + `it is drawn at ${Math.round(shortS)} s. The two maps are then the `
          + `same average and the difference between them is empty.`);
      } else if (wantShort === longS) {
        caveats.push(`Both windows are ${Math.round(longS)} s, so the two maps `
          + `are the same average and the difference between them is empty.`);
      }
      cfgNote.textContent = caveats.join(" ");
      cfgNote.hidden = !caveats.length;
      // Yellow rather than red: nothing is broken and both maps are drawing.
      // What is wrong is a setting, and the tile is still answering the
      // question it was asked -- over a window it had to choose.
      cfgNote.className = caveats.length ? "dqm-diagnosis yellow" : "dqm-note";

      if (!built) {
        // Each key above what it explains, which is where this page set puts a
        // colour key -- see stripLegend in dqm-atar-geom.js, which puts a key
        // above what it explains rather than under it. It also settles an ambiguity the first live render walked
        // into: a shared key sitting between the second and third maps reads as
        // belonging to the third, which is the one map it does not describe.
        built = {};
        built.seqKey = el("div", {});
        maps.appendChild(built.seqKey);
        built.avg = buildGrid(KINDS[0], nChannels, false);
        // Read off the grid that was just built rather than worked out from
        // the map again here: whether a position carries two channels is
        // heatGrid's answer, and asking it twice is how the two drift apart.
        built.paired = built.avg.paired;
        built.now = buildGrid(KINDS[1], nChannels, false);
        built.diffKey = el("div", {});
        maps.appendChild(built.diffKey);
        // The strip axis goes under the last grid only: identical axes stacked
        // are more ink for one fact. Which grid is last depends on whether
        // there is a partner map, so the flag follows it rather than sitting
        // on the time difference by name.
        built.diff = buildGrid(KINDS[2], nChannels, !built.paired);
        if (built.paired) {
          built.pairKey = el("div", {});
          maps.appendChild(built.pairKey);
          built.pair = buildGrid(PAIR_KIND, nChannels, true);
        }
        // Nothing on the happy path: the rows are labelled L0..L7 and the axis
        // is labelled strip, so a sentence saying the cells are laid out by
        // strip and layer is telling a reader what they are looking at.
        geoNote.textContent = "";
        geoNote.title = map ? `Channel map from ${map.source}.` : "";
        geoNote.hidden = !!map;
        if (!map) {
          // Yellow, not red: nothing is broken. The analyzer is answering and
          // every channel is on the ribbon -- what is missing is the geometry
          // to place them by, which is a caveat on the view and not a fault.
          geoNote.className = "dqm-diagnosis yellow";
          geoNote.textContent = `No ATAR geometry in ${ATARGeom.SETTINGS}: `
            + `one row of every channel, not a map.`;
          geoNote.title = `The layer and strip of a channel cannot be guessed. `
            + `A pixel id decodes only under the base and the stride it was `
            + `made with, and assuming the wrong stride moves a fifth of the `
            + `channels while looking entirely plausible.`;
        }
      }

      const by = reduceByChannel(s, longS, shortS);

      // Each map says the window it is drawing, every tick, because both are
      // settable and one of them may have just been clamped.
      built.avg.head.textContent = `Average over the last ${Math.round(longS)} s`;
      built.now.head.textContent = `Average over the last ${Math.round(shortS)} s`;
      built.diff.head.textContent = `Recent minus average`;
      if (built.pair) built.pair.head.textContent = `Partner gap`;

      // The sequential scale spans BOTH maps, because they are read against
      // each other: the same colour has to mean the same RMS in the average and
      // in the recent, or the comparison the stack exists for is not
      // available.
      //
      // But the fence is taken from each population separately and the WIDER
      // one wins, which is not the same as fencing the pool. A mean over n
      // values is narrower than a single value by construction -- that is what
      // averaging is -- so the pooled quartiles sit inside the average's tight
      // bulk, and a fence drawn there is one the recent values step straight
      // over. Measured on the live analyzer when the short map was one value
      // per channel: 46 of 256 cells off the top of the scale and 19 distinct
      // colours left on it, against 151 on the average. Averaging the short
      // window narrows it, so the two populations are closer than that now --
      // and the wider fence still has to win, because they never coincide. Covering both distributions is what a shared scale has to
      // mean. The average then occupies the lower part of the ramp and looks
      // more uniform than the recent -- which is a true statement about the
      // data and not an artefact of the drawing.
      // Two passes, because the maps and the tables are two populations. The
      // maps are per position and draw one channel of each pair; the tables
      // are per channel and name both. The scale has to be fitted to what is
      // actually painted -- fence over every channel and the halves that are
      // not on screen drag the quartiles down and clip the cells that are.
      const positions = built.avg.byPos.map(function (pos) {
        return reduceAtPosition(pos, by, spec.pair);
      });

      const avgVals = [];
      const nowVals = [];
      const seqVals = [];
      const diffVals = [];
      const gapVals = [];
      positions.forEach(function (p) {
        if (p.gap !== null) gapVals.push(Math.abs(p.gap));
        const r = p.r;
        if (!r) return;
        avgVals.push(r.avg);
        seqVals.push(r.avg);
        // A channel with nothing in the short window contributes nothing to
        // the recent map's population. Pooling a null would poison the fence
        // and the span; leaving it out is what "no value" has to mean.
        if (r.recent !== null) {
          nowVals.push(r.recent);
          seqVals.push(r.recent);
        }
        if (r.diff !== null) diffVals.push(Math.abs(r.diff));
      });

      // Counted here rather than inside the paint loop, which is where it used
      // to sit. Both halves of a pair resolve to the same cell, so a loop over
      // byCh would visit that cell twice, and a loop over positions would miss
      // the partner the maps are not drawing -- and this number is per channel,
      // because what it is for is deciding whether the short window is wide
      // enough for the rate each channel is actually seeing.
      let quiet = 0;
      const rows = [];
      by.forEach(function (r) {
        const cell = built.avg.byCh.get(r.ch);
        if (cell && r.recent === null) quiet += 1;
        rows.push({
          ch: r.ch, n: r.n, nRecent: r.nRecent,
          avg: r.avg, recent: r.recent, diff: r.diff,
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

      // The partner map's own scale, fenced and symmetric exactly as the time
      // difference is, and deliberately NOT the same number. The two answer
      // different questions -- how far a strip has moved since the run
      // started, and how far its two amplifiers sit apart -- and there is no
      // reason the sizes should match. Sharing one would let whichever spread
      // is larger flatten the other to a sheet of white.
      const gFull = span(gapVals);
      const gFence = fenceTop(gapVals);
      const pairDiv = gFull
        ? { hi: (gFence !== null && gFence > 0 && gFence < gFull.hi)
              ? gFence : gFull.hi,
            clipped: false }
        : { hi: 0, clipped: false };
      pairDiv.clipped = !!gFull && pairDiv.hi < gFull.hi;
      if (!(pairDiv.hi > 0)) pairDiv.hi = 1e-4;

      // Reachable from the console and from the tests, the way a graph is hung
      // off its div. The two sequential maps carry the SAME object, which is
      // what "one scale" means when it is asserted rather than described.
      built.avg.grid.dqmScale = seq;
      built.now.grid.dqmScale = seq;
      built.diff.grid.dqmDiffScale = div;
      if (built.pair) built.pair.grid.dqmPairScale = pairDiv;

      // By position and not by channel: both halves of a pair resolve to the
      // same cell, so iterating byCh would paint it twice and the second pass
      // would win. Every grid here was built from the one channel map, so the
      // byPos arrays are parallel and index i is the same strip on all of them.
      KINDS.concat(built.pair ? [PAIR_KIND] : []).forEach(function (k) {
        const b = built[k.kind];
        b.byPos.forEach(function (pos, i) {
          paint(pos.cell, positions[i], k.kind, seq, div, pairDiv, win);
        });
      });

      built.seqKey.textContent = "";
      built.diffKey.textContent = "";
      // A phrase, and the argument behind it on the key's own tooltip. The
      // visible mark is what keeps a clipped scale honest; the explanation of
      // how it clipped is not, and it was four lines under every draw.
      const seqNote = seq.clipped ? "top clipped" : "";
      const seqDetail = `One scale for both maps, fenced on whichever of the `
        + `two is wider: a mean is narrower than a single value by `
        + `construction, so fencing the pool would cut the recent map in half.`
        + (seq.clipped
          ? ` The top stops at ${NOISE_FENCE} x IQR above the upper quartile so `
            + `one loud channel does not flatten the rest; the highest is `
            + `${full.hi.toFixed(4)} V, and cells past the end are outlined.`
          : "");
      built.seqKey.appendChild(ATARGeom.heatLegend(seq.lo, seq.hi, {
        id: `${spec.slug}-seq-key`,
        label: unit,
        // The sharing stays visible, because it is the claim the two maps are
        // read on and two ramps drawn separately look identical whether or not
        // they were fitted together. In the label it pushed the upper bound
        // onto its own line, so it goes in the note.
        note: `one scale for both maps below${seqNote ? ", " + seqNote : ""}`,
        detail: seqDetail,
      }));
      built.diffKey.appendChild(ATARGeom.diffLegend(div.hi, {
        id: `${spec.slug}-diff-key`,
        label: "change (V)",
        note: `last ${Math.round(shortS)} s minus last ${Math.round(longS)} s`
          + (div.clipped ? ", top clipped" : ""),
        detail: `The long average includes the short window's values, so a `
          + `channel shows the fraction of its move that the long window does `
          + `not already contain: with a ${Math.round(shortS)} s window inside `
          + `a ${Math.round(longS)} s one that is most of it, and it goes to `
          + `nothing as the two windows close up. Kept that way so the three maps subtract cell by cell. A `
          + `channel with nothing recent, or with every value already inside `
          + `the short window, has no comparison to make and is left blank.`
          + (div.clipped ? ` Outlined cells are past the end of this scale.` : ""),
      }));
      if (built.pair) {
        built.pairKey.textContent = "";
        built.pairKey.appendChild(ATARGeom.diffLegend(pairDiv.hi, {
          id: `${spec.slug}-pair-key`,
          label: "partner gap (V)",
          note: `second channel minus first, over ${Math.round(longS)} s`
            + (pairDiv.clipped ? ", top clipped" : ""),
          detail: `Ping-pong wires a strip to two channels and records a `
            + `deposit on whichever was not used last, so every cell above `
            + `draws one of the two and this is the only map that can show the `
            + `other. Second minus first in the order the channel map lists `
            + `them, whichever of the two the maps above chose, so the sign `
            + `does not flip when the pick does. They are two amplifiers, so a `
            + `standing gap is ordinary and what is worth reading is a cell `
            + `unlike its neighbours. A strip with one channel, or a pair with `
            + `a half that said nothing in the window, has no comparison to `
            + `make and is left blank.`
            + (pairDiv.clipped
              ? ` Outlined cells are past the end of this scale.` : ""),
        }));
      }

      fillRanks(rows, win, positions);

      drawn = true;
      covered.textContent = nChannels ? `${by.size} of ${nChannels}` : String(by.size);
      longChipValue.textContent = `${Math.round(longS)} s`;
      shortChipValue.textContent = `${Math.round(shortS)} s`;
      quietChip.textContent = quiet
        ? `${quiet} with nothing in ${Math.round(shortS)} s`
        : `all ${by.size} have a recent value`;
      // Yellow, not red, for the reason the baseline tile gives: a quiet
      // channel is a fact about the beam as often as it is a fault.
      quietChip.className = quiet ? "dqm-chip yellow" : "dqm-chip";
      quietChip.title = quiet
        ? `${quiet} channel${quiet === 1 ? " has" : "s have"} a standing `
          + `average but nothing inside the last ${Math.round(shortS)} s, so `
          + `${quiet === 1 ? "its cell is" : "those cells are"} blank on the `
          + `recent map and on the difference. That is a quiet channel, which `
          + `this tile cannot tell from a fault -- and it is the number to `
          + `watch when widening the recent window.`
        : `Every channel with a standing average was also hit inside the last `
          + `${Math.round(shortS)} s.`;
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


//: Panel ids in PANELS that are drawn by something other than histPanel. They
//: stay in PANELS because that map is what /DQM/ATAR/Histograms is checked
//: against -- occupancy is still a histogram fetched over dqm::histogram, it is
//: simply not drawn as one.
const OWN_RENDERER = { atar_occupancy: occupancyMap };

Object.keys(PANELS).forEach(function (id) {
  DQMPage.register(id, (OWN_RENDERER[id] || function (n) {
    return histPanel(n, TWO_D.has(id));
  })(PANELS[id]));
});

//: The two recent-value tiles on the Channels tab. Same renderer, same grid,
//: same two-window shape -- what differs is the series, the ids, which pair of
//: ODB keys sets the windows, and whether the tile has a ranking of its own to
//: put in front of the shared one.
//:
//: `rank` is optional, and is called only with a non-empty `rows`: fillRanks
//: returns before it on an empty one, so a rank function needs no guard of its
//: own against an empty set.
const NOISE_MAPS = {
  name: NOISE, slug: "noise", unit: "RMS (V)",
  longKey: "Noise Window Seconds", shortKey: "Noise Recent Seconds",
  //: Which half of a ping-pong pair the three maps draw: the louder one, which
  //: is the same rule `rank` sorts by and for the same reason. Loud is high and
  //: only high, so a noisy channel that shared a strip with a quiet one would
  //: be hidden on every map by any rule that did not go looking for it -- and
  //: "one of these two amplifiers is ringing" is exactly what this tile is for.
  pair: {
    why: "the louder of the pair",
    pick: function (recs, live) {
      let best = live[0];
      live.forEach(function (i) { if (recs[i].avg > recs[best].avg) best = i; });
      return best;
    },
  },
  //: Loud is high, and only high. The top of the distribution is the answer.
  rank: function (rows, win) {
    return {
      head: `Loudest over the last ${Math.round(win.longS)} s`,
      sorted: rows.slice().sort((a, b) => b.avg - a.avg),
    };
  },
};

const BASELINE_MAPS = {
  name: BASELINE, slug: "baseline", unit: "V",
  longKey: "Baseline Window Seconds", shortKey: "Baseline Recent Seconds",
  //: The first of the pair in map order, and deliberately not "the worst".
  //:
  //: There is no absolute rule to pick by here, which is the same fact that
  //: cost this tile its median ranking: the highest baseline means nothing, and
  //: a set of channels all at 0.74 V is a healthy detector. Out of family is
  //: the only sense in which one is worse than the other, and that is defined
  //: against the population being drawn -- so picking by it would choose the
  //: cells that set the scale that decides the choice.
  //:
  //: Map order instead, which is arbitrary but stable, and the partner map is
  //: what covers what it leaves out: a second channel sitting somewhere its
  //: neighbours' second channels do not is a cell unlike the ones around it.
  //: Averaging the two was the other option and is worse than either -- two
  //: channels on a strip are two amplifiers with their own pedestals, and
  //: their mean is a voltage neither of them is sitting at.
  pair: { why: "the first of the pair in map order",
          pick: function (recs, live) { return live[0]; } },
  //: No ranking of its own: "Moved most" is the only table under these maps.
  //:
  //: There was a second one, ranking each channel by how far its average sat
  //: from the median of every channel, with the signed gap in a column. It
  //: answered "which baseline is out of family", which the highest-first sort
  //: the noise tile uses cannot do -- a set of channels all on 0.74 V is a
  //: healthy detector, and the one worth naming sits away from the rest on
  //: either side.
  //:
  //: What replaces it is the maps themselves. A baseline away from where the
  //: others sit is a cell that is not the colour of its neighbours, on a scale
  //: spanning every channel, and that is legible without a table. What a table
  //: adds over a map is the channel number, and "Moved most" still carries that
  //: for the channels that have changed.
  rank: null,
};

DQMPage.register("noise_by_channel", channelMaps(NOISE_MAPS));
DQMPage.register("baseline_by_channel", channelMaps(BASELINE_MAPS));

// Reachable for the tests, which assert this agrees with config_defaults.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { PANELS, NOISE, BASELINE, TWO_D, refreshFor, cadenceText,
                    REFRESH_MS, BIG_HIST_CELLS, MAX_REFRESH_MS,
                    NOISE_FENCE };
}

})();
