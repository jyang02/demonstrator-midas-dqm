//
// The Scope page, driven with real events out of run 108.
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
 * Boot Scope with a queue of events to hand out, one per poll.
 *
 * bm_receive_event answers binary for an event and JSON for "nothing there", so
 * the stub distinguishes them the way mhttpd does: a reply carrying `result` is
 * the empty case, one without it is an event.
 */
async function boot(events, cfgOverrides) {
  const queue = (events || []).slice();
  globalThis.bkToObj = (rpc) => rpc.__event;
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
  };

  const cfg = Object.assign({}, globalThis.DQM.DEFAULTS.Scope, cfgOverrides || {});
  const page = runPage(path.join(JS, "dqm-page.js"), {
    db_get_values: (p) => ({
      // /DQM/Scope comes back seeded; /DQM itself does not, which is the usual
      // half-configured state and exercises the merge.
      data: p.paths.map((x) => (x.endsWith("/Scope") ? cfg : null)),
      status: p.paths.map((x) => (x.endsWith("/Scope") ? 1 : 312)),
    }),
    db_ls: (p) => ({ data: p.paths.map(() => null) }),
    hs_get_events: () => ({ events: [] }),
    bm_receive_event: () => (queue.length
      ? Promise.resolve({ __event: asEvent(queue.shift()) })
      : Promise.resolve({ result: { status: 209 } })),
  }, { boot: "Scope", also: [path.join(JS, "dqm-adbanks.js"), path.join(JS, "dqm-scope.js")] });

  await page.load();
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

test("a real event reaches the traces and the table", async () => {
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

  // And the raw dump, from the same event.
  const rows = page.doc.getElementById("raw-table").byTag("tr");
  assert.strictEqual(rows.length, ev.decoded.nhits + 1, "one header plus one row per hit");
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

// --- the three that correctly have no renderer ------------------------------

for (const id of ["calo_waveforms", "event_display_position", "event_display_energy"]) {
  test(`${id} keeps its reason and gets no code`, async () => {
    const page = await boot([REAL.events[0]]);
    await pump(page, 2);
    const tile = page.doc.getElementById(id);
    const why = tile.byClass("dqm-empty-why");
    assert.strictEqual(why.length, 1);
    assert.strictEqual(why[0].textContent.trim(),
      globalThis.DQMPanels.BY_ID[id].blocked_by.trim());
  });
}


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

  const rows = page.doc.getElementById("raw-table").byTag("tr");
  assert.strictEqual(rows.length, ev.decoded.nhits + 1);
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
