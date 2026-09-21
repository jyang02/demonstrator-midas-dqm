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
//: Values per channel in the fixtures. Deep enough that its ages, which run
//: 0..(DEPTH-1)*2 s in steps of 2, STRADDLE the default recent window --
//: otherwise every test below draws a short window holding the whole
//: fixture and cutting nothing. The guard at the bottom of this file pins
//: that relationship, so moving the default is what sends you here.
const DEPTH = 20;
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

/**
 * A dqm::histogram reply for a 1-D per-channel histogram.
 *
 * One bin per channel, which is the analyzer's `chan()` axis, plus the under-
 * and overflow cells the wire format always carries. Neither can hold anything
 * for a channel axis, so they are zero here and the tile is entitled to ignore
 * them.
 */
function occupancy(nch, countAt) {
  const data = [0];
  for (let ch = 0; ch < nch; ch++) data.push(countAt ? countAt(ch) : 100);
  data.push(0);
  const entries = data.reduce((a, b) => a + b, 0);
  return { dimensions: 1, nBins: [nch], lowEdge: [0], highEdge: [nch],
           entries: entries, data: data };
}

/**
 * Boot the ATAR page on its Channels tab with one canned series reply.
 *
 * `cfgExtra` overrides keys of the ATAR subtree, which is how the noise tile's
 * two window settings are exercised: they are read from the config at build,
 * the same as every other page-side setting.
 */
async function boot(reply, odbExtra, histReply, cfgExtra) {
  const cfg = Object.assign({}, globalThis.DQM.DEFAULTS.ATAR, cfgExtra || {});
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
  // The histogram tiles share this tab and are mostly not what these tests are
  // about. Left pending rather than rejected: a rejection would have
  // AutoUpdater console.error once per tile per boot, and a screenful of that
  // in a passing run is how a real error stops being noticed. A test that IS
  // about one of them passes a reply.
  globalThis.BRPC.histogram = histReply
    ? async () => histReply
    : () => new Promise(() => {});

  await page.load();          // Channels is the first tab, so it is built here
  await settle(page);
  return page;
}

// --- both map tiles, which are one renderer ---------------------------------
//
// noise_by_channel and baseline_by_channel are the same function with a
// different series, a different pair of window keys and a different idea of
// what "out of family" means. Most of what follows is written against the noise
// tile because that is where the design was worked out; this block is the part
// that has to hold for BOTH, so it is parametrised over the two slugs. A
// property asserted of only one of them is a property the shared renderer can
// lose on the other without anything failing.

const MAP_TILES = [
  { slug: "noise", panel: "noise_by_channel",
    longKey: "Noise Window Seconds", shortKey: "Noise Recent Seconds" },
  { slug: "baseline", panel: "baseline_by_channel",
    longKey: "Baseline Window Seconds", shortKey: "Baseline Recent Seconds" },
];

for (const tile of MAP_TILES) {
  test(`${tile.slug}: three maps of one cell per channel, placed by strip and layer`, async () => {
    const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

    ["avg", "now", "diff"].forEach(function (kind) {
      const cells = cellsOf(page, `${tile.slug}-map-${kind}`);
      assert.strictEqual(cells.length, N_LAYERS * PER_LAYER,
        `${tile.slug}-map-${kind} is not a cell per channel`);
    });
    // Placed by the map, not by the channel number: row 4 is layer 4.
    const c = cellFor(page, `${tile.slug}-map-avg`, 137);
    assert.strictEqual(c.dataset.layer, "4");
    assert.strictEqual(c.dataset.strip, "9");
  });

  test(`${tile.slug}: both windows come from its own keys`, async () => {
    // A pair per tile, so narrowing one to chase something does not silently
    // move the other. The whole point of two pairs is that this test can set
    // one tile's windows and assert the other's did not follow.
    const other = MAP_TILES.find((t) => t.slug !== tile.slug);
    const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
      undefined, { [tile.longKey]: 16.0, [tile.shortKey]: 4.0 });

    const mine = textOf(page.doc.getElementById(tile.panel));
    assert.match(mine, /Average over the last 16 s/);
    assert.match(mine, /Average over the last 4 s/);

    const theirs = textOf(page.doc.getElementById(other.panel));
    assert.match(theirs, /Average over the last 120 s/,
      `setting the ${tile.slug} windows moved the ${other.slug} tile's`);
    assert.match(theirs, /Average over the last 30 s/);
  });

  test(`${tile.slug}: each window offers the ODB path that sets it`, async () => {
    const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

    const buttons = page.doc.getElementById(tile.panel).byClass("mbutton");
    assert.ok(buttons.length >= 2, "the two windows do not both offer an Edit");
    buttons.slice(0, 2).forEach((b) => b.dispatch("click"));
    // The stub records dlgOdbEdit's argument as `params`, a bare path string.
    const asked = page.calls.filter((c) => c.method === "dlgOdbEdit")
      .map((c) => c.params);
    assert.deepStrictEqual(asked,
      [`/DQM/ATAR/${tile.longKey}`, `/DQM/ATAR/${tile.shortKey}`]);
  });

  test(`${tile.slug}: a channel with nothing in the long window is absent, not zero`, async () => {
    // The analyzer evicts on the way out, so a channel missing from the reply
    // is one nobody hit -- which a quiet beam produces exactly as readily as a
    // fault, and this tile cannot tell the two apart. Blank, hatched, and never
    // the bottom of the ramp.
    const s = series(N_LAYERS * PER_LAYER, DEPTH);
    const drop = 42;
    const keep = s.channel.map((c, i) => (c === drop ? -1 : i)).filter((i) => i >= 0);
    const page = await boot(Object.assign({}, s, {
      channel: keep.map((i) => s.channel[i]),
      value: keep.map((i) => s.value[i]),
      age: keep.map((i) => s.age[i]),
    }), sampicSettings());

    ["avg", "now", "diff"].forEach(function (kind) {
      const c = cellFor(page, `${tile.slug}-map-${kind}`, drop);
      assert.ok(c.classList.contains("dqm-heat-nodata"),
        `${tile.slug}-map-${kind} painted an absent channel`);
      assert.strictEqual(c.style.background, "");
      assert.doesNotMatch(c.title, /dead/i);
    });
  });

  test(`${tile.slug}: hovering a cell names the channel, and only its own readout`, async () => {
    // Two tiles run this renderer on one tab. A shared readout would let
    // whichever answered first take the other's hover line -- a race, not an
    // ordering -- so each closes over its own.
    const other = MAP_TILES.find((t) => t.slug !== tile.slug);
    const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

    cellFor(page, `${tile.slug}-map-avg`, 137).dispatch("mouseenter");
    const said = page.doc.getElementById(`${tile.slug}-readout`).textContent;
    assert.match(said, /ch 137/);
    assert.match(said, /layer 4/);
    assert.match(said, /strip 9/);
    assert.doesNotMatch(said, /undefined/);

    assert.match(page.doc.getElementById(`${other.slug}-readout`).textContent,
      /Hover a cell/, `the ${tile.slug} tile wrote into the ${other.slug} readout`);
  });

  test(`${tile.slug}: the ranking names channels and passes no verdict`, async () => {
    // A cell carries no label, and the channel number is what the ODB, the
    // frontend, the cable map and the elog all speak. `channel_health` is left
    // unclaimed on Proposed because "dead, noisy or drifting" is a verdict
    // rather than a histogram, and the same reasoning holds here: there is no
    // threshold, and on a healthy run these are simply the five least average
    // channels.
    const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH,
      (ch, k) => 0.7 + ch * 0.001), sampicSettings());

    const box = page.doc.getElementById(`${tile.slug}-outliers`);
    const text = textOf(box);
    assert.match(text, /ch \d+/, "the ranking names no channel");
    assert.match(text, /ranking, not a verdict/);
    box.byTag("tr").forEach(function (row) {
      assert.doesNotMatch(row.className, /warn|alarm|red|yellow/,
        "the ranking grew a verdict");
    });
    // Both column heads name the window they are drawn over, because a table
    // beside a map that named a different window would be worse than no head.
    assert.match(text, /avg 120 s/);
    assert.match(text, /recent 30 s/);
  });

  test(`${tile.slug}: with no geometry it is one row and says which key it wanted`, async () => {
    // A pixel id decodes only under the base and stride it was made with, so a
    // missing map is a caveat on the view and never a guess.
    const page = await boot(series(64, DEPTH));

    const panel = page.doc.getElementById(tile.panel);
    assert.match(textOf(panel), /Equipment\/SAMPIC\/Settings/,
      "the tile does not say which key it wanted");
    assert.ok(panel.byClass("yellow").length > 0,
      "a missing map was reported as a fault rather than a caveat");
    // Nothing dropped for want of a place to put it.
    assert.strictEqual(cellsOf(page, `${tile.slug}-map-avg`).length, 64);
  });
}

