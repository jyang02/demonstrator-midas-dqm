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
  return { title: "baseline", unit: "V", depth: depth, channels: nch,
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

test("the baseline tile is eight panels, two columns and so four rows", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const host = page.doc.getElementById("baseline-layer-panels");
  assert.ok(host, "the baseline tile built no layer block");
  assert.ok(host.className.includes("dqm-layer-grid"),
    "the block is not in the two-column grid the waveforms use");

  // Two columns, and the grid is what makes eight panels four rows: asserting
  // the count alone would pass on a single stack of eight.
  const even = page.doc.getElementById("baseline-col-even");
  const odd = page.doc.getElementById("baseline-col-odd");
  assert.ok(even && odd, "the block is not split into even and odd columns");
  assert.strictEqual(even.byClass("dqm-plot").length, 4, "four rows in the left column");
  assert.strictEqual(odd.byClass("dqm-plot").length, 4, "four rows in the right column");

  // Even layers left, odd right, which is what puts one strip orientation down
  // each column -- the same convention the Scope tab reads.
  for (let L = 0; L < N_LAYERS; L++) {
    const div = page.doc.getElementById(`baseline-plot-L${L}`);
    assert.ok(div, `layer ${L} got no panel`);
    const wanted = L % 2 === 0 ? even : odd;
    assert.strictEqual(div.parent, wanted,
      `layer ${L} is in the wrong column, so the columns are not by orientation`);
  }
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
  assert.strictEqual(g.xMin, -(DEPTH - 1) * 2.0, "the axis does not reach the oldest point");
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
