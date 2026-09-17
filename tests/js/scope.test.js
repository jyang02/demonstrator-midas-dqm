//
// The Scope tab, driven with real events out of run 108.
//
// The transport is stubbed; the bytes are not. Every event this file feeds the
// page is the exact payload recorded in the run file, so a change that breaks
// decoding breaks these tests rather than a plot at 3am.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { runPage } = require(path.join(__dirname, "domstub.js"));

const JS = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(JS, "dqm-common.js"));
globalThis.DQMPanels = require(path.join(JS, "dqm-panels.js"));
globalThis.ADBanks = require(path.join(JS, "dqm-adbanks.js"));
// dqm-scope.js reaches for ATARGeom at load, so the direct require() further
// down needs it here. Page boots get their own copy through `also` below --
// which matters, because the map is cached per script evaluation and a boot
// with geometry must not hand its map to the next boot without.
globalThis.ATARGeom = require(path.join(JS, "dqm-atar-geom.js"));

const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, "ad-event-fixture.json"), "utf8"));
const DEMO = JSON.parse(
  fs.readFileSync(path.join(__dirname, "demonstrator-event-fixture.json"), "utf8"));

function buf(b64) {
  const b = Buffer.from(b64, "base64");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** One fixture event in the shape bkToObj() returns. */
function asEvent(ev) {
  return {
    event_id: ev.event_id,
    trigger_mask: 0,
    serial_number: ev.serial,
    time_stamp: ev.time,
    bank: Object.entries(ev.banks_b64).map(([name, b64]) => ({
      name: name, array: new Uint8Array(buf(b64)),
    })),
  };
}

/**
 * Boot the ATAR page on its Scope tab, with a queue of events to hand out, one per poll.
 *
 * bm_receive_event answers binary for an event and JSON for "nothing there", so
 * the stub distinguishes them the way mhttpd does: a reply carrying `result` is
 * the empty case, one without it is an event.
 */
//: /Equipment/SAMPIC/Settings as a demonstrator file's frontend publishes it:
//: the channel map and the geometry that encoded it. 8 layers x 32 channels,
//: stride 46, exactly what demonstrator/odb.py writes.
function sampicSettings(nLayers, perLayer, stride, base) {
  nLayers = nLayers || 8; perLayer = perLayer || 32;
  stride = stride || 46; base = base || 100000;
  const ids = [], det = [];
  for (let L = 0; L < nLayers; L++) {
    for (let sIdx = 0; sIdx < perLayer; sIdx++) {
      ids.push(base + L * stride + sIdx);
      det.push("atar");
    }
  }
  return {
    "/Equipment/SAMPIC/Settings/Channel map channel id": ids,
    "/Equipment/SAMPIC/Settings/Channel map detector": det,
    "/Equipment/SAMPIC/Settings/Atar pixel id base": base,
    "/Equipment/SAMPIC/Settings/Atar strips per layer": stride,
    "/Equipment/SAMPIC/Settings/Atar n layers": nLayers,
    "/Equipment/SAMPIC/Settings/Atar first layer orientation": "vertical",
  };
}

async function boot(events, cfgOverrides, odbExtra) {
  const queue = (events || []).slice();
  globalThis.bkToObj = (rpc) => rpc.__event;
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
  };

  const cfg = Object.assign({}, globalThis.DQM.DEFAULTS.ATAR, cfgOverrides || {});
  const page = runPage(path.join(JS, "dqm-page.js"), {
    db_get_values: (p) => ({
      // /DQM/ATAR comes back seeded; /DQM itself does not, which is the usual
      // half-configured state and exercises the merge. Anything in `odbExtra`
      // answers as itself, which is how the SAMPIC settings get in.
      data: p.paths.map((x) => (x.endsWith("/ATAR") ? cfg
        : (odbExtra && x in odbExtra) ? odbExtra[x] : null)),
      status: p.paths.map((x) => (x.endsWith("/ATAR") ? 1
        : (odbExtra && x in odbExtra) ? 1 : 312)),
    }),
    db_ls: (p) => ({ data: p.paths.map(() => null) }),
    hs_get_events: () => ({ events: [] }),
    bm_receive_event: () => (queue.length
      ? Promise.resolve({ __event: asEvent(queue.shift()) })
      : Promise.resolve({ result: { status: 209 } })),
  }, { boot: "ATAR", also: [path.join(JS, "dqm-atar-geom.js"),
                           path.join(JS, "dqm-adbanks.js"),
                           path.join(JS, "dqm-scope.js")] });

  await page.load();
  // These panels are on the Scope tab, and a tab is built the first time it is
  // shown -- so nothing here exists, and no poll has started, until it is
  // opened. That is the behaviour under test as much as a fixture step: a page
  // sitting on Channels must not be pulling events out of a shared buffer.
  page.doc.getElementById("tab-atar_scope").dispatch("click");
  page.queue = queue;          // push more events to feed later polls
  return page;
}

