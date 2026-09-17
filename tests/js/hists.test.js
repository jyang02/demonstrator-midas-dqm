//
// The analyzer-backed tiles on the Channels tab, and chiefly the baseline
// block: eight panels of baseline against time, one per ATAR layer.
//
// The transport is stubbed at BRPC.json -- the binary framing has its own
// cross-language test and is not what these are about. What they pin is the
// shape the tile draws: a line per channel rather than a cloud of markers, a
// panel per layer in the two-column block the waveforms use, one ruler across
// all eight, and bounds on every plot so mplot does not hand back a white
// rectangle with no error in it.
//

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { runPage } = require(path.join(__dirname, "domstub.js"));

const JS = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(JS, "dqm-common.js"));
globalThis.DQMPanels = require(path.join(JS, "dqm-panels.js"));

const PAGE = "ATAR";
const GEOM = path.join(JS, "dqm-atar-geom.js");
const N_LAYERS = 8;
const PER_LAYER = 32;
const STRIDE = 46;
const BASE = 100000;
const DEPTH = 10;
//: The fixed x window. Written out rather than imported, because requiring
//: dqm-hists.js at load destructures DQMPage and there is no page yet -- and
//: because a test that reads the value it is checking checks nothing. The one
//: test below ties this to the module's own constant, so changing it there
//: fails here, once, in an obvious place.
const WINDOW_S = 60;

//: /Equipment/SAMPIC/Settings as a demonstrator file's frontend publishes it.
//: The same shape scope.test.js builds, and deliberately the same numbers: the
//: two tabs draw the same eight layers, and a fixture that disagreed would let
//: them disagree.
function sampicSettings() {
  const ids = [], det = [];
  for (let L = 0; L < N_LAYERS; L++) {
    for (let s = 0; s < PER_LAYER; s++) { ids.push(BASE + L * STRIDE + s); det.push("atar"); }
  }
  return {
    "/Equipment/SAMPIC/Settings/Channel map channel id": ids,
    "/Equipment/SAMPIC/Settings/Channel map detector": det,
    "/Equipment/SAMPIC/Settings/Atar pixel id base": BASE,
    "/Equipment/SAMPIC/Settings/Atar strips per layer": STRIDE,
    "/Equipment/SAMPIC/Settings/Atar n layers": N_LAYERS,
    "/Equipment/SAMPIC/Settings/Atar first layer orientation": "vertical",
  };
}

/**
 * A dqm::series reply: `depth` values on each of `nch` channels.
 *
 * Oldest first within a channel, which is the order RecentByChannel.points()
 * emits and the order the age array therefore descends in.
 */
function series(nch, depth, valueAt) {
  const channel = [], value = [], age = [];
  for (let ch = 0; ch < nch; ch++) {
    for (let k = 0; k < depth; k++) {
      channel.push(ch);
      value.push(valueAt ? valueAt(ch, k) : 0.74);
      age.push((depth - 1 - k) * 2.0);
    }
  }
  // window_s is what the analyzer now reports: it keeps a time window per
  // channel, not a fixed count. Deliberately wider than the page's own window,
  // which is the relationship the tile's chip explains.
  return { title: "baseline", unit: "V", window_s: 120, channels: nch,
           entries: channel.length, channel, value, age };
}

/** Let every pending microtask and the stubbed timers settle. */
async function settle(page) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 50; j++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  }
  if (page) page.flushTimers();
  for (let j = 0; j < 50; j++) await Promise.resolve();
}

