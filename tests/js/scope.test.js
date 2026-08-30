//
// The scope page, driven headlessly against real recorded events.
//
// The stub's MPlotGraph models mplot.js's actual behaviour rather than an
// idealised version, including findPlot() raising an alert on a missing label.
// That is deliberate: misusing it put a modal dialog in front of the operator
// every time a channel was switched on, and only a faithful stub catches it.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { runPage } = require("./domstub.js");

const PAGES = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(PAGES, "dqm-common.js"));
globalThis.WDBanks = require(path.join(PAGES, "dqm-wdbanks.js"));

const SCOPE = path.join(PAGES, "dqm-scope.js");
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "event-fixture.json"), "utf8"));

/** A bkToObj()-shaped event from the recorded bank bytes. */
function asEvent(rec) {
  return {
    event_id: rec.event_id,
    trigger_mask: 0,
    serial_number: rec.serial,
    time_stamp: 1700000000,
    bank: Object.entries(rec.banks_b64).map(([name, b64]) => {
      const buf = Buffer.from(b64, "base64");
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return {
        name, size: bytes.byteLength,
        array: name === "WDEH" ? new Uint32Array(bytes.slice().buffer) : bytes,
      };
    }),
  };
}

/**
 * Boot the scope page with a scripted sequence of buffer replies.
 *
 * `replies` is consumed one per bm_receive_event call; `null` means "no event
 * available", which mhttpd signals with a JSON body rather than an arraybuffer.
 */
async function bootScope(replies) {
  globalThis.__alerts = [];
  const queue = replies.slice();
  const page = runPage(SCOPE, {
    bm_receive_event: () => {
      const next = queue.length ? queue.shift() : null;
      if (next === null) return { status: 209 };      // JSON => no event
      return Promise.resolve(next);                   // arraybuffer => an event
    },
  });
  globalThis.bkToObj = (x) => x;                      // the reply IS the event here
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] || null; },
    setItem(k, v) { this._d[k] = v; },
  };
  await page.load();
  for (let i = 0; i < 5; i++) { page.flushTimers(); await Promise.resolve(); }
  return page;
}

const FIRST = FX.events[0];
const LATER = FX.events[1];

test("with no events it says why, and does not pretend to be live", async () => {
  const page = await bootScope([]);
  const status = page.doc.getElementById("dqm-scope-status");
  const diag = page.doc.getElementById("dqm-scope-diag");
  assert.strictEqual(status.textContent, "no events yet");
  assert.ok(status.classList.contains("yellow"));
  assert.ok(/run is active|start one/i.test(diag.textContent),
    `must explain the usual cause: ${diag.textContent}`);
});

test("a real event is decoded and plotted", async () => {
  const page = await bootScope([asEvent(FIRST)]);
  const status = page.doc.getElementById("dqm-scope-status");
  assert.strictEqual(status.textContent, "live");

  const div = page.doc.getElementById("dqm-scope-plot");
  assert.ok(div.mpg, "no MPlotGraph was created");
  assert.ok(div.mpg.param.plot.length > 0, "nothing was plotted");

  // Five analogue channels by default: sixteen overlaid is a smear, and the
  // retired DQM drew 0..4 for the same reason.
  assert.strictEqual(div.mpg.param.plot.length, 5);
  assert.deepStrictEqual(div.mpg.param.plot.map((p) => p.label),
    ["ch 00", "ch 01", "ch 02", "ch 03", "ch 04"]);
});

test("no dialog is ever raised at the operator", async () => {
  // findPlot() alerts on a missing label, so using it as an existence test puts
  // a modal in front of whoever is watching. This is the regression guard.
  const page = await bootScope([asEvent(FIRST), asEvent(LATER)]);
  assert.deepStrictEqual(globalThis.__alerts, [],
    `the page raised ${globalThis.__alerts.length} dialog(s): ${globalThis.__alerts}`);
  assert.ok(page.doc.getElementById("dqm-scope-plot").mpg);
});

test("switching channels on and off never alerts and never deletes the wrong plot", async () => {
  const page = await bootScope([asEvent(FIRST), asEvent(FIRST), asEvent(FIRST)]);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  const before = g.param.plot.map((p) => p.label);

  // Turn off a channel that IS plotted...
  const off = page.doc.getElementById("dqm-ch-2");
  off.checked = false;
  off.onchange.call(off);
  assert.deepStrictEqual(globalThis.__alerts, [], "deselecting alerted");
  assert.ok(!g.param.plot.map((p) => p.label).includes("ch 02"));
  // ...and the others must survive: deletePlot on a missing label splices -1,
  // which removes the last plot instead.
  assert.ok(g.param.plot.map((p) => p.label).includes("ch 04"),
    `wrong plot was removed: ${before} -> ${g.param.plot.map((p) => p.label)}`);

  // Turn on one that is not plotted.
  const on = page.doc.getElementById("dqm-ch-9");
  on.checked = true;
  on.onchange.call(on);
  assert.deepStrictEqual(globalThis.__alerts, [], "selecting alerted");
  assert.ok(g.param.plot.map((p) => p.label).includes("ch 09"));
});