/** Run the chained-setTimeout loop `n` more times. */
async function pump(page, n) {
  for (let i = 0; i < (n || 1); i++) {
    page.flushTimers();
    for (let j = 0; j < 50; j++) await Promise.resolve();
    await new Promise((r) => setImmediate(r));
    for (let j = 0; j < 50; j++) await Promise.resolve();
  }
}

function graphOf(page) {
  return page.root.byClass("dqm-scope-plot")[0].mpg;
}

function text(page, id) {
  const e = page.doc.getElementById(id);
  return e ? e.textContent : null;
}

// --- the live half ----------------------------------------------------------

test("a real event reaches the traces", async () => {
  const ev = REAL.events[3];                      // 5 hits, channels 3..7
  const page = await boot([ev]);
  await pump(page, 2);

  assert.strictEqual(text(page, "scope-serial"), String(ev.serial));
  assert.strictEqual(text(page, "scope-nhits"), String(ev.decoded.nhits));
  assert.strictEqual(text(page, "scope-seen"), "1");
  assert.match(text(page, "scope-banks"), /AD00/);

  // One trace per selected channel, in the plot mplot would draw.
  const labels = graphOf(page).param.plot.map((p) => p.label);
  assert.strictEqual(labels.length, ev.decoded.nhits);
  ev.decoded.channels.forEach(function (ch) {
    assert.ok(labels.some((l) => l.startsWith(`ch ${ch}`)), `no trace for ch ${ch}`);
  });
});

test("the trace carries volts against nanoseconds, from the configured period", async () => {
  const ev = REAL.events[0];
  const page = await boot([ev]);
  await pump(page, 2);

  const trace = graphOf(page).param.plot[0];
  assert.strictEqual(trace.yData.length, 64);
  // 0.625 ns at 1.6 GSPS: the last sample of a 64-slot hit.
  assert.ok(Math.abs(trace.xData[63] - 63 * 0.625) < 1e-6);
  // Volts, not ADC counts. A decoder that scaled by 1e4 would still plot.
  trace.yData.forEach((v) => assert.ok(Math.abs(v) < 5.0, `${v} is not volts`));
});

test("with no sample period the axis is samples, and the page says so", async () => {
  const page = await boot([REAL.events[0]], { "Sample Period ns": 0 });
  await pump(page, 2);
  assert.match(text(page, "scope-status"), /time axis is in samples, not ns/);
  // Sample index, not a row of zeros: an honest axis in the wrong unit beats
  // every point stacked at x = 0.
  assert.strictEqual(graphOf(page).param.plot[0].xData[5], 5);
});