/** Boot the ATAR page on its Channels tab with one canned series reply. */
async function boot(reply, odbExtra) {
  const cfg = Object.assign({}, globalThis.DQM.DEFAULTS.ATAR);
  const page = runPage(path.join(JS, "dqm-page.js"), {
    db_get_values: (p) => ({
      data: p.paths.map((x) => (x.endsWith("/ATAR") ? cfg
        : (odbExtra && x in odbExtra) ? odbExtra[x] : null)),
      status: p.paths.map((x) => (x.endsWith("/ATAR") ? 1
        : (odbExtra && x in odbExtra) ? 1 : 312)),
    }),
    db_ls: (p) => ({ data: p.paths.map(() => null) }),
    hs_get_events: () => ({ events: [] }),
    brpc: () => Promise.reject(new Error("no such client")),
  }, { boot: PAGE, also: [path.join(JS, "dqm-brpc.js"), GEOM,
                          path.join(JS, "dqm-hists.js")] });

  // Stubbed above the framing: these tests are about what gets drawn, and
  // dqm-brpc.js's own wire format is pinned by scopeframe.test.js.
  globalThis.BRPC.list = async () => ["sampic/occupancy"];
  globalThis.BRPC.json = async () => reply;
  // The histogram tiles share this tab and are not what these tests are about.
  // Left pending rather than rejected: a rejection would have AutoUpdater
  // console.error once per tile per boot, and a screenful of that in a passing
  // run is how a real error stops being noticed.
  globalThis.BRPC.histogram = () => new Promise(() => {});

  await page.load();          // Channels is the first tab, so it is built here
  await settle(page);
  return page;
}

function graphAt(page, id) {
  const div = page.doc.getElementById(id);
  assert.ok(div, `no plot div ${id}`);
  assert.ok(div.mpg, `${id} never got a graph`);
  return div.mpg;
}

function layerGraphs(page) {
  const out = [];
  for (let L = 0; L < N_LAYERS; L++) out.push(graphAt(page, `baseline-plot-L${L}`));
  return out;
}

// --- the block --------------------------------------------------------------

test("the baseline tile is eight panels flowing four to a row", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const host = page.doc.getElementById("baseline-layer-panels");
  assert.ok(host, "the baseline tile built no layer block");
  // The four-column grid is what makes eight panels two rows. Asserting the
  // count alone would pass on a single stack of eight, which is what the
  // narrow-viewport fallback deliberately is.
  assert.ok(host.className.includes("dqm-layer-quad"),
    `the block is not in the four-column grid: ${host.className}`);
  assert.strictEqual(host.byClass("dqm-plot").length, N_LAYERS);

  // In layer order, not grouped by parity. Which way a layer's strips run
  // decides how a *track* is read, which is the Scope tab's question; a
  // baseline is a baseline whichever way the strip lies, so grouping by it
  // here would be a parity for the reader to decode before finding layer 5.
  const order = host.byClass("dqm-plot").map((d) => d.id);
  assert.deepStrictEqual(order,
    Array.from({ length: N_LAYERS }, (_, L) => `baseline-plot-L${L}`),
    "the panels are not in layer order");
});

test("the panel headings do not name a strip orientation", async () => {
  // Dropped on purpose: it is not what this tile is asked, and a label nobody
  // needs is a label that has to stay true.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const host = page.doc.getElementById("baseline-layer-panels");
  const heads = host.byClass("dqm-subhead").map((e) => e.textContent.trim());
  assert.deepStrictEqual(heads,
    Array.from({ length: N_LAYERS }, (_, L) => `Layer ${L}`));

  const text = [...host.walk()].map((e) => e._text || "").join(" ");
  assert.doesNotMatch(text, /vertical|horizontal/i,
    "an orientation label survived in the block");
});

test("each panel carries a line per channel of its layer, not a cloud of markers", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  layerGraphs(page).forEach(function (g, L) {
    assert.strictEqual(g.param.plot.length, PER_LAYER,
      `layer ${L} drew ${g.param.plot.length} traces, not one per channel`);
    g.param.plot.forEach(function (p) {
      assert.strictEqual(p.line.draw, true, "a channel was drawn without its line");
      assert.strictEqual(p.xData.length, DEPTH, "a channel lost points");
      // Markers as well, so a channel hit once in the window is still visible.
      assert.strictEqual(p.marker.draw, true, "a single-point channel would vanish");
      // The line takes `color` and the marker takes lineColor/fillColor:
      // mplot's drawMarker() reads those two and ignores anything else, so a
      // marker given `color` draws in the default dark and the strip encoding
      // goes missing with no error anywhere. Caught once already on the Scope
      // tab's charge display; pinned here so it cannot come back.
      assert.strictEqual(typeof p.line.color, "string", "a line has no colour");
      assert.strictEqual(p.marker.fillColor, p.line.color,
        "the marker does not carry the strip colour in the key mplot reads");
      assert.strictEqual(p.marker.lineColor, p.line.color);
      assert.strictEqual(p.marker.color, undefined,
        "a marker colour set under the key mplot ignores");
    });
  });
});