/** The channel column of the first ranking table in a box, top row first.
 *
 *  The first, because a ranking box holds two tables and the second one's
 *  header row carries th and no td -- indexing across both reads a header as a
 *  row and comes back undefined.
 */
function firstRanked(box) {
  return box.byTag("table")[0].byTag("tr").slice(1)
    .map((r) => r.byTag("td")[0].textContent);
}

// --- what the two tiles do NOT share ----------------------------------------

test("noise ranks by the highest RMS, because loud is high and only high", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH,
    (ch, k) => (ch === 200 ? 0.9 : 0.1)), sampicSettings());

  const box = page.doc.getElementById("noise-outliers");
  assert.match(textOf(box), /Loudest over the last 120 s/);
  // The first table. The box holds two, and the second one's header row has no
  // td cells to index.
  const first = firstRanked(box)[0];
  assert.strictEqual(first, "ch 200", "the loudest channel is not at the top");
});

test("the baseline maps carry one ranking, and it is the shared one", async () => {
  // "Which baseline is out of family" is answered by the map, not by a second
  // table: a baseline away from where the others sit is a cell that is not the
  // colour of its neighbours, on a scale spanning every channel. That leaves
  // the one question a table adds a channel number to.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH,
    (ch, k) => (ch === 200 ? 0.70 : 0.74)), sampicSettings());

  const box = page.doc.getElementById("baseline-outliers");
  assert.strictEqual(box.byClass("dqm-subhead").length, 1,
    "the baseline tile has more than one ranking");
  assert.strictEqual(box.byTag("table").length, 1);
  assert.match(box.byClass("dqm-subhead")[0].textContent, /^Moved most/);

  const text = textOf(box);
  assert.doesNotMatch(text, /median/i, "the median ranking is still in the tile");
  assert.doesNotMatch(text, /Furthest/);
  // It still names channels, which is the whole reason a table sits under a
  // grid of unlabelled cells.
  assert.match(text, /ch \d+/);
  assert.match(text, /ranking, not a verdict/);
});

test("noise keeps both of its rankings", async () => {
  // The shared table is common to both tiles; the loudest table is the noise
  // tile's own. Dropping the baseline's must not have dropped this one.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH,
    (ch, k) => (ch === 200 ? 0.9 : 0.1)), sampicSettings());

  const box = page.doc.getElementById("noise-outliers");
  const heads = box.byClass("dqm-subhead").map((h) => h.textContent);
  assert.strictEqual(heads.length, 2);
  assert.match(heads[0], /^Loudest/);
  assert.match(heads[1], /^Moved most/);
});



// --- how much prose a tile carries ------------------------------------------

test("a tile that draws does not also print why it exists; an empty one does", async () => {
  // `why` describes itself as what an empty tile most needs to carry, and that
  // is also the argument against printing it under a tile already showing the
  // answer: a page of plots each with a paragraph attached is a page people
  // stop reading, including the paragraphs that matter. It moves to the
  // heading, where it costs a hover rather than a column inch.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
    occupancy(N_LAYERS * PER_LAYER, (ch) => 100 + ch));

  const drew = page.doc.getElementById("atar_occupancy");
  const feet = drew.byClass("dqm-footnote").map((f) => f.textContent).join(" ");
  assert.doesNotMatch(feet, /Why this panel exists/,
    "a drawing tile still prints the paragraph about why it is there");
  // Reachable, not deleted.
  const head = drew.byClass("dqm-tile-title")[0];
  assert.match(head.title, /Why this panel exists/,
    "the why is neither printed nor reachable");

  // A panel nothing draws keeps it in the page, which is the case it is for.
  page.doc.getElementById("tab-atar_proposed").dispatch("click");
  const empty = page.doc.getElementById("channel_health");
  assert.ok(empty, "no unclaimed panel to check");
  const emptyFeet = empty.byClass("dqm-footnote").map((f) => f.textContent).join(" ");
  assert.match(emptyFeet, /Why this panel exists/,
    "a tile that cannot answer for itself dropped the line saying what it was for");
});

// --- occupancy as the target ------------------------------------------------
//
// The tile answers "is the beam hitting the target where we put it", which the
// global-channel axis cannot: that axis is the readout order, so a spot in one
// corner arrives as four disconnected clumps of bars.

const NCH = N_LAYERS * PER_LAYER;

function occCells(page) {
  return page.doc.getElementById("occupancy-grid").byClass("dqm-heat-cell")
    .filter((c) => c.dataset.ch !== undefined);
}

function occCell(page, ch) {
  return occCells(page).find((c) => c.dataset.ch === String(ch));
}

test("occupancy is a cell per channel, placed by strip and layer", async () => {
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => 100 + ch));

  assert.strictEqual(occCells(page).length, NCH);
  // The same placement the noise maps use, which is the point of sharing the
  // grid: a column is the same strip on both tiles.
  const c137 = occCell(page, 137);
  assert.strictEqual(c137.dataset.layer, "4");
  assert.strictEqual(c137.dataset.strip, "9");
  assert.deepStrictEqual(occCells(page).map((c) => c.dataset.ch),
    page.doc.getElementById("noise-map-avg").byClass("dqm-heat-cell")
      .filter((c) => c.dataset.ch !== undefined).map((c) => c.dataset.ch),
    "the two tiles place the channels differently, so a column is not one strip");
});

test("the occupancy scale starts at zero, not at the quietest channel", async () => {
  // Counts are a ratio quantity: half the hits means half the hits. A scale
  // fitted to the minimum would put the quietest channel at the bottom of the
  // ramp whether it took nine hundred hits or none, which is the distinction
  // this tile exists to make.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, () => 900));

  const scale = page.doc.getElementById("occupancy-grid").dqmScale;
  assert.strictEqual(scale.lo, 0,
    "the scale was fitted to the data and 900 hits would read as 'none'");
  // Every channel equally busy must therefore NOT come out at the bottom.
  assert.notStrictEqual(occCell(page, 0).style.background, ATARGeom.heatColour(0),
    "a uniformly busy target was drawn as a uniformly dead one");
});

test("a channel with no hits is blank, not the darkest end of the ramp", async () => {
  // "Never hit" and "hardly hit" are a dead channel and a live one, and the
  // bottom of a ramp cannot say which. Distinct again from the noise maps'
  // no-data hatch: occupancy is never told nothing, it is told zero.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => (ch === 77 ? 0 : 500)));

  const dead = occCell(page, 77);
  assert.ok(dead.classList.contains("dqm-heat-zero"));
  assert.ok(!dead.classList.contains("dqm-heat-nodata"),
    "a measured zero was drawn as an absence of information");
  assert.notStrictEqual(dead.style.background, ATARGeom.heatColour(0));
  assert.match(dead.title, /no hits this run/);
  // Never "dead": a channel outside the beam spot takes nothing either, and
  // where the cell sits is what tells those apart.
  assert.doesNotMatch(dead.title, /dead/i);

  const alive = occCell(page, 78);
  assert.ok(!alive.classList.contains("dqm-heat-zero"));
  assert.ok(alive.style.background);
});

test("the quietest channels are named, and the count of silent ones is said", async () => {
  // The busy end of this map is legible already -- a spot is bright. The quiet
  // end is a field of dark cells in which the one that took nothing looks like
  // its neighbours that took three, and that is the end with a fault in it.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => (ch === 12 ? 0 : (ch === 13 ? 1 : 500))));

  const box = page.doc.getElementById("occupancy-outliers");
  const text = textOf(box);
  assert.match(text, /ch 12/, "the silent channel is not named");
  assert.match(text, /ch 13/, "the next quietest is not named");
  assert.match(text, /1 took nothing at all/);
  assert.match(text, /ranking, not a verdict/);
  box.byTag("tr").forEach(function (row) {
    assert.doesNotMatch(row.className, /warn|alarm|red|yellow/,
      "the ranking grew a verdict");
  });
});