test("unticking a channel drops its trace and is remembered", async () => {
  const ev = REAL.events[3];
  const page = await boot([ev, ev]);
  await pump(page, 2);
  assert.strictEqual(graphOf(page).param.plot.length, 5);

  const boxes = page.doc.getElementById("scope-channels").byTag("input");
  assert.strictEqual(boxes.length, 5);
  assert.ok(boxes.every((b) => b.checked), "everything in the event draws by default");

  boxes[0].checked = false;
  boxes[0].dispatch("change");
  assert.strictEqual(graphOf(page).param.plot.length, 4);
  assert.match(globalThis.localStorage.getItem("dqm-scope-settings"), /excluded/);
});

test("a channel that fires only in a later event still draws", async () => {
  // The bug this replaces: selection fixed from the first event. SAMPIC is
  // hit-based, so which channels fire differs every event -- measured over 500
  // real events, that showed one trace out of three hits and said nothing.
  const first = REAL.events[0];          // channels 5, 6
  const later = REAL.events[3];          // channels 3, 4, 5, 6, 7
  const page = await boot([first]);
  await pump(page, 2);
  assert.strictEqual(graphOf(page).param.plot.length, first.decoded.nhits,
    "the first event draws all of its own hits");

  page.queue.push(later);
  await pump(page, 2);
  const labels = graphOf(page).param.plot.map((p) => p.label);
  later.decoded.channels.forEach(function (ch) {
    assert.ok(labels.some((l) => l.startsWith(`ch ${ch}`)), `ch ${ch} was not drawn`);
  });

  // And the picker only grows, so a box never vanishes out from under a click.
  const boxes = page.doc.getElementById("scope-channels").byTag("input");
  assert.strictEqual(boxes.length, 5);
});

test("the empty buffer says nothing is writing the bank, and names it", async () => {
  const page = await boot([]);
  await pump(page, 3);
  assert.match(text(page, "scope-status"), /No event yet after \d+ polls/);
  assert.match(text(page, "scope-status"), /AD00/);
  assert.match(text(page, "scope-status"), /no fesampic/);
});

test("pausing stops the loop, resuming restarts it", async () => {
  const ev = REAL.events[0];
  const page = await boot([ev]);
  await pump(page, 2);
  assert.strictEqual(text(page, "scope-seen"), "1");

  const button = page.doc.getElementById("scope-pause");
  button.dispatch("click");
  assert.strictEqual(button.textContent, "Resume");

  page.queue.push(ev, ev);
  await pump(page, 3);
  assert.strictEqual(text(page, "scope-seen"), "1", "a paused page must not poll");
  assert.strictEqual(page.queue.length, 2, "and must not drain the buffer");

  button.dispatch("click");
  await pump(page, 1);
  assert.ok(Number(text(page, "scope-seen")) > 1, "resuming must poll again");
});

test("an AT00 that disagrees with AD00 is reported, not averaged over", async () => {
  // AT00 says how many hits the frontend clustered and AD00 is how many it
  // wrote. Nothing else in the system would notice them disagreeing.
  const ev = JSON.parse(JSON.stringify(REAL.events[0]));
  const at = Buffer.from(ev.banks_b64.AT00, "base64");
  at.writeUInt32LE(9, 8);                         // nhits := 9, AD00 still has 2
  ev.banks_b64.AT00 = at.toString("base64");

  const page = await boot([ev]);
  await pump(page, 2);
  const status = page.doc.getElementById("scope-status");
  assert.match(status.textContent, /AT00 claims 9 hits but AD00 carries 2/);
  // The spec gives this panel no alarm line, so the status has to carry it.
  assert.ok(status.classList.contains("red"), "a bank disagreement must read as one");
});

test("a bank the decoder disagrees with is surfaced rather than half-read", async () => {
  const ev = JSON.parse(JSON.stringify(REAL.events[0]));
  const ad = Buffer.from(ev.banks_b64.AD00, "base64");
  ev.banks_b64.AD00 = ad.subarray(0, ad.length - 17).toString("base64");

  const page = await boot([ev]);
  await pump(page, 2);
  const status = page.doc.getElementById("scope-status");
  assert.strictEqual(status.className, "dqm-error");
  assert.match(status.textContent, /disagree about the bank layout/);
});