test("the x axis is time running back from now, and each line is ordered along it", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const g = graphAt(page, "baseline-plot-L0");
  g.param.plot.forEach(function (p) {
    // Age is seconds *ago*, so the newest point sits at 0 and the past runs to
    // the left. A positive x would draw the run backwards.
    assert.ok(Math.max.apply(null, p.xData) <= 0, "a point is drawn in the future");
    for (let i = 1; i < p.xData.length; i++) {
      assert.ok(p.xData[i] > p.xData[i - 1],
        "a polyline doubles back on itself and would draw as noise");
    }
  });
  assert.strictEqual(g.xMax, 0, "the right-hand end of the axis is not now");
  assert.strictEqual(g.xMin, -WINDOW_S, "the axis is not the fixed window");
});

test("the window is fixed, whatever the ring happens to reach back to", async () => {
  // Fitting the axis to the oldest point made it a different width on every
  // refresh, and a wide one most of the time: channels are hit at very
  // different rates, so one quiet channel dragged the axis out past three
  // minutes and squeezed everything that mattered into the last centimetre.
  // The same distance has to mean the same time on every panel and reload.
  for (const spacing of [0.2, 2.0, 40.0]) {   // reaches back 1.8 s, 18 s, 360 s
    const s = series(N_LAYERS * PER_LAYER, DEPTH);
    s.age = s.age.map((a) => (a / 2.0) * spacing);
    const page = await boot(s, sampicSettings());
    layerGraphs(page).forEach(function (g, L) {
      assert.strictEqual(g.xMin, -WINDOW_S,
        `at ${spacing} s spacing layer ${L} fitted its axis to the data`);
      assert.strictEqual(g.xMax, 0);
    });
  }
});

test("a point outside the window does not stretch the y axis around itself", async () => {
  // A channel that walked three minutes ago is off the left of every panel.
  // Letting it set the y range would stretch all eight around a line nobody
  // can see: the axis would say something had moved and the plot would show
  // nothing that had.
  const s = series(N_LAYERS * PER_LAYER, DEPTH, () => 0.74);
  // One channel, one point, far out of the window and far off the baseline.
  s.channel.push(3); s.value.push(0.2); s.age.push(WINDOW_S * 4);

  const page = await boot(s, sampicSettings());
  const g = graphAt(page, "baseline-plot-L0");
  assert.ok(g.yMin > 0.5,
    `a point ${WINDOW_S * 4} s old dragged the y floor to ${g.yMin}`);
});

test("channels with nothing inside the window are counted, not quietly dropped", async () => {
  // The price of a fixed axis, and the tile has to say it: a quiet channel
  // whose last ten values all predate the window is drawn nowhere at all.
  const s = series(N_LAYERS * PER_LAYER, DEPTH);
  // Push layer 1's channels -- 32 of them -- entirely out of the window.
  for (let i = 0; i < s.channel.length; i++) {
    const ch = s.channel[i];
    if (ch >= PER_LAYER && ch < 2 * PER_LAYER) s.age[i] += WINDOW_S * 2;
  }
  const page = await boot(s, sampicSettings());

  const tile = page.doc.getElementById("baseline_by_channel");
  const text = [...tile.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, new RegExp(`${PER_LAYER} channels older than the window`),
    "the tile does not say how many channels it could not draw");

  // And their panel keeps its axes rather than vanishing.
  const g = graphAt(page, "baseline-plot-L1");
  assert.strictEqual(g.xMin, -WINDOW_S);
  assert.ok(g.yMax > g.yMin);
});

test("one stale channel is one channel, not 1 channels", async () => {
  // Read off the real page on DEMODQM, where exactly one channel had gone
  // quiet and the chip said "1 channels older than the window". A shift screen
  // that cannot count to one is not one anybody trusts at 3am.
  const s = series(N_LAYERS * PER_LAYER, DEPTH);
  for (let i = 0; i < s.channel.length; i++) {
    if (s.channel[i] === 5) s.age[i] += WINDOW_S * 2;
  }
  const page = await boot(s, sampicSettings());
  const tile = page.doc.getElementById("baseline_by_channel");
  const text = [...tile.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /1 channel older than the window/);
  assert.doesNotMatch(text, /1 channels/);
});