test("the busiest channels are named beside the quietest", async () => {
  // Both ends, because they fail differently: the quiet end needs a ranking to
  // be found at all, and the busy end is an obvious shape whose top channel is
  // still not something a colour ramp names -- least of all when the scale is
  // clipped and several cells are drawn at the fence.
  // Distinct counts, so the two ends are genuinely different channels: ch 0 is
  // silent, ch 255 is the busiest, and nothing ties.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => ch * 10));

  const box = page.doc.getElementById("occupancy-outliers");
  const cols = box.byClass("dqm-rank-col");
  assert.strictEqual(cols.length, 2, "the two rankings are not two columns");

  // Side by side, not stacked: one flex row holding both.
  const row = box.byClass("dqm-rank-row");
  assert.strictEqual(row.length, 1);
  assert.strictEqual(row[0].byClass("dqm-rank-col").length, 2);

  // Quietest stays where it was; busiest is the one that was added next to it.
  assert.match(textOf(cols[0]), /Quietest channels/);
  assert.match(textOf(cols[1]), /Busiest channels/);
  assert.match(textOf(cols[0]), /ch 0\b/, "the silent channel left the quiet table");
  assert.match(textOf(cols[1]), /ch 255\b/, "the busiest channel is not named");
  assert.match(textOf(cols[1]), /2550/, "the busiest channel's count is not shown");
  // The busy table must not be the quiet one over again.
  assert.doesNotMatch(textOf(cols[1]), /ch 0\b/);

  // Same columns on both, which is what makes them comparable at a glance.
  const heads = cols.map((c) => c.byTag("th").map((h) => h.textContent).join(","));
  assert.strictEqual(heads[0], heads[1]);

  // Descending, so the top of the run is the first row a reader lands on.
  const counts = cols[1].byTag("tr").slice(1)
    .map((r) => Number(r.byTag("td")[3].textContent));
  assert.deepStrictEqual(counts, counts.slice().sort((a, b) => b - a));
});

test("neither occupancy ranking grows a verdict", async () => {
  // No threshold here: a channel at the top is busy because the beam is on it,
  // and one at the bottom is quiet because it is not. Both are facts about the
  // run rather than about the channel.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => ch * 10));

  const box = page.doc.getElementById("occupancy-outliers");
  box.byTag("tr").forEach(function (row) {
    assert.doesNotMatch(row.className, /warn|alarm|red|yellow/,
      "the ranking grew a verdict");
  });
  assert.match(textOf(box), /ranking, not a verdict/);
  // Distinct counts, so the two ends are different channels and the footnote
  // says nothing about rows appearing in both.
  const foot = box.byClass("dqm-footnote")[0];
  assert.doesNotMatch(foot.title || "", /appear in both/);
});

test("a flat run says its two ends are the same channels, not a finding", async () => {
  // The case the previous test rules out, which a real run reaches whenever
  // the beam is off: every channel on the same count, so the two ends are
  // decided by the tie-break -- document order -- and five arbitrary channels
  // would otherwise read as five quiet ones and five busy ones.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, () => 500));

  const box = page.doc.getElementById("occupancy-outliers");
  const foot = box.byClass("dqm-footnote")[0];
  assert.match(foot.title || "", /appear in both tables/);
  assert.match(foot.title || "", /not\s+a measurement/);
});

test("hovering an occupancy cell names the channel and does not touch the other readouts", async () => {
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => 100 + ch));

  occCell(page, 137).dispatch("mouseenter");
  const said = page.doc.getElementById("occupancy-readout").textContent;
  assert.match(said, /ch 137/);
  assert.match(said, /layer 4/);
  assert.match(said, /strip 9/);
  assert.match(said, /hits/);
  assert.doesNotMatch(said, /undefined/);

  assert.match(page.doc.getElementById("noise-readout").textContent,
    /Hover a cell/, "the occupancy tile wrote into the noise readout");
  assert.match(page.doc.getElementById("baseline-readout").textContent,
    /Hover a cell/, "the occupancy tile wrote into the baseline readout");
});

test("occupancy and hits per event come first, and are sized to share a row", async () => {
  // The layout itself is flex-wrap and the stub has no layout, so what is
  // pinned here is the contract the CSS keys off: the two tiles that answer
  // "is the beam there at all" are the first two, and both carry the size
  // class that lets a row hold two of them. A size of l would silently take a
  // full row each and put a screen height between them.
  const page = await boot(series(NCH, DEPTH), sampicSettings(),
    occupancy(NCH, (ch) => 100 + ch));

  const tab = page.doc.getElementById("tabpanel-atar_channels");
  const panels = tab.byClass("dqm-panel").map((e) => e.id);
  assert.deepStrictEqual(panels.slice(0, 2), ["atar_occupancy", "hits_per_event"],
    `the Channels tab opens with ${panels.slice(0, 2).join(", ")}`);
  ["atar_occupancy", "hits_per_event"].forEach(function (id) {
    assert.ok(page.doc.getElementById(id).classList.contains("dqm-tile-m"),
      `${id} is not sized to share a row`);
  });
  // And the tiles that need the full width still say so.
  assert.ok(page.doc.getElementById("noise_by_channel").classList.contains("dqm-tile-l"));
});

// --- the tile beside it: noise as a map of the target ------------------------
//
// Three grids of one div per channel, placed by strip and layer. What these
// pin is not the colour of any cell but the three readings a colour cannot
// carry -- absent, stale and seen-once -- because those are the states a
// colormap would have painted as "low", which is the reason the tile is divs.
//
// Text is read with walk() and _text rather than textContent throughout: the
// page clears a box with `textContent = ""` before refilling it, and the stub's
// getter returns that empty string in preference to its children.

//: The noise tile's two window defaults, written out rather than imported: a
//: test that reads the number it is asserting asserts nothing.
const NOISE_LONG = 120.0;
const NOISE_SHORT = 30.0;

function textOf(node) {
  return [...node.walk()].map((e) => e._text || "").join(" ");
}

/** The channel cells of one map, in document order. Row and axis labels are
 *  not cells and positions with no channel carry no ch. */
function cellsOf(page, id) {
  return page.doc.getElementById(id).byClass("dqm-heat-cell")
    .filter((c) => c.dataset.ch !== undefined);
}

function cellFor(page, id, ch) {
  return cellsOf(page, id).find((c) => c.dataset.ch === String(ch));
}

/** The same reply with every value on `ch` older than `maxAge` taken away. */
function onlyRecent(s, ch, maxAge) {
  const out = Object.assign({}, s, { channel: [], value: [], age: [] });
  for (let i = 0; i < s.channel.length; i++) {
    if (s.channel[i] === ch && s.age[i] > maxAge) continue;
    out.channel.push(s.channel[i]);
    out.value.push(s.value[i]);
    out.age.push(s.age[i]);
  }
  return out;
}

/** The same reply with every value on `ch` but the first taken away. */
function seenOnce(s, ch) {
  const out = Object.assign({}, s, { channel: [], value: [], age: [] });
  let kept = false;
  for (let i = 0; i < s.channel.length; i++) {
    if (s.channel[i] === ch) {
      if (kept) continue;
      kept = true;
    }
    out.channel.push(s.channel[i]);
    out.value.push(s.value[i]);
    out.age.push(s.age[i]);
  }
  return out;
}

test("a channel with nothing in the window is not a cell sitting at zero", async () => {
  // The failure this exists for: an absent channel painted as the bottom of the
  // ramp, which reads as "quiet" when what it means is "nobody hit it". The
  // analyzer evicts on the way out, so absent is all the page is ever told --
  // and a quiet beam produces it exactly as readily as a dead channel.
  const page = await boot(series(7 * PER_LAYER, DEPTH), sampicSettings());

  const ch = 7 * PER_LAYER;           // layer 7, strip 0: never in the reply
  ["noise-map-avg", "noise-map-now", "noise-map-diff"].forEach(function (id) {
    const cell = cellFor(page, id, ch);
    assert.ok(cell, `${id} has no cell for channel ${ch}`);
    assert.ok(cell.classList.contains("dqm-heat-nodata"),
      `${id} drew an unhit channel as a measurement`);
    assert.notStrictEqual(cell.style.background, ATARGeom.heatColour(0),
      `${id} painted an absent channel the bottom of the ramp`);
    assert.match(cell.title, /no value in the last/,
      `${id} does not say why the cell is empty`);
    // Never "dead": the tile cannot tell an uninstrumented channel from one
    // that went two minutes without a hit, and must not claim to.
    assert.doesNotMatch(cell.title, /dead/i);
  });

  const hit = cellFor(page, "noise-map-avg", 0);
  assert.ok(!hit.classList.contains("dqm-heat-nodata"),
    "a channel that was hit is drawn as absent");
});