test("an event from another frontend is skipped, not drawn", async () => {
  const ev = JSON.parse(JSON.stringify(REAL.events[0]));
  ev.event_id = 77;
  const page = await boot([ev]);
  await pump(page, 2);
  assert.match(text(page, "scope-status"), /No event yet/);
  assert.strictEqual(text(page, "scope-seen"), "0");
});

test("the shared read pointer is stated on the page, not left to be discovered", async () => {
  const page = await boot([REAL.events[0]]);
  await pump(page, 2);
  const feet = page.doc.getElementById("atar_raw_waveforms")
    .byClass("dqm-footnote").map((f) => f.textContent).join(" ");
  assert.match(feet, /one event-buffer read pointer/);
  assert.match(feet, /they see different/);
});

// --- the ones that correctly have no renderer -------------------------------
//
// This block used to name calo_waveforms, event_display_position and
// event_display_energy. All three were wrong by the time anything could run it:
// event_display_position had been dropped from the spec (so BY_ID[id] was
// undefined and this threw), event_display_energy had gained a renderer, and
// calo_waveforms has now left the page with the rest of the calorimeter. It is
// derived from the catalogue instead, so it cannot name a panel that is not
// there.

test("a panel on the Scope tab with no renderer keeps its own reason", async () => {
  const page = await boot([REAL.events[0]]);
  await pump(page, 2);

  const tab = globalThis.DQMPanels.byPage("ATAR").tabs
    .find((t) => t.group === "atar_scope");
  const unclaimed = tab.elements.filter(
    (e) => e.kind === "panel" && e.status === "blocked");
  assert.ok(unclaimed.length > 0, "the Scope tab has no blocked panel to check");

  for (const p of unclaimed) {
    const tile = page.doc.getElementById(p.id);
    const why = tile.byClass("dqm-empty-why");
    assert.strictEqual(why.length, 1, `${p.id} has no empty-state reason`);
    assert.strictEqual(why[0].textContent.trim(), p.blocked_by.trim());
  }
});

test("the hit maps and the depth profile are two tiles off one event", async () => {
  const page = await boot([REAL.events[0]]);
  await pump(page, 2);
  assert.ok(page.doc.getElementById("atar_hit_positions"), "no hit-position tile");
  assert.ok(page.doc.getElementById("event_display_energy"), "no charge-depth tile");
  // One poll feeds both: the split is in the tiles, not in the mechanism.
  const polls = page.calls.filter((c) => c.method === "bm_receive_event").length;
  assert.ok(polls > 0, "nothing polled the event buffer");
});


// --- a demonstrator event, four boards deep ---------------------------------

test("a multi-board demonstrator event draws one trace per readout channel", async () => {
  // Four FE boards in one event. Keyed on `channel` this drew every board's
  // channel 5 onto one panel in one colour, and offered one checkbox that
  // silently unticked all four.
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  assert.ok(ev, "no fixture event spans three boards");
  const page = await boot([ev]);
  await pump(page, 2);

  assert.strictEqual(text(page, "scope-nhits"), String(ev.decoded.nhits));
  assert.match(text(page, "scope-banks"), /AC00/, "the collector bank is not reported");

  const labels = graphOf(page).param.plot.map((p) => p.label);
  assert.strictEqual(labels.length, ev.decoded.nhits, "a hit lost its trace");
  ev.decoded.channels.forEach(function (ch) {
    assert.ok(labels.some((l) => l.startsWith(`ch ${ch}`)), `no trace for ch ${ch}`);
  });

  // Distinct channels get distinct colours: the board-local bug gave two
  // boards' channel 5 the same one.
  const colours = graphOf(page).param.plot.map((p) => p.line.color);
  assert.strictEqual(new Set(colours).size, new Set(labels).size,
    "two readout channels share a colour");
});