test("the chip reads the drawn window, and names the analyzer's separately", async () => {
  // Two different numbers on purpose: the analyzer keeps headroom so a slow
  // fetch never arrives to find the left-hand end already evicted. The one
  // worth reading beside a plot is the one the plot is drawn to.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const tile = page.doc.getElementById("baseline_by_channel");
  const chips = [...tile.walk()].filter((e) => (e.className || "").includes("dqm-chip"));
  const drawn = chips.find((c) => c.textContent.includes("drawn"));
  assert.ok(drawn, "no chip names the drawn window");
  assert.match(drawn.textContent, new RegExp(`${WINDOW_S} s`));
  assert.match(drawn.title || "", /analyzer keeps 120 s/,
    "the chip does not distinguish the analyzer's window from the axis");
});

test("with every channel inside the window the tile says so plainly", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const tile = page.doc.getElementById("baseline_by_channel");
  const text = [...tile.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, new RegExp(`every channel within ${WINDOW_S} s`));
});

test("the window these tests assume is the window the page uses", async () => {
  // Written out above rather than imported: a test that reads the number it is
  // asserting asserts nothing. This is the one place the two are tied, and it
  // needs a booted page first because dqm-hists.js destructures DQMPage at load.
  await boot(series(1, DEPTH), sampicSettings());
  const H = require(path.join(JS, "dqm-hists.js"));
  assert.strictEqual(H.BASELINE_WINDOW_S, WINDOW_S,
    "dqm-hists.js moved the window and these tests still assume the old one");
});

// --- the colour key ---------------------------------------------------------

test("the strip ramp gets a key, built from the ramp the lines use", async () => {
  // There is no legend on the panels and there cannot be one at 32 lines
  // apiece, so the colour is the only thing naming a line and it needs a key.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const key = page.root.byClass("dqm-ramp-key")[0];
  assert.ok(key, "the block has no colour key");
  const swatches = key.byClass("dqm-ramp-swatch");
  // One per strip that is *instrumented*, not per strip the stride allows.
  // The fixture maps 32 channels per layer at a stride of 46, and the ramp
  // spans 0..31 because those are the strips that exist -- spanning 0..45
  // would spend a third of the ramp on colours no channel can have and make
  // every real one darker than the plot draws it.
  assert.strictEqual(swatches.length, PER_LAYER,
    "the key does not have a swatch per instrumented strip");
  assert.ok(PER_LAYER < STRIDE, "the fixture no longer distinguishes the two");

  // The colours are the ramp's own, so the key cannot describe one the plot is
  // not using -- which is the failure a hand-built legend has, and it is worse
  // than no key at all because it is read as authority.
  const geom = require(path.join(JS, "dqm-atar-geom.js"));
  const lo = 0, hi = PER_LAYER - 1;
  assert.strictEqual(swatches[0].style.background, geom.stripColour(lo, lo, hi));
  assert.strictEqual(swatches[hi].style.background, geom.stripColour(hi, lo, hi));
  // And the middle, so a key that only got its ends right still fails.
  const mid = Math.floor(hi / 2);
  assert.strictEqual(swatches[mid].style.background, geom.stripColour(mid, lo, hi));

  // Labelled at both ends, so a colour can be turned back into a strip number.
  const ends = key.byClass("dqm-ramp-end").map((e) => e.textContent);
  assert.deepStrictEqual(ends, [String(lo), String(hi)]);
});

test("the key sits above the panels it explains", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const tile = page.doc.getElementById("baseline_by_channel");
  const body = tile.byClass("dqm-tile-body")[0];
  const kids = body.children;
  const keyAt = kids.findIndex((e) => e.className.includes("dqm-ramp-key"));
  const hostAt = kids.findIndex((e) => e.id === "baseline-layer-panels");
  assert.ok(keyAt >= 0 && hostAt >= 0, "key or panel block missing");
  assert.ok(keyAt < hostAt, "the key is below the block it is a key to");
});