test("the long and the short average are drawn against one scale", async () => {
  // Structural and behavioural, because either alone passes on a coincidence.
  // The point of stacking the maps is that one colour means one RMS in both;
  // two scales fitted independently would make the comparison silently false.
  //
  // Ages in the fixture run 18 s down to 0 in steps of 2, so the default 10 s
  // recent window is the last six values and the 120 s one is all ten.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function (ch, k) {
    if (ch === 0) return k % 2 ? 0.6 : 0.4;      // long average 0.5
    if (ch === 1) return k >= 4 ? 0.5 : 0.1;     // recent average 0.5
    return 0.3;
  }), sampicSettings());

  const avg = page.doc.getElementById("noise-map-avg");
  const now = page.doc.getElementById("noise-map-now");
  const diff = page.doc.getElementById("noise-map-diff");

  assert.ok(avg.dqmScale, "the average map carries no scale");
  assert.deepStrictEqual(avg.dqmScale, now.dqmScale,
    "the two sequential maps are drawn against different scales");
  // The difference is a different quantity and must not be forced onto the
  // sequential ramp: zero is its middle, not its bottom.
  assert.strictEqual(diff.dqmScale, undefined,
    "the difference map was given the sequential scale");
  assert.ok(diff.dqmDiffScale, "the difference map carries no scale of its own");

  // The behavioural half: a long average of 0.5 and a short one of 0.5 are the
  // same colour, which is what "one scale" means to somebody reading the tile.
  assert.strictEqual(cellFor(page, "noise-map-avg", 0).style.background,
                     cellFor(page, "noise-map-now", 1).style.background,
    "equal values got different colours on the two maps");
});

test("a channel with every value inside the short window has nothing to subtract", async () => {
  // The two averages are then the same arithmetic, so their difference is zero
  // by construction and says nothing about whether the channel moved. Painting
  // it as zero would be the opposite reading of the truth.
  //
  // This is what "seen once" generalises to once both windows are settings: one
  // value was only ever a special case of "the long window holds nothing the
  // short one does not".
  const s = onlyRecent(series(N_LAYERS * PER_LAYER, DEPTH), 137, 10);
  const page = await boot(s, sampicSettings());

  const d = cellFor(page, "noise-map-diff", 137);
  assert.ok(d.classList.contains("dqm-heat-single"),
    "a channel with no older values was drawn as a measured difference");
  assert.notStrictEqual(d.style.background, ATARGeom.diffColour(0),
    "it was painted as 'did not move'");
  assert.match(d.title, /zero by construction/);

  // Both averages are perfectly ordinary readings, though, and blanking them
  // would hide real numbers.
  ["noise-map-avg", "noise-map-now"].forEach(function (id) {
    const c = cellFor(page, id, 137);
    assert.ok(!c.classList.contains("dqm-heat-single"), `${id} blanked a real value`);
    assert.ok(!c.classList.contains("dqm-heat-nodata"), `${id} blanked a real value`);
    assert.ok(c.style.background, `${id} left a measured cell unpainted`);
  });
});

test("a channel with nothing in the short window has no recent average at all", async () => {
  // The other empty state, and a different fact: this channel has a standing
  // average and no present. Saying so outright is what makes dimming the cell
  // unnecessary -- a window states "nothing here" rather than asking anyone to
  // read an opacity.
  const s = seenOnce(series(N_LAYERS * PER_LAYER, DEPTH), 137);  // one value, age 38
  const page = await boot(s, sampicSettings());

  const now = cellFor(page, "noise-map-now", 137);
  assert.ok(now.classList.contains("dqm-heat-nodata"),
    "a channel with nothing recent was painted as a measurement");
  assert.strictEqual(now.style.background, "");
  assert.match(now.title, /nothing in the last 30 s/);
  // Never "dead": a quiet channel does this too, and the tile cannot tell them
  // apart.
  assert.doesNotMatch(now.title, /dead/i);

  // The difference has nothing to compare, and says which of the two reasons.
  const d = cellFor(page, "noise-map-diff", 137);
  assert.ok(d.classList.contains("dqm-heat-single"));
  assert.match(d.title, /no recent value to compare/);

  // Its long average is a real reading and stays drawn.
  const avg = cellFor(page, "noise-map-avg", 137);
  assert.ok(!avg.classList.contains("dqm-heat-nodata"), "the long average was blanked");
  assert.ok(avg.style.background);

  // And the chip counts it, because it is the number to watch when deciding
  // whether the recent window is wide enough.
  assert.match(textOf(page.doc.getElementById("noise_by_channel")),
    /1 with nothing in 30 s/);
});

test("both windows come from the config, and every heading says the one it drew", async () => {
  // The point of the pair being settings: a shift chasing something fast wants
  // a short recent window, one watching a slow drift wants a long average, and
  // neither is a number this file can choose. Both cuts are made by the page
  // over the reply the analyzer already sent, so changing either costs nothing.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
    undefined, { "Noise Window Seconds": 16.0, "Noise Recent Seconds": 4.0 });

  const tile = page.doc.getElementById("noise_by_channel");
  const text = textOf(tile);
  // The map headings, which are what a reader actually reads.
  assert.match(text, /Average over the last 16 s/);
  assert.match(text, /Average over the last 4 s/);
  // And the chips, which are where the Edit buttons are.
  assert.match(text, /average over\s+16 s/);
  assert.match(text, /recent over\s+4 s/);

  // The cuts really moved, not just the labels. Ages are 18,16,...,0: a 16 s
  // window holds nine of the ten values and a 4 s window holds three.
  assert.match(cellFor(page, "noise-map-avg", 137).title, /from 9 values over 16 s/);
  assert.match(cellFor(page, "noise-map-now", 137).title, /recent .* from 3 values/);

  // The ranking table agrees with the maps, because a column head that named a
  // different window from the map above it would be worse than no head.
  const rank = page.doc.getElementById("noise-outliers");
  assert.match(textOf(rank), /avg 16 s/);
  assert.match(textOf(rank), /recent 4 s/);
});

test("each window offers the ODB path that sets it", async () => {
  // Offered rather than described, which is what every other configurable value
  // on these pages does: the button opens the key itself.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  // The stub records dlgOdbEdit's argument as `params`, a bare path string.
  const paths = page.calls.filter((c) => c.method === "dlgOdbEdit");
  assert.strictEqual(paths.length, 0, "the tile edited the ODB without being asked");

  const tile = page.doc.getElementById("noise_by_channel");
  const buttons = tile.byClass("mbutton");
  assert.ok(buttons.length >= 2, "the two windows do not both offer an Edit");
  buttons.slice(0, 2).forEach((b) => b.dispatch("click"));
  const asked = page.calls.filter((c) => c.method === "dlgOdbEdit")
    .map((c) => c.params);
  assert.deepStrictEqual(asked,
    ["/DQM/ATAR/Noise Window Seconds", "/DQM/ATAR/Noise Recent Seconds"]);
});

test("an average window past the analyzer's horizon is clamped, and said", async () => {
  // The one thing a pair of knobs can do that a pair of constants could not: be
  // set to something the data cannot honour. The analyzer keeps 120 s per
  // channel, so a 300 s average is 120 s of data under a heading claiming 300.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
    undefined, { "Noise Window Seconds": 300.0 });

  const tile = page.doc.getElementById("noise_by_channel");
  const text = textOf(tile);
  assert.match(text, /set to 300 s/);
  assert.match(text, /analyzer keeps 120 s/);
  assert.match(text, /recent seconds per channel/,
    "the caveat does not say which key would make the longer window available");
  // Drawn at what it actually has, not at what it was asked for.
  assert.match(text, /Average over the last 120 s/);
  assert.doesNotMatch(text, /Average over the last 300 s/);
  // A caveat on the view, not a fault: both maps are drawing.
  assert.ok(tile.byClass("yellow").length > 0, "the clamp was reported silently");
  assert.strictEqual(tile.byClass("red").length, 0,
    "a setting that had to be clamped was reported as a failure");
});