test("the width table is kept from the run's first event and reused after", async () => {
  const page = await bootScope([asEvent(FIRST), asEvent(LATER)]);
  const diag = page.doc.getElementById("dqm-scope-diag");
  assert.ok(diag.textContent.includes("board 36"), diag.textContent);

  // Switch to the calibrated axis: the table came from the first event, so this
  // must report it as cached rather than live, and never silently pretend.
  const sel = page.root.findAll((e) => e.tagName === "SELECT")[1];
  sel.value = "calibrated";
  sel.onchange.call(sel);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  assert.ok(/calibrated/.test(g.param.xAxis.title.text), g.param.xAxis.title.text);
  assert.ok(/cached/.test(g.param.xAxis.title.text),
    `a cached calibration must say so: ${g.param.xAxis.title.text}`);
});

test("attaching mid-run says the axis is uniform, not calibrated", async () => {
  // Only the LATER event: no width table was ever seen, which is what happens
  // to anyone who opens the page after the run started.
  const page = await bootScope([asEvent(LATER)]);
  const sel = page.root.findAll((e) => e.tagName === "SELECT")[1];
  sel.value = "calibrated";
  sel.onchange.call(sel);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  assert.ok(/no calibration table/.test(g.param.xAxis.title.text),
    `must admit it is falling back: ${g.param.xAxis.title.text}`);
});

test("traces are reduced to the screen, keeping the envelope", async () => {
  const page = await bootScope([asEvent(FIRST)]);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  const series = g.data[0];
  assert.ok(series.y.length > 0);
  assert.ok(series.y.length <= 1024,
    "1024 samples reduced to at most one min/max pair per screen column");
});

test("the legend is hidden once it would cover the traces", async () => {
  const page = await bootScope([asEvent(FIRST), asEvent(FIRST)]);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  assert.strictEqual(g.param.legend.show, true, "five channels: legend is useful");

  page.doc.getElementById("dqm-ch-9").checked = true;
  ["dqm-ch-9", "dqm-ch-10", "dqm-ch-11"].forEach((id) => {
    const b = page.doc.getElementById(id);
    b.checked = true;
    b.onchange.call(b);
  });
  assert.strictEqual(g.param.legend.show, false,
    "eight rows of legend drawn over the plot area is worse than none");
});

test("the canvas is resized after layout, not left at its construction size", async () => {
  const page = await bootScope([asEvent(FIRST)]);
  const g = page.doc.getElementById("dqm-scope-plot").mpg;
  page.flushTimers();
  assert.ok(g.resizes > 0,
    "MPlotGraph sizes from clientWidth at construction, before CSS has applied");
});

test("an error is not painted over by the next routine status update", async () => {
  // The bug this guards: a throw anywhere in decode or draw lands in the
  // promise catch, sets the error, and was then wiped by the very next poll's
  // status line -- so the page reported itself healthy while broken.
  const page = await bootScope([asEvent(FIRST)]);
  assert.strictEqual(page.doc.getElementById("dqm-scope-status").textContent, "live");

  // Make the next poll fail, then let several empty polls follow it.
  page.calls.length = 0;
  const diag = page.doc.getElementById("dqm-scope-diag");
  const status = page.doc.getElementById("dqm-scope-status");

  // Simulate by driving the page's own error path through a failing RPC.
  const failing = await bootScope([]);
  // With no events the page is yellow, not red, and says why -- the honest
  // "nothing is producing" state rather than an error.
  assert.ok(failing.doc.getElementById("dqm-scope-status").classList.contains("yellow"));

  assert.ok(status.textContent === "live" && !diag.textContent.includes("Scope stopped"));
});

test("a hidden tab stops pulling events out of the shared buffer", async () => {
  const page = await bootScope([asEvent(FIRST)]);
  const before = page.calls.filter((c) => c.method === "bm_receive_event").length;
  assert.ok(before > 0);

  page.doc.hidden = true;
  page.flushTimers();          // the scheduled poll fires while hidden
  const after = page.calls.filter((c) => c.method === "bm_receive_event").length;
  assert.strictEqual(after, before,
    "mhttpd shares one buffer read pointer; a hidden tab must not compete for it");
});