test("with no geometry there is no key, because there are no strips to key", async () => {
  const page = await boot(series(64, DEPTH));
  assert.strictEqual(page.root.byClass("dqm-ramp-key").length, 0,
    "a strip key was drawn for channels that have no strip");
});

test("a reply out of order is still drawn as a line, not a zigzag", async () => {
  // points() emits oldest-first and this does not rely on it: a page that
  // trusts another process's emission order draws a scribble the day it
  // changes, and a scribble reads as a noisy channel.
  const s = series(N_LAYERS * PER_LAYER, DEPTH);
  for (let i = 0; i + 1 < s.age.length; i += 2) {
    const a = s.age[i]; s.age[i] = s.age[i + 1]; s.age[i + 1] = a;
    const v = s.value[i]; s.value[i] = s.value[i + 1]; s.value[i + 1] = v;
  }
  const page = await boot(s, sampicSettings());

  graphAt(page, "baseline-plot-L0").param.plot.forEach(function (p) {
    for (let i = 1; i < p.xData.length; i++) {
      assert.ok(p.xData[i] > p.xData[i - 1], "the reply's order leaked into the polyline");
    }
  });
});

test("all eight panels are drawn against one ruler", async () => {
  // A channel in layer 6 that has walked 40 mV must look different from a flat
  // layer 0 beside it. Per-panel autoscaling gives both the same picture, each
  // filling its own frame, and the comparison down the column -- the reason
  // these are eight panels of one plot -- becomes two different rulers.
  const s = series(N_LAYERS * PER_LAYER, DEPTH, function (ch, k) {
    return ch >= 6 * PER_LAYER && ch < 7 * PER_LAYER ? 0.78 + 0.004 * k : 0.74;
  });
  const page = await boot(s, sampicSettings());

  const gs = layerGraphs(page);
  const first = gs[0];
  gs.forEach(function (g, L) {
    assert.strictEqual(g.yMin, first.yMin, `layer ${L} has its own y floor`);
    assert.strictEqual(g.yMax, first.yMax, `layer ${L} has its own y ceiling`);
    assert.strictEqual(g.xMin, first.xMin, `layer ${L} has its own x floor`);
  });
  // And the ruler actually spans the walk, rather than the flat majority.
  assert.ok(first.yMax > 0.81, `the walked layer is off the top: yMax ${first.yMax}`);
});

test("every plot carries bounds, including the panel with nothing in it", async () => {
  // mplot fills xMin/xMax/yMin/yMax in setData() and its ODB path and nowhere
  // else. draw() then paints the background and returns the moment plot[0].xMin
  // is undefined -- a white panel, no axes, no exception, graph.error still
  // null. A layer nobody has hit is exactly where that lands.
  const s = series(7 * PER_LAYER, DEPTH);    // layer 7 never hit
  const page = await boot(s, sampicSettings());

  layerGraphs(page).forEach(function (g, L) {
    assert.ok(g.param.plot.length > 0, `layer ${L} has no plot at all`);
    g.param.plot.forEach(function (p) {
      for (const k of ["xMin", "xMax", "yMin", "yMax"]) {
        assert.strictEqual(typeof p[k], "number", `layer ${L} left ${k} undefined`);
      }
    });
    assert.ok(g.calcs > 0, `layer ${L} never had calcMinMax() called`);
    assert.ok(g.draws > 0, `layer ${L} was never drawn`);
  });

  // The empty one keeps its panel and says so, rather than disappearing and
  // making the layers renumber themselves between refreshes.
  const empty = graphAt(page, "baseline-plot-L7");
  assert.strictEqual(empty.param.plot.length, 1);
  assert.match(empty.param.plot[0].label, /layer 7/);
});

test("a flat set of channels does not collapse the y axis onto itself", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, () => 0.74),
                          sampicSettings());
  const g = graphAt(page, "baseline-plot-L0");
  assert.ok(g.yMax > g.yMin, "every channel at one voltage flattened the axis to nothing");
});