test("a recent window that reaches the average window is clamped, and said", async () => {
  // At or past the long window the two maps are the same average, so every
  // difference cell goes blank -- which a reader would be entitled to read as
  // the detector rather than as the setting.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
    undefined, { "Noise Window Seconds": 20.0, "Noise Recent Seconds": 40.0 });

  const tile = page.doc.getElementById("noise_by_channel");
  const text = textOf(tile);
  assert.match(text, /recent window is set to 40 s/);
  assert.match(text, /drawn at 20 s/);
  assert.match(text, /difference between them is empty/);

  // And it really is empty, every cell, for the stated reason.
  const diff = cellsOf(page, "noise-map-diff");
  assert.ok(diff.length > 0);
  diff.forEach(function (c) {
    assert.ok(c.classList.contains("dqm-heat-single")
              || c.classList.contains("dqm-heat-nodata"),
      "a difference was drawn where both windows are the same average");
  });
});

test("a blank or zero window falls back rather than drawing nothing", async () => {
  // An ODB edit that went wrong must not produce an empty tile, which is the
  // failure this whole page set exists to avoid. The chips print what was
  // actually used, so a value that did not take is visible where a reader is
  // already looking.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings(),
    undefined, { "Noise Window Seconds": 0, "Noise Recent Seconds": -5 });

  const text = textOf(page.doc.getElementById("noise_by_channel"));
  assert.match(text, /Average over the last 120 s/);
  assert.match(text, /Average over the last 30 s/);
  assert.ok(cellFor(page, "noise-map-avg", 137).style.background,
    "a bad setting left the map unpainted");
});

test("with no geometry the maps say which key they wanted, rather than inventing layers", async () => {
  // Same contract the baseline block keeps: no geometry is a caveat on the
  // view, not a fault, and never a guess. A pixel id decodes only under the
  // base and stride it was made with.
  const page = await boot(series(64, DEPTH));

  const tile = page.doc.getElementById("noise_by_channel");
  assert.match(textOf(tile), /Equipment\/SAMPIC\/Settings/,
    "the tile does not say which key it wanted");
  assert.strictEqual(tile.byClass("yellow").length > 0, true,
    "a missing map was reported as a fault rather than a caveat");

  // Still a map of every channel, in one row. Nothing is dropped for want of a
  // place to put it.
  assert.strictEqual(cellsOf(page, "noise-map-avg").length, 64);

  // And it does not borrow the strip ramp's key, which is a different ramp:
  // that one stops short of the pale end because it draws lines on white.
  assert.strictEqual(page.root.byClass("dqm-ramp-key").length, 0,
    "the heat key was built out of the strip ramp's classes");
  assert.ok(page.root.byClass("dqm-heat-key").length > 0,
    "the maps were drawn with no key at all");
});

test("each key sits above what it explains, and says the scale is shared", async () => {
  // The first live render put the shared key between the second and third maps,
  // where it reads as belonging to the third -- the one map it does not
  // describe. Keys go above, which is where this page set already puts them.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const maps = page.doc.getElementById("noise-maps");
  const names = [...maps.walk()]
    .filter((e) => e.classList.contains("dqm-heat-key") || /^noise-map-/.test(e.id))
    .map((e) => e.id);
  assert.deepStrictEqual(names,
    ["noise-seq-key", "noise-map-avg", "noise-map-now",
     "noise-diff-key", "noise-map-diff"],
    `keys and maps came out in the order ${names.join(", ")}`);

  // The sharing stays *visible*, not moved to a tooltip: it is the claim the
  // two maps are read on, and two ramps drawn separately look identical
  // whether or not they were fitted together.
  assert.match(textOf(maps), /one scale for every map below/);
});

test("the distribution is drawn at the width of the tables under it", async () => {
  // A bar and the row naming the channel it belongs to are the same numbers
  // asked two questions, and they are read against each other down one pair of
  // edges. The width has to come from the tables: they size to their own
  // content, and the column cannot be sized to ITS content without mplot's
  // canvas -- whose width came from the column -- counting towards it.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());
  const g = distOf(page, "noise");
  const div = page.doc.getElementById("noise-dist-plot");
  assert.ok(page.doc.getElementById("noise-outliers").byTag("table")[0],
    "no ranking table to take a width from");
  const before = g.resizes;

  // A laid out table. Declared per tag rather than set on the element, because
  // fillRanks empties the ranking box and rebuilds both tables every tick.
  page.doc.widths = { TABLE: 427 };
  await settle(page);
  assert.strictEqual(div.style.width, "427px",
    "the plot did not take the width of the table under it");
  assert.ok(g.resizes > before, "the plot was resized without being redrawn at it");

  // And not on every tick after that. resize() plus redraw() is two full
  // repaints of a 48-bin histogram for a number that has not moved.
  const settled = g.resizes;
  await settle(page);
  assert.strictEqual(g.resizes, settled,
    "the plot is resized on every tick, not only when its width moves");

  // A table that grows -- "ch 7" becoming "ch 511" widens its column -- takes
  // the plot with it, which is the whole reason this is measured every tick.
  page.doc.widths = { TABLE: 464 };
  await settle(page);
  assert.strictEqual(div.style.width, "464px",
    "the plot did not follow the table when the table grew");
});

test("the distribution and the rankings sit beside the maps, not under", async () => {
  // Three grids stacked are most of a screen tall, and both blocks that
  // DESCRIBE them were below all three -- so the colour key the distribution
  // shares an axis with was off the top by the time the plot was on it, and
  // comparing a bar to the colour a cell of that value is painted is the one
  // thing that plot is for. Pinned by containment and not by CSS, which this
  // suite does not run: what the stylesheet can only widen or wrap is the DOM
  // putting the two in a column of their own beside the maps.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  ["noise", "baseline"].forEach(function (slug) {
    const row = page.doc.getElementById(`${slug}-row`);
    const side = page.doc.getElementById(`${slug}-side`);
    assert.ok(row && side, `${slug} has no map row`);
    assert.strictEqual(page.doc.getElementById(`${slug}-maps`).parentNode, row,
      `${slug}'s maps left the row`);
    assert.strictEqual(side.parentNode, row, `${slug}'s side column left the row`);
    // Reading order down the column is the order the three are read in: the
    // maps say where, the distribution says what the family looks like, the
    // tables say which channel.
    assert.deepStrictEqual(side.children.map((e) => e.id),
      [`${slug}-dist`, `${slug}-outliers`],
      `${slug}'s side column is not the distribution then the rankings`);
  });
});

test("hovering a cell names the channel, its layer and its strip", async () => {
  // A 19px cell carries no label, so the identity has to be reachable. The
  // global channel number is what the ODB, the frontend and the cable map all
  // speak, and it is what goes in the elog.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  cellFor(page, "noise-map-avg", 137).dispatch("mouseenter");
  const said = page.doc.getElementById("noise-readout").textContent;
  assert.match(said, /ch 137/);
  assert.match(said, /layer 4/);
  assert.match(said, /strip 9/);
  assert.match(said, / V/);
  assert.match(said, /s ago/);
  assert.doesNotMatch(said, /undefined/);
});

test("the noise readout does not steal the baseline's", async () => {
  // The two tiles are on one tab and both have a hover line. The baseline's is
  // module-level, because mplot resolves a tooltip by eval()ing a name from its
  // own scope and a closure is unreachable; the maps have no such constraint
  // and must not write to it. Sharing would hand whichever tile answered first
  // the other's readout -- a race, not an ordering.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  cellFor(page, "noise-map-avg", 137).dispatch("mouseenter");
  assert.match(page.doc.getElementById("noise-readout").textContent, /ch 137/);
  assert.match(page.doc.getElementById("baseline-readout").textContent,
    /Hover a cell/, "the noise tile wrote into the baseline's readout");
});