test("unticking one board's channel leaves the other boards drawn", async () => {
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  const page = await boot([ev]);
  await pump(page, 2);

  const before = graphOf(page).param.plot.length;
  const boxes = page.doc.getElementById("scope-channels").byTag("input");
  assert.strictEqual(boxes.length, ev.decoded.channels.length,
    "one checkbox per readout channel, not per board-local number");
  boxes[0].checked = false;
  boxes[0].dispatch("change");

  assert.strictEqual(graphOf(page).param.plot.length, before - 1,
    "unticking one channel removed more or fewer than one trace");
});


// --- AT00 telemetry and AC00, where an operator can read them ---------------

test("a collector that disagrees with the banks it collected is reported", async () => {
  const ev = DEMO.events[0];
  const page = await boot([ev]);
  await pump(page, 2);
  assert.ok(!/AC00 collected/.test(text(page, "scope-status")),
    "a consistent event should not be flagged");

  // Corrupt total_hits in the AC00 payload: u32 at offset 12 of the record.
  const bad = JSON.parse(JSON.stringify(ev));
  const raw = Buffer.from(bad.banks_b64.AC00, "base64");
  raw.writeUInt32LE(99, 12);
  bad.banks_b64.AC00 = raw.toString("base64");

  const page2 = await boot([bad]);
  await pump(page2, 2);
  assert.match(text(page2, "scope-status"), /AC00 collected 99 hits but AD00 carries/);
});


// --- one panel per ATAR layer -----------------------------------------------

test("with the map in the ODB, the traces split into one panel per layer", async () => {
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  const page = await boot([ev], null, sampicSettings());
  await pump(page, 3);

  assert.match(text(page, "scope-layers"), /One panel per ATAR layer/);
  const host = page.doc.getElementById("scope-layer-panels");
  assert.ok(host, "no layer panels were built");
  const panels = host.byClass("dqm-scope-plot");
  assert.strictEqual(panels.length, 8, "one panel per layer of the map");

  // Every hit is drawn exactly once, somewhere.
  const drawn = panels.flatMap((d) => d.mpg.param.plot)
    .filter((p) => p.xData.length).map((p) => p.label);
  assert.strictEqual(drawn.length, ev.decoded.nhits,
    "a hit was dropped or drawn twice when routed to a layer");
  // Unique WITHIN a panel, which is what mplot needs: findPlot() looks a label
  // up in one graph's own plot list, and a duplicate there makes deletePlot
  // remove the wrong trace. Across panels a repeat is expected and meaningful
  // -- "strip 12" in two layers is a track crossing both at the same strip.
  panels.forEach(function (d) {
    const here = d.mpg.param.plot.map((p) => p.label);
    assert.strictEqual(new Set(here).size, here.length,
      `duplicate labels in ${d.id}: ${here}`);
  });

  // And in the right one: layer = (channel_id - base) / stride.
  const base = 100000, stride = 46;
  ev.decoded.hits.forEach(function (h) {
    const id = sampicSettings()["/Equipment/SAMPIC/Settings/Channel map channel id"]
      [h.global_channel];
    const layer = Math.floor((id - base) / stride);
    const strip = (id - base) % stride;
    // By id, not by position: the panels are laid out in two columns now, so
    // the nth panel in the DOM is not layer n.
    const panel = page.doc.getElementById(`scope-plot-L${layer}`);
    assert.ok(panel, `no panel for layer ${layer}`);
    const labels = panel.mpg.param.plot.map((p) => p.label);
    // Labelled by strip once the map gives one: inside a layer panel the layer
    // is the heading, so the strip is what is left to say.
    assert.ok(labels.some((l) => l.startsWith(`strip ${strip}`)),
      `strip ${strip} (ch ${h.global_channel}) is not in layer ${layer}`);
  });
});