test("a channel the map does not place gets its own panel rather than being dropped", async () => {
  // 260 channels against a map that covers 256: the last four are on the
  // digitiser and are not ATAR strips, and a page that dropped them would be
  // hiding channels from the tile that exists to show channels.
  const page = await boot(series(N_LAYERS * PER_LAYER + 4, DEPTH), sampicSettings());

  const solo = page.doc.getElementById("baseline-plot-all");
  assert.strictEqual(solo.hidden, false, "the unmapped channels were drawn nowhere");
  assert.strictEqual(solo.mpg.param.plot.length, 4);
  assert.strictEqual(page.doc.getElementById("baseline-unmapped-head").hidden, false);
});

test("with every channel placed, the unmapped panel stays out of the way", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  assert.strictEqual(page.doc.getElementById("baseline-plot-all").hidden, true);
  assert.strictEqual(page.doc.getElementById("baseline-unmapped-head").hidden, true);
});

test("with no geometry it is one panel and says why, rather than eight invented ones", async () => {
  const page = await boot(series(64, DEPTH));      // no SAMPIC settings at all

  assert.strictEqual(page.doc.getElementById("baseline-layer-panels").byClass("dqm-plot").length, 0,
    "layers were invented out of a map that is not there");
  const solo = page.doc.getElementById("baseline-plot-all");
  assert.strictEqual(solo.hidden, false, "no geometry left the tile blank");
  assert.strictEqual(solo.mpg.param.plot.length, 64, "a line per channel, on one panel");

  const tile = page.doc.getElementById("baseline_by_channel");
  const text = [...tile.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /Equipment\/SAMPIC\/Settings/,
    "the tile does not say which key it wanted");
});

// --- the tile beside it -----------------------------------------------------

test("noise is still a scatter against channel, which is its own question", async () => {
  // Changing the baseline tile must not drag this one with it: what is asked
  // of noise is which channel is louder than its neighbours, a comparison
  // across the channel axis that reads best with that axis on the plot.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const tile = page.doc.getElementById("noise_by_channel");
  assert.ok(tile, "the noise tile is gone");
  const div = tile.byClass("dqm-plot")[0];
  assert.ok(div && div.mpg, "the noise tile drew nothing");
  const p = div.mpg.param.plot[0];
  assert.strictEqual(p.line.draw, false, "noise grew a line across the channel axis");
  assert.strictEqual(p.marker.draw, true);
  // One trace for every channel, not one per channel: this tile's x axis is
  // the channel, which is what the baseline block gave up to get a time axis.
  assert.strictEqual(div.mpg.param.plot.length, 1);
});

// --- naming the outlier -----------------------------------------------------
//
// The gap these two close: the plot says "something is out of family, in layer
// 5, somewhere in the green middle" and stops there. What a shifter acts on is
// the global channel number, because that is what the ODB, the frontend and the
// cable map speak.

test("each trace carries its channel as data, not only inside its label", async () => {
  // The hover readout reads the channel back off the trace it is pointing at.
  // Parsing it out of the label would make the wording of a display string
  // load-bearing, and a label reworded for humans would break the readout.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const g = graphAt(page, "baseline-plot-L4");
  g.param.plot.forEach(function (p) {
    assert.strictEqual(typeof p.dqmChannel, "number", "a trace has no channel on it");
    assert.strictEqual(p.dqmLayer, 4, "a trace is on the wrong layer's panel");
    assert.strictEqual(ATARGeom.layerOf(null, 0), null);   // map-less call is safe
    assert.ok(p.label.includes(`ch ${p.dqmChannel}`), "label and data disagree");
  });
});

test("the hover hook names a function that exists", async () => {
  // mplot resolves this by eval()ing the name from its own scope, so a typo is
  // a tooltip that never appears and never errors -- the exact class of silent
  // failure this page set keeps getting caught by.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const div = page.doc.getElementById("baseline-plot-L4");
  const name = div.dataset.tooltip;
  assert.ok(name, "no tooltip hook on the plot div");
  assert.strictEqual(typeof globalThis.window[name], "function",
    `the div names ${name} and no such function is on the global`);
});