test("one loud channel does not flatten the other 255, and the key says it was clipped", async () => {
  // A scale fitted to the maximum is a scale the worst channel owns: it takes
  // the top colour and everything else lands in the bottom of the ramp,
  // indistinguishable. The clip is only honest if the key admits to it.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function (ch) {
    return ch === 200 ? 5.0 : 0.3;
  }), sampicSettings());

  const scale = page.doc.getElementById("noise-map-avg").dqmScale;
  assert.strictEqual(scale.clipped, true, "the scale did not clip the outlier");
  assert.ok(scale.hi < 1.0,
    `one channel at 5 V dragged the scale to ${scale.hi} and flattened the rest`);
  assert.strictEqual(page.doc.getElementById("noise-map-avg")
    .byClass("dqm-heat-over").length, 1,
    "the clip marked more than the one channel that was actually off the scale");

  const loud = cellFor(page, "noise-map-avg", 200);
  assert.ok(loud.classList.contains("dqm-heat-over"),
    "a clipped cell is indistinguishable from one merely at the maximum");

  // The key has to admit it: a scale that hides a channel and does not say so
  // is a lie told in the one place a reader trusts to turn colour back into
  // volts.
  // Marked where it can be seen, explained where it can be asked for. A
  // clipped scale that gave no visible sign would be a lie told in the one
  // place a reader trusts; the paragraph on how it clipped is not what makes
  // it honest, so that lives on the key's tooltip.
  const key = page.doc.getElementById("noise-seq-key");
  assert.match(textOf(key), /top clipped/,
    "the scale hides a channel with no visible sign at all");
  assert.match(key.title, /1\.5 x IQR/,
    "the key cannot be asked how it clipped");
  assert.match(key.title, /the highest is 5\.0000 V/,
    "the key does not say what was cut off");
});

test("the shared scale is fenced on the wider of the two maps, not on the pool", async () => {
  // Found on the live analyzer, not here: the freshest map came back with 46 of
  // 256 cells off the top of the scale and 19 distinct colours left, against
  // 151 on the average beside it.
  //
  // The mechanism is arithmetic, not data. A mean over n values is narrower
  // than a single value by construction, so pooling the two puts the quartiles
  // inside the average's tight bulk and the fence lands where the freshest
  // values step straight over it. A shared scale has to cover both
  // distributions, which means fencing each and taking the wider.
  // The freshest values run 0.001 to 0.026; the averages sit in a narrow band
  // in the MIDDLE of that range, which is where averaging actually puts them.
  // Both pooled quartiles then land inside the narrow band, the pooled IQR
  // collapses, and the fence drawn from it cuts the freshest map in half.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function (ch, k) {
    return k === DEPTH - 1 ? 0.001 + (ch % 64) * 0.0004 : 0.0136;
  }), sampicSettings());

  const now = page.doc.getElementById("noise-map-now");
  const over = now.byClass("dqm-heat-over").length;
  assert.ok(over <= 5,
    `${over} of 256 freshest cells are off the top of a scale fenced on the `
    + `averages beside them`);

  // And the point of the shared scale still holds: it is one scale.
  assert.deepStrictEqual(page.doc.getElementById("noise-map-avg").dqmScale,
                         now.dqmScale);
  // The spread survives: a scale that covers the wider map must still separate
  // its cells, or covering it bought nothing.
  const colours = new Set(now.byClass("dqm-heat-cell")
    .filter((c) => c.style.background).map((c) => c.style.background));
  assert.ok(colours.size > 30,
    `the freshest map came out in ${colours.size} colours`);
});

test("a reply out of order still cuts both windows on age", async () => {
  // The analyzer emits oldest-first and says so, but this page decided once
  // already not to rely on another process's emission order. Both windows are
  // cut on each point's own age, so scrambling the arrays must change nothing.
  //
  // Ages run 38 down to 0 in steps of 2, so the sixteen points at or under the
  // 30 s recent window are exactly the ones worth 0.99 -- a recent average of
  // 0.99 on the nose, which a cut made by array position could not produce
  // from a reversed reply.
  const s = series(N_LAYERS * PER_LAYER, DEPTH, function (ch, k) {
    if (ch !== 137) return 0.3;
    return k >= 4 ? 0.99 : 0.10;
  });
  const order = s.channel.map((_, i) => i).reverse();
  const scrambled = Object.assign({}, s, {
    channel: order.map((i) => s.channel[i]),
    value: order.map((i) => s.value[i]),
    age: order.map((i) => s.age[i]),
  });
  const page = await boot(scrambled, sampicSettings());

  assert.match(cellFor(page, "noise-map-now", 137).title,
    /recent 0\.9900 V from 16 values/,
    "the recent window was cut by position in the array rather than by age");
  // And the long window still holds all twenty: (4 x 0.10 + 16 x 0.99) / 20.
  assert.match(cellFor(page, "noise-map-avg", 137).title,
    /avg 0\.8120 V from 20 values over 120 s/);
});

test("every cell carries its channel as data, and the three maps agree on where it is", async () => {
  // Parsing a channel out of a display string would make the wording of that
  // string load-bearing. And a column is only one strip read three ways if the
  // three grids place the channels identically.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  const avg = cellsOf(page, "noise-map-avg").map((c) => c.dataset.ch);
  assert.strictEqual(avg.length, N_LAYERS * PER_LAYER);
  assert.deepStrictEqual(cellsOf(page, "noise-map-now").map((c) => c.dataset.ch), avg);
  assert.deepStrictEqual(cellsOf(page, "noise-map-diff").map((c) => c.dataset.ch), avg);

  // Placed by the map, not by the channel number: row 4 of the grid is layer 4.
  const c137 = cellFor(page, "noise-map-avg", 137);
  assert.strictEqual(c137.dataset.layer, "4");
  assert.strictEqual(c137.dataset.strip, "9");
});

test("the ranking names channels, and ranks rather than judges", async () => {
  // The same gap the baseline outlier table closes, and it matters more here:
  // a cell has no label at all, so the map alone stops at "something, over
  // there". No threshold, no colour, no verdict.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function (ch) {
    return ch === 200 ? 0.9 : 0.3;
  }), sampicSettings());

  const box = page.doc.getElementById("noise-outliers");
  assert.match(textOf(box), /ch 200/, "the loudest channel is not named");
  assert.match(textOf(box), /ranking, not a verdict/);
  box.byTag("tr").forEach(function (row) {
    assert.doesNotMatch(row.className, /warn|alarm|red|yellow/,
      "the ranking grew a verdict");
  });
});

test("the constants and defaults these tests assume are the ones the page uses", async () => {
  // Written out above rather than imported, for the reason the window test
  // gives: a test that reads the number it is asserting asserts nothing.
  await boot(series(1, DEPTH), sampicSettings());
  const H = require(path.join(JS, "dqm-hists.js"));
  assert.strictEqual(H.NOISE_FENCE, 1.5, "the outlier fence moved");

  // The two noise windows are settings now, so what these tests pin is the
  // default, which is what the tile draws on a bare experiment.
  const cfg = globalThis.DQM.DEFAULTS.ATAR;
  assert.strictEqual(cfg["Noise Window Seconds"], NOISE_LONG,
    "the default long window moved and these tests still assume the old one");
  assert.strictEqual(cfg["Noise Recent Seconds"], NOISE_SHORT,
    "the default recent window moved and these tests still assume the old one");
  assert.ok(NOISE_SHORT < NOISE_LONG,
    "the default recent window is not inside the default average window");
  // The fixture's ages run 0..18 s, so both defaults have to land inside it or
  // the tests above are exercising an empty window.
  assert.ok(NOISE_SHORT < (DEPTH - 1) * 2,
    "the default recent window holds the whole fixture, so it cuts nothing");
});

test("a healthy spread is not clipped, so the mark keeps meaning something", async () => {
  // The failure a percentile clip has by construction: cut at the 98th and 2%
  // of cells carry the "off the scale" outline on every run, healthy or not,
  // so the outline means "top 2%" rather than "far out". A fence the bulk sits
  // under marks nothing until something really is out.
  let n = 0;
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function () {
    n += 1;
    return 0.0040 + (n % 17) * 0.00005;      // a plain spread, no outlier
  }), sampicSettings());

  const avg = page.doc.getElementById("noise-map-avg");
  assert.strictEqual(avg.dqmScale.clipped, false,
    "an ordinary spread was reported as clipped");
  assert.strictEqual(avg.byClass("dqm-heat-over").length, 0,
    "cells were marked as off the scale on a run with no outlier");
  const key = page.doc.getElementById("noise-seq-key");
  assert.doesNotMatch(textOf(key), /clipped/,
    "the key claims a clip that did not happen");
  assert.doesNotMatch(key.title, /The top stops at/,
    "the key explains a clip that did not happen");
});