test("a layer with no hits keeps its panel rather than renumbering the rest", async () => {
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  const page = await boot([ev], null, sampicSettings());
  await pump(page, 3);

  const panels = page.doc.getElementById("scope-layer-panels").byClass("dqm-scope-plot");
  const empty = panels.filter((d) => d.mpg.param.plot.every((p) => !p.xData.length));
  assert.ok(empty.length > 0, "this event should not light every layer");
  empty.forEach(function (d) {
    assert.strictEqual(d.mpg.param.plot.length, 1, "an empty panel still needs axes");
    assert.match(d.mpg.param.plot[0].label, /no hits/);
  });
});

test("without the geometry in the ODB the page stays on one panel and says why", async () => {
  const ev = DEMO.events[0];
  // The channel ids, but not the numbers that decode them -- which is what an
  // older file, or another experiment's frontend, would publish.
  const partial = sampicSettings();
  delete partial["/Equipment/SAMPIC/Settings/Atar strips per layer"];
  const page = await boot([ev], null, partial);
  await pump(page, 3);

  assert.strictEqual(page.doc.getElementById("scope-layer-panels"), null,
    "layers were invented from a map that cannot be decoded");
  assert.match(text(page, "scope-layers"), /cannot be guessed/);
  const plots = graphOf(page).param.plot.filter((p) => p.xData.length);
  assert.strictEqual(plots.length, ev.decoded.nhits, "the single panel lost hits");
});

test("run 108, whose frontend published nothing, is unchanged", async () => {
  const ev = REAL.events[3];
  const page = await boot([ev]);
  await pump(page, 3);
  assert.strictEqual(page.doc.getElementById("scope-layer-panels"), null);
  assert.strictEqual(graphOf(page).param.plot.length, ev.decoded.nhits);
});


// --- two columns, one strip orientation each --------------------------------

test("odd layers go left, even layers right, which groups them by orientation", async () => {
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  const page = await boot([ev], null, sampicSettings());
  await pump(page, 3);

  const odd = page.doc.getElementById("scope-col-odd");
  const even = page.doc.getElementById("scope-col-even");
  assert.ok(odd && even, "the two columns were not built");

  const layersIn = (col) => col.byClass("dqm-scope-plot")
    .map((d) => Number(d.id.replace("scope-plot-L", "")));
  assert.deepStrictEqual(layersIn(odd), [1, 3, 5, 7]);
  assert.deepStrictEqual(layersIn(even), [0, 2, 4, 6]);

  // Layer 0 is vertical in the fixture, so the even column is the vertical one
  // and the odd column is horizontal. Read from the ODB, not assumed: a target
  // built the other way round has to label the other way round.
  assert.match(even.byClass("dqm-col-head")[0].textContent, /vertical strips/);
  assert.match(odd.byClass("dqm-col-head")[0].textContent, /horizontal strips/);
  assert.match(page.doc.getElementById("scope-plot-L3").parentNode
    .byClass("dqm-subhead").map((d) => d.textContent).join(" "),
    /Layer 3 \(horizontal\)/);
});

test("the columns follow the ODB when the first layer is horizontal", async () => {
  const ev = DEMO.events[0];
  const odb = sampicSettings();
  odb["/Equipment/SAMPIC/Settings/Atar first layer orientation"] = "horizontal";
  const page = await boot([ev], null, odb);
  await pump(page, 3);

  // Same parity split, opposite labels.
  assert.match(page.doc.getElementById("scope-col-even")
    .byClass("dqm-col-head")[0].textContent, /horizontal strips/);
  assert.match(page.doc.getElementById("scope-col-odd")
    .byClass("dqm-col-head")[0].textContent, /vertical strips/);
});