test("hovering names the channel at the pointer and the rest in the readout", async () => {
  // Split on purpose. mplot draws its label to the right of the cursor and
  // flips it to sx - 10 - w if that would overflow the right edge, with no
  // matching check against the LEFT edge -- so a label wider than the plot is
  // clipped wherever it lands. Four panels to a row leaves about 185px of
  // plot, and the full sentence is nearer 270.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const g = graphAt(page, "baseline-plot-L4");
  const tip = globalThis.window[
    page.doc.getElementById("baseline-plot-L4").dataset.tooltip];

  // What mplot hands the function: the trace it found and the point on it.
  const idx = 9;
  g.marker = { graphIndex: idx, x: -12, y: 0.7382 };
  const label = tip(g);
  const plot = g.param.plot[idx];

  // On the canvas: the channel and what it reads, and nothing else.
  assert.match(label, new RegExp(`ch ${plot.dqmChannel}\\b`), "no channel at the pointer");
  assert.match(label, /0\.7382 V/, "no value at the pointer");
  // 12px sans-serif is a shade over 6px a character, and mplot adds 6px of
  // padding. Pinned as a character budget because the failure it guards is a
  // label silently running off the edge of a panel, with nothing in the
  // console and the plot looking fine.
  assert.ok(label.length <= 24,
    `the pointer label is ${label.length} chars and will be clipped: "${label}"`);

  // In the readout, which is ordinary DOM and cannot be clipped: the lot.
  const readout = page.root.byClass("dqm-readout")[0];
  assert.ok(readout, "no readout line");
  assert.match(readout.textContent, new RegExp(`ch ${plot.dqmChannel}\\b`));
  assert.match(readout.textContent, /layer 4/, "no layer named");
  assert.match(readout.textContent, new RegExp(`strip ${plot.dqmStrip}\\b`));
  assert.match(readout.textContent, /0\.7382 V/);
  assert.match(readout.textContent, /12 s ago/, "no age");
});

test("the readout keeps the last channel hovered rather than blanking", async () => {
  // Reading a channel number and then looking down at the ranking should not
  // blank the number you just went to get.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const g = graphAt(page, "baseline-plot-L4");
  const tip = globalThis.window.dqmBaselineTip;
  g.marker = { graphIndex: 3, x: -5, y: 0.74 };
  tip(g);
  const after = page.root.byClass("dqm-readout")[0].textContent;
  assert.match(after, /ch \d+/);
  // Nothing clears it; a later draw with no marker never calls the function.
  assert.strictEqual(page.root.byClass("dqm-readout")[0].textContent, after);
});

test("the readout says what to do before anything has been hovered", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  assert.match(page.root.byClass("dqm-readout")[0].textContent, /Hover a point/);
});

test("hovering a placeholder does not print ch undefined", async () => {
  // A layer with nothing in it carries a trace with no channel on it.
  const page = await boot(series(7 * PER_LAYER, DEPTH), sampicSettings());
  const g = graphAt(page, "baseline-plot-L7");
  const tip = globalThis.window.dqmBaselineTip;
  g.marker = { graphIndex: 0, x: -3, y: 0.74 };
  const text = tip(g);
  assert.doesNotMatch(text, /undefined/, `printed "${text}"`);
  assert.match(text, /0\.7400 V/);
  assert.doesNotMatch(page.root.byClass("dqm-readout")[0].textContent, /undefined/);
});

// --- the ranking ------------------------------------------------------------

function outlierRows(page) {
  const box = page.doc.getElementById("baseline-outliers");
  assert.ok(box, "no outlier readout");
  const rows = box.byTag ? box.byTag("TR") : [...box.walk()].filter((e) => e.tagName === "TR");
  return rows.slice(1).map((tr) => [...tr.walk()]
    .filter((e) => e.tagName === "TD").map((td) => td.textContent.trim()));
}

test("the channel furthest from the median is named outright, at the top", async () => {
  // ch 137 is layer 4, strip 9 under this fixture's 32-per-layer map.
  const s = series(N_LAYERS * PER_LAYER, DEPTH,
                   (ch) => (ch === 137 ? 0.80 : 0.74));
  const page = await boot(s, sampicSettings());

  const rows = outlierRows(page);
  assert.ok(rows.length > 0, "the ranking is empty");
  assert.deepStrictEqual(rows[0].slice(0, 3), ["ch 137", "4", "9"],
    `top row was ${JSON.stringify(rows[0])}`);
  assert.match(rows[0][3], /0\.8000 V/);
  // +60 mV above a median of 0.74, and signed: which way it went is half the
  // diagnosis.
  assert.match(rows[0][4], /^\+60\.0 mV$/, `delta read "${rows[0][4]}"`);
});