// --- ping-pong: two channels per strip --------------------------------------
//
// The digitiser can be run so that each ATAR strip is wired to two consecutive
// channels and a deposit above threshold is recorded on whichever of the two
// was not used last, which buys a second trigger inside what would have been
// dead time. The ODB's `Channel map channel id` then stops being injective:
// two entries carry the same pixel id.
//
// Inverting that naively halves the detector in silence: keyed by position in a
// loop over ascending channel, the second of every pair overwrites the first and
// half the channels get no cell at all -- on occupancy and on both map tiles,
// with every tile still reporting healthily. The first test here holds that
// off and the rest are the views the mode needs, which is why they are one
// block.

//: The same geometry as sampicSettings(), wired ping-pong: PER_LAYER strips a
//: layer, each one appearing twice so that channels 2k and 2k+1 share a pixel.
function pingPongSettings() {
  const ids = [], det = [];
  for (let L = 0; L < N_LAYERS; L++) {
    for (let s = 0; s < PER_LAYER; s++) {
      ids.push(BASE + L * STRIDE + s);
      ids.push(BASE + L * STRIDE + s);
      det.push("atar");
      det.push("atar");
    }
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

const PP_NCH = N_LAYERS * PER_LAYER * 2;

test("ping-pong: every channel keeps a cell, and partners share one", async () => {
  // The regression. Before this, `cells.length` was PP_NCH / 2 and the even
  // channel of every pair resolved to nothing -- invisible, with no diagnosis
  // anywhere, which is the one failure these tiles are built not to have.
  const page = await boot(series(PP_NCH, DEPTH), pingPongSettings(),
    occupancy(PP_NCH, () => 100));

  const cells = occCells(page);
  assert.strictEqual(cells.length, N_LAYERS * PER_LAYER,
    "a cell per strip, not per channel");
  assert.deepStrictEqual(cells[0].dataset.chs.split(","), ["0", "1"],
    "the first strip does not carry both of its channels");

  // Both halves resolve, and to the SAME cell: that is what stops a paint loop
  // over byCh painting one cell twice and calling it two strips.
  const built = globalThis.ATARGeom.heatGrid(await globalThis.ATARGeom.load(), {});
  assert.strictEqual(built.byCh.size, PP_NCH, "a channel was dropped");
  assert.strictEqual(built.byCh.get(0), built.byCh.get(1),
    "partners were given different cells");
  assert.strictEqual(built.paired, true);
  assert.strictEqual(built.byPos.length, N_LAYERS * PER_LAYER);
});

test("ping-pong: a strip's occupancy is the sum over its two channels", async () => {
  // The sum is the answer to this tile's question. A cell drawn from one
  // channel would report half the beam and the scale would be low by two.
  const page = await boot(series(PP_NCH, DEPTH), pingPongSettings(),
    occupancy(PP_NCH, (ch) => (ch % 2 === 0 ? 60 : 40)));

  const cell = occCells(page)[0];
  assert.match(cell.title, /100 hits/, "the strip did not sum its two channels");
  assert.match(cell.title, /split 60\/40 across 0, 1/,
    "the cell does not say how the pair divided");
  assert.strictEqual(page.doc.getElementById("occupancy-grid").dqmScale.hi, 100,
    "the scale was fitted to the channels rather than to what is drawn");
});

test("ping-pong: a pair with a dead half is named, and a quiet pair is not", async () => {
  // The failure the mode makes possible and the map cannot show: the strip's
  // total is ordinary while one of its two channels has stopped, its partner
  // covering for it. Ranked by |a-b| / sqrt(a+b), so the busy lopsided pair
  // beats the quiet one rather than the other way round.
  const page = await boot(series(PP_NCH, DEPTH), pingPongSettings(),
    occupancy(PP_NCH, function (ch) {
      if (ch === 0) return 800;             // strip 0: 800/0, one half dead
      if (ch === 1) return 0;
      if (ch === 2) return 2;               // strip 1: 2/0, too quiet to judge
      if (ch === 3) return 0;
      return ch % 2 === 0 ? 51 : 49;        // everything else, evenly split
    }));

  const box = page.doc.getElementById("occupancy-outliers");
  assert.match(textOf(box), /Most uneven pairs/);
  const rows = box.byTag("table").pop().byTag("tr").slice(1);
  assert.strictEqual(rows[0].byTag("td")[0].textContent, "ch 0+1",
    "the pair with a dead half is not at the top");
  assert.strictEqual(rows[0].byTag("td")[3].textContent, "800 / 0");
  // Both of those pairs are 100% lopsided, so a ranking on the raw fraction
  // would tie them at 1.0 and the tie-break -- document order -- would hand
  // the top row to the pair that took two hits. Dividing by the spread an even
  // split should have is what separates 800 from 2 without a cut on the count:
  // 800/0 is 28 sigma from even and 2/0 is 1.4, which is what half the strips
  // on a quiet run look like.
  const named = rows.map((r) => r.byTag("td")[0].textContent);
  const sigma = rows.map((r) => Number(r.byTag("td")[5].textContent));
  assert.ok(named.indexOf("ch 2+3") > 0,
    "a pair of two hits tied with one of eight hundred");
  assert.ok(sigma[0] > 25 && sigma[named.indexOf("ch 2+3")] < 2,
    `the two lopsided pairs were not separated: ${sigma.join(", ")}`);
  assert.ok(sigma.every((z, i) => i === 0 || z <= sigma[i - 1]),
    "the table is not sorted by how far from even the split is");
});

test("ping-pong: ping and pong each get their own three maps", async () => {
  // The question these tiles answer is whether each CHANNEL is healthy. A
  // strip's two channels are two amplifiers with their own pedestal and their
  // own noise, so each is drawn in its own right rather than the pair being
  // reduced to one cell.
  const page = await boot(series(PP_NCH, DEPTH), pingPongSettings());

  ["noise", "baseline"].forEach(function (slug) {
    ["avg", "now", "diff"].forEach(function (kind) {
      const ping = page.doc.getElementById(`${slug}-map-${kind}`);
      const pong = page.doc.getElementById(`${slug}-map-${kind}-pong`);
      assert.ok(ping && pong, `${slug} ${kind} is missing a column`);
      assert.strictEqual(cellsOf(page, `${slug}-map-${kind}`).length, 256);
      assert.strictEqual(cellsOf(page, `${slug}-map-${kind}-pong`).length, 256);
    });
  });

  // Ping is the FIRST channel the map lists for a strip and pong the second,
  // in map order -- never by parity of the channel number.
  assert.strictEqual(cellsOf(page, "noise-map-avg")[0].dataset.ch, "0");
  assert.strictEqual(cellsOf(page, "noise-map-avg-pong")[0].dataset.ch, "1");
  // And no partner comparison: how far apart two channels are is a question
  // about the pair, which these tiles do not ask.
  assert.strictEqual(page.doc.getElementById("noise-map-pair"), null);
  assert.doesNotMatch(textOf(page.doc.getElementById("noise-outliers")),
    /Partners furthest apart/);
});

test("ping-pong: a column draws its own channel's value, not its partner's", async () => {
  // The failure this rules out is a column that looks right because it is
  // drawing the other half of the pair.
  const page = await boot(series(PP_NCH, DEPTH, function (ch) {
    return ch === 1 ? 0.0200 : 0.0040;      // only pong on strip 0 is loud
  }), pingPongSettings());

  assert.match(cellFor(page, "noise-map-avg", 0).title, /ch 0 .* avg 0\.0040 V/);
  assert.match(cellFor(page, "noise-map-avg-pong", 1).title, /ch 1 .* avg 0\.0200 V/);
});

test("ping-pong: both columns are drawn on one scale", async () => {
  // Two ramps fitted separately look identical whether or not they were fitted
  // together, so reading a channel against its neighbour across the row would
  // silently stop meaning anything.
  const page = await boot(series(PP_NCH, DEPTH, (ch) => 0.004 + ch * 1e-5),
    pingPongSettings());

  const ping = page.doc.getElementById("noise-map-avg");
  const pong = page.doc.getElementById("noise-map-avg-pong");
  assert.strictEqual(ping.dqmScale, pong.dqmScale,
    "the two columns carry different scale objects");
  assert.strictEqual(page.doc.getElementById("noise-map-diff").dqmDiffScale,
    page.doc.getElementById("noise-map-diff-pong").dqmDiffScale);
  // One key, not one per column.
  assert.strictEqual(page.doc.getElementById("noise-maps")
    .byClass("dqm-heat-key").length, 2, "a key was drawn per column");
});

test("a channel with nothing in the window is blank in its own column", async () => {
  const full = series(PP_NCH, DEPTH);
  const page = await boot(onlyRecent(full, 1, -1), pingPongSettings());

  const gone = cellFor(page, "noise-map-avg-pong", 1);
  assert.ok(gone.className.includes("dqm-heat-nodata"),
    "a channel the analyzer never mentioned was painted as a measurement");
  // Its partner is unaffected, which is the whole point of separate columns.
  assert.ok(!cellFor(page, "noise-map-avg", 0).className.includes("dqm-heat-nodata"));
});

test("without ping-pong there is one column and it is the tile as it was", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  ["avg", "now", "diff"].forEach(function (kind) {
    assert.ok(page.doc.getElementById(`noise-map-${kind}`), `${kind} missing`);
    assert.strictEqual(page.doc.getElementById(`noise-map-${kind}-pong`), null,
      `${kind} grew a second column on a one-channel-per-strip map`);
  });
  assert.strictEqual(page.doc.getElementById("noise-map-pair"), null);
  // The strip axis still sits under the last grid drawn.
  assert.ok(page.doc.getElementById("noise-map-diff")
    .byClass("dqm-heat-collab").length,
    "the strip axis went missing with the partner map");
});

test("ping-pong: the per-channel tables place both halves of a pair", async () => {
  // These rows come from the series rather than from the grid, so they always
  // named every channel -- but the layer and strip columns are read off the
  // cell, and the half with no cell printed an em dash for both. Half the rows
  // in every ranking claimed to be unplaceable channels on a fully mapped
  // detector.
  const page = await boot(series(PP_NCH, DEPTH, function (ch) {
    return 0.004 + ch * 1e-5;               // every channel distinct, ch 511 loudest
  }), pingPongSettings());

  const rows = page.doc.getElementById("noise-outliers")
    .byTag("table")[0].byTag("tr").slice(1);
  assert.ok(rows.length, "no rows in the loudest table");
  rows.forEach(function (r) {
    const td = r.byTag("td");
    assert.notStrictEqual(td[1].textContent, "—",
      `${td[0].textContent} is a mapped ATAR channel with no layer`);
    assert.notStrictEqual(td[2].textContent, "—",
      `${td[0].textContent} is a mapped ATAR channel with no strip`);
  });
});

test("ping-pong: pairs splitting by 1 or less are not a finding", async () => {
  // Perfect alternation puts |a-b| at 0, or at 1 when the pair has taken an
  // odd number of hits and one channel keeps the spare. Neither is something
  // a shifter needs a table for, and a ranking of differences that are all
  // zero is five rows saying nothing.
  for (const [even, odd, what] of [[50, 50, "an exactly even split"],
                                   [51, 50, "a split of one"]]) {
    const page = await boot(series(PP_NCH, DEPTH), pingPongSettings(),
      occupancy(PP_NCH, (ch) => (ch % 2 === 0 ? even : odd)));
    const box = page.doc.getElementById("occupancy-outliers");
    assert.doesNotMatch(textOf(box), /Most uneven pairs/,
      `${what} was reported as uneven`);
    // The quietest/busiest tables are untouched -- this hides one block, not
    // the tile's whole ranking.
    assert.match(textOf(box), /Busiest strips/);
  }
});

test("ping-pong: one pair over the threshold brings the table back alone", async () => {
  const page = await boot(series(PP_NCH, DEPTH), pingPongSettings(),
    occupancy(PP_NCH, function (ch) {
      if (ch === 0) return 60;            // strip 0 splits 60/40, gap 20
      if (ch === 1) return 40;
      if (ch === 2) return 51;            // strip 1 splits 51/50, gap 1
      if (ch === 3) return 50;
      return ch % 2 === 0 ? 50 : 50;      // everything else dead even
    }));

  const box = page.doc.getElementById("occupancy-outliers");
  assert.match(textOf(box), /Most uneven pairs/);
  const rows = box.byTag("table").pop().byTag("tr").slice(1);
  assert.strictEqual(rows.length, 1, "a pair within the threshold was listed");
  assert.strictEqual(rows[0].byTag("td")[0].textContent, "ch 0+1");
  // The footnote accounts for the ones it left out rather than quietly
  // shrinking the population it ranks against.
  assert.match(textOf(box), /255 within 1 and not listed/);
});

// --- the distribution histogram ---------------------------------------------
//
// A third reading of the same numbers: the maps say where, this says what the
// family looks like, and the tables say which channel. What it adds over the
// maps is the SHAPE -- one peak is a detector whose channels agree, two is a
// set that has split, and a map shows that only as a mixture of colours with
// no way to count the groups.

function distOf(page, slug) {
  const div = page.doc.getElementById(`${slug}-dist-plot`);
  return div && div.mpg;
}

test("each map tile carries a distribution of its own channels", async () => {
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  ["noise", "baseline"].forEach(function (slug) {
    const g = distOf(page, slug);
    assert.ok(g, `${slug} has no distribution plot`);
    const p = g.param.plot[0];
    assert.strictEqual(p.type, "histogram");
    // Every mapped channel is in it, counting the under/over bins.
    const counts = g.data[0].y;
    const total = counts.reduce((a, b) => a + b, 0);
    assert.strictEqual(total, N_LAYERS * PER_LAYER,
      `${slug} binned ${total} of ${N_LAYERS * PER_LAYER} channels`);
  });
  assert.match(textOf(page.doc.getElementById("noise-dist")),
    /Distribution over 256 channels, 120 s average/);
});

test("the distribution is binned over the maps' own scale, not its own", async () => {
  // The x axis and the colour key have to be one axis, or a bar would sit
  // under a colour that no cell of that value is painted.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH,
    (ch) => 0.004 + (ch % 13) * 0.0001), sampicSettings());

  const seq = page.doc.getElementById("noise-map-avg").dqmScale;
  const p = distOf(page, "noise").param.plot[0];
  // display() widens by one bin at each end to hold under/overflow, which is
  // the same arithmetic it uses for an analyzer histogram.
  const width = (seq.hi - seq.lo) / 48;
  assert.ok(Math.abs(p.xMin - (seq.lo - width)) < 1e-9,
    `xMin ${p.xMin} is not the scale's low end less one bin`);
  assert.ok(Math.abs(p.xMax - (seq.hi + width)) < 1e-9,
    `xMax ${p.xMax} is not the scale's high end plus one bin`);
});