test("with no orientation in the ODB the columns say only which layers they hold", async () => {
  const ev = DEMO.events[0];
  const odb = sampicSettings();
  delete odb["/Equipment/SAMPIC/Settings/Atar first layer orientation"];
  const page = await boot([ev], null, odb);
  await pump(page, 3);

  const head = page.doc.getElementById("scope-col-odd").byClass("dqm-col-head")[0];
  assert.strictEqual(head.textContent, "odd layers", "orientation was invented");
  assert.ok(page.doc.getElementById("scope-plot-L1"), "the split still happened");
});


// --- colour carries the strip, not the channel ------------------------------

test("the colour ramp runs monotonically across the whole strip range", () => {
  // Loaded directly, with only the globals it touches at load, so the ramp can
  // be checked across all 32 strips. Driving it through the page instead was
  // the first attempt and it was worthless: every hit in the fixture event
  // sits on strip 0, so the check passed with the ramp taken out entirely.
  const saved = { DQMPage: globalThis.DQMPage, document: globalThis.document };
  globalThis.DQMPage = { el: () => ({}), chip: () => ({}), blocked: () => ({}),
                         register: () => {}, editButton: () => ({}) };
  globalThis.document = { addEventListener() {}, getElementById: () => null };
  let S;
  try {
    S = require(path.join(JS, "dqm-scope.js"));
  } finally {
    globalThis.DQMPage = saved.DQMPage;
    globalThis.document = saved.document;
  }

  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.substr(i, 2), 16));
  const colours = [];
  for (let strip = 0; strip <= 31; strip++) colours.push(S.stripColour(strip, 0, 31));

  // viridis rises monotonically in green. A categorical palette does not, which
  // is what makes this the check that tells the two apart.
  for (let i = 1; i < colours.length; i++) {
    assert.ok(rgb(colours[i])[1] > rgb(colours[i - 1])[1],
      `strip ${i} is not further along the ramp than ${i - 1}: `
      + `${colours[i - 1]} -> ${colours[i]}`);
  }

  // Ends far apart, neighbours close: that is what "position at a glance"
  // means, and what a modulo palette gets exactly backwards.
  const dist = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
  assert.ok(dist(colours[0], colours[31]) > 150, "the two ends look alike");
  assert.ok(dist(colours[10], colours[11]) < 40, "neighbouring strips jump");

  // Nothing pale enough to vanish on a white plot.
  colours.forEach(function (c, strip) {
    const [r, g, b] = rgb(c);
    assert.ok(0.299 * r + 0.587 * g + 0.114 * b < 210,
      `strip ${strip} is ${c}, too pale to see on white`);
  });

  // An unmapped channel keeps the categorical palette: no strip, no position.
  assert.ok(S.PALETTE.includes(S.colourFor(7)));
});

test("the same strip in two layers gets the same colour", async () => {
  // That is the point of colouring by strip: a track crossing the target shows
  // as one colour appearing down both columns.
  const ev = DEMO.events.find((e) => e.decoded.boards.length >= 3);
  const page = await boot([ev], null, sampicSettings());
  await pump(page, 3);

  const byStrip = new Map();
  page.doc.getElementById("scope-layer-panels").byClass("dqm-scope-plot")
    .forEach(function (d) {
      d.mpg.param.plot.filter((p) => p.xData.length).forEach(function (p) {
        const m = /^strip (\d+)/.exec(p.label);
        if (!m) return;
        const seen = byStrip.get(m[1]);
        if (seen) assert.strictEqual(p.line.color, seen,
          `strip ${m[1]} has two colours`);
        byStrip.set(m[1], p.line.color);
      });
    });
  assert.ok(byStrip.size > 0, "no strip-labelled traces to check");
});

test("a channel the map cannot place keeps its channel label and colour", async () => {
  // No settings at all: every trace falls back to the old behaviour.
  const ev = REAL.events[3];
  const page = await boot([ev]);
  await pump(page, 3);
  const labels = graphOf(page).param.plot.map((p) => p.label);
  assert.ok(labels.every((l) => l.startsWith("ch ")),
    `unmapped hits should stay channel-labelled: ${labels}`);
});