test("one dead channel does not drag the median and indict everybody else", async () => {
  // The median, not the mean, on both axes of the ranking. A single channel
  // stuck at 0 V moves a mean of 256 by 3 mV -- enough to make a page of
  // healthy channels all look slightly out.
  const s = series(N_LAYERS * PER_LAYER, DEPTH,
                   (ch) => (ch === 200 ? 0.0 : 0.74));
  const page = await boot(s, sampicSettings());

  const box = page.doc.getElementById("baseline-outliers");
  const head = [...box.walk()].map((e) => e._text || "").join(" ");
  assert.match(head, /Furthest from the median \(0\.7400 V\)/,
    "the dead channel moved the reference");

  const rows = outlierRows(page);
  assert.deepStrictEqual(rows[0].slice(0, 1), ["ch 200"]);
  // Everyone else is exactly on the median, so their delta is zero.
  rows.slice(1).forEach(function (r) {
    assert.match(r[4], /^[+-]?0\.0 mV$/, `a healthy channel reads ${r[4]}`);
  });
});

test("a whole layer sagging shows as rows sharing one layer number", async () => {
  // Ranked against the median of every channel rather than of its own layer,
  // precisely so this case survives. Against a per-layer median it would
  // cancel out and the table would show nothing at all.
  const s = series(N_LAYERS * PER_LAYER, DEPTH,
                   (ch) => (ch >= 6 * PER_LAYER && ch < 7 * PER_LAYER ? 0.70 : 0.74));
  const page = await boot(s, sampicSettings());

  const rows = outlierRows(page);
  const layers = new Set(rows.map((r) => r[1]));
  assert.deepStrictEqual([...layers], ["6"],
    `the sagging layer did not fill the table: ${JSON.stringify(rows)}`);
  rows.forEach((r) => assert.match(r[4], /^-40\.0 mV$/));
});

test("the ranking states a fact and passes no verdict", async () => {
  // This page set refused to build channel_health because "dead, noisy or
  // drifting" is a verdict, not a histogram, and synthesising one would mean
  // inventing thresholds nobody specified. A ranking stays the right side of
  // that line only for as long as it stays uncoloured: the moment a row goes
  // yellow, the tile has asserted a threshold.
  const s = series(N_LAYERS * PER_LAYER, DEPTH,
                   (ch) => (ch === 137 ? 0.80 : 0.74));
  const page = await boot(s, sampicSettings());
  const box = page.doc.getElementById("baseline-outliers");

  [...box.walk()].forEach(function (e) {
    assert.ok(!/\b(warn|alarm|red|yellow)\b/.test(e.className || ""),
      `the ranking colours a row (${e.className}), which asserts a threshold`);
  });
  const text = [...box.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /A ranking, not a verdict/);
});

test("a channel outside the window is not ranked, because it has no line", async () => {
  // Ranking it on values nobody can see would put a channel in the table that
  // is not in the picture.
  const s = series(N_LAYERS * PER_LAYER, DEPTH,
                   (ch) => (ch === 137 ? 0.80 : 0.74));
  for (let i = 0; i < s.channel.length; i++) {
    if (s.channel[i] === 137) s.age[i] += WINDOW_S * 2;
  }
  const page = await boot(s, sampicSettings());

  const rows = outlierRows(page);
  rows.forEach((r) => assert.notStrictEqual(r[0], "ch 137",
    "a channel with no line on any panel was ranked"));
});

test("with nothing in the window the ranking says so rather than inventing one", async () => {
  const s = series(N_LAYERS * PER_LAYER, DEPTH);
  s.age = s.age.map((a) => a + WINDOW_S * 4);
  const page = await boot(s, sampicSettings());

  const box = page.doc.getElementById("baseline-outliers");
  const text = [...box.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /nothing to rank/);
});