test("a channel past the fenced end is in the overflow bin, not off the plot", async () => {
  // Fitting the axis to the data instead would let one loud channel stretch it
  // and squash the other 255 into three bins -- the same argument the maps'
  // own fence makes, and the reason this borrows that fence rather than
  // computing a second one.
  let n = 0;
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH, function () {
    n += 1;
    return n === 1 ? 0.2 : 0.004;          // one channel far out
  }), sampicSettings());

  const counts = distOf(page, "noise").data[0].y;
  assert.strictEqual(counts[counts.length - 1], 1,
    "the outlier is not in the overflow bin");
  assert.strictEqual(counts.reduce((a, b) => a + b, 0), N_LAYERS * PER_LAYER,
    "a channel went missing rather than overflowing");
});

test("every histogram plot carries the line mplot's draw path reads", async () => {
  // mplot reads plot.line.color when it draws a histogram and throws
  // "can't access property color, g.line is undefined" without it. The stub
  // here does not model the draw path, so this pins the SHAPE of the param
  // instead -- which is what the real browser found missing on the
  // distribution plot after the node suite had gone green.
  const page = await boot(series(N_LAYERS * PER_LAYER, DEPTH), sampicSettings());

  ["noise", "baseline"].forEach(function (slug) {
    distOf(page, slug).param.plot.forEach(function (p) {
      assert.ok(p.line && typeof p.line.draw === "boolean",
        `${slug}: a histogram plot has no line, which mplot dereferences`);
      assert.ok(p.marker, `${slug}: a histogram plot has no marker`);
    });
  });
});
