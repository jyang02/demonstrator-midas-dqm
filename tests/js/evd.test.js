//
// The event display, headless, against Python-encoded frames.
//
// The feature that matters most here cannot be checked on the run file to hand:
// run00201 has no RF signal, so the S1 edge marker never appears. These tests
// synthesise a frame that does have one.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { runPage } = require("./domstub.js");

const PAGES = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(PAGES, "dqm-common.js"));
globalThis.WDBanks = require(path.join(PAGES, "dqm-wdbanks.js"));
globalThis.BRPC = require(path.join(PAGES, "dqm-brpc.js"));

const EVD = path.join(PAGES, "dqm-evd.js");
const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "scopeframe-cases.json"), "utf8")).cases;

/** The 16-channel case, decoded, so tests can adjust it before serving. */
function baseFrame() {
  const buf = Buffer.from(CASES[0].payload_b64, "base64");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return BRPC.decodeScopeFrame(ab);
}

async function bootEvd(frame, roles) {
  globalThis.__alerts = [];
  globalThis.localStorage = {
    _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; },
  };
  const page = runPage(EVD, {
    db_get_values: ({ paths }) => {
      if (paths[0].includes("Channel roles")) {
        return roles === null
          ? { data: [null], status: [312] }
          : { data: [roles], status: [1] };
      }
      return { data: [null], status: [1] };
    },
  });
  // The page reaches the analyzer through BRPC.scope; stub that rather than the
  // transport, so the frame under test is exactly what we constructed.
  globalThis.BRPC.scope = async () => frame;
  await page.load();
  for (let i = 0; i < 6; i++) { page.flushTimers(); await new Promise((r) => setImmediate(r)); }
  page.flushTimers();
  return page;
}

/** Serve `frame` and let the page's update chain settle. */
async function pump(page, frame) {
  globalThis.BRPC.scope = async () => frame;
  page.flushTimers();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  page.flushTimers();
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

function panelTitles(page) {
  return page.root.byClass("dqm-evd-title").map((t) => t.textContent);
}

function graphFor(page, index) {
  return page.root.byClass("dqm-evd-plot")[index].mpg;
}

// ---------------------------------------------------------------------------

test("every channel gets a panel, split big and small", async () => {
  const page = await bootEvd(baseFrame(), null);
  assert.strictEqual(page.root.byClass("dqm-evd-plot").length, 16);
  assert.strictEqual(page.root.byClass("dqm-evd-panel-big").length, 5,
    "the five waveform channels get the readable panels");
  assert.strictEqual(page.root.byClass("dqm-evd-panel-small").length, 11);
});

test("no dialog is raised at the operator", async () => {
  const page = await bootEvd(baseFrame(), null);
  assert.deepStrictEqual(globalThis.__alerts, [],
    `raised: ${globalThis.__alerts}`);
  assert.ok(page.root.byClass("dqm-evd-plot")[0].mpg);
});

test("the RF channel is coloured and labelled as RF", async () => {
  const page = await bootEvd(baseFrame(), null);
  const titles = panelTitles(page);
  assert.ok(titles.some((t) => /ch 05.*RF/.test(t)), titles.join(" | "));
  // ch 05 is the sixth channel, so the sixth graph.
  const g = graphFor(page, 5);
  assert.strictEqual(g.param.plot[0].line.color, "#ff7f0e");
});

test("a NIM channel that fired is green and flagged, one that did not is grey", async () => {
  const frame = baseFrame();
  // Flat baseline on ch07; a big excursion on ch08.
  frame.channels[7].volts = new Float32Array(1024);
  frame.channels[8].volts = new Float32Array(1024);
  frame.channels[8].volts[500] = -0.9;

  const page = await bootEvd(frame, null);
  const titles = panelTitles(page);
  assert.ok(titles.some((t) => /ch 07.*○/.test(t)), "unfired must read as unfired");
  assert.ok(titles.some((t) => /ch 08.*● fired/.test(t)), "fired must read as fired");
  assert.strictEqual(graphFor(page, 7).param.plot[0].line.color, "#b0b0b0");
  assert.strictEqual(graphFor(page, 8).param.plot[0].line.color, "#2ca02c");
});

test("the S1 edge is marked on the S1 panel AND the RF panel", async () => {
  // One line on one trace is a number; the same line on both is the phase
  // relationship, which is the thing you wanted to see.
  const frame = baseFrame();
  frame.derived.s1_time_smp = 300.5;
  frame.derived.rf_phase_deg = 123.4;
  frame.derived.rf_period_smp = 19.95;

  const page = await bootEvd(frame, null);

  for (const [idx, what] of [[0, "S1"], [5, "RF"]]) {
    const g = graphFor(page, idx);
    const marker = g.param.plot.find((p) => p.label === "s1 edge");
    assert.ok(marker, `${what} panel has no edge marker`);
    const data = g.data[g.param.plot.indexOf(marker)];
    assert.strictEqual(data.x.length, 2, "a vertical line is two points");
    assert.strictEqual(data.x[0], data.x[1], "and they share an x");
  }
  // ...and nowhere else.
  const g2 = graphFor(page, 2);
  assert.ok(!g2.param.plot.some((p) => p.label === "s1 edge"),
    "a marker on an unrelated channel would be meaningless");
});

test("the marker is dropped when the phase is invalid, not left stale", async () => {
  const withEdge = baseFrame();
  withEdge.derived.s1_time_smp = 300.5;
  const page = await bootEvd(withEdge, null);
  assert.ok(graphFor(page, 0).param.plot.some((p) => p.label === "s1 edge"));

  // Next event has no valid phase.
  const without = baseFrame();
  delete without.derived.s1_time_smp;
  // Different frameSeq, so the page treats it as a new event rather than a repeat.
  without.frameSeq = withEdge.frameSeq + 1;
  await pump(page, without);

  assert.ok(!graphFor(page, 0).param.plot.some((p) => p.label === "s1 edge"),
    "a stale marker would attach last event's timing to this event's trace");
});

test("an undecodable channel is greyed and says why, not omitted", async () => {
  const frame = BRPC.decodeScopeFrame(
    (() => {
      const buf = Buffer.from(CASES[1].payload_b64, "base64");
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    })());
  const page = await bootEvd(frame, null);
  const titles = panelTitles(page);
  assert.ok(titles.some((t) => /mode 11, not decodable/.test(t)),
    `must explain itself: ${titles.join(" | ")}`);
  assert.strictEqual(page.root.byClass("undecoded").length, 1);
});

test("channel roles come from the ODB when it has them", async () => {
  const page = await bootEvd(baseFrame(), {
    "waveform channels": [0, 1],
    "rf channel": 9,
    "nim channels": [2, 3],
    "labels": ["S1", "S2"],
  });
  assert.strictEqual(page.root.byClass("dqm-evd-panel-big").length, 2,
    "the ODB said two waveform channels");
  const titles = panelTitles(page);
  assert.ok(titles.some((t) => /ch 00 S1/.test(t)), `labels ignored: ${titles[0]}`);
  assert.ok(titles.some((t) => /ch 09.*RF/.test(t)), "the ODB moved the RF channel");
});

test("the status line reports the event, and says when there is no phase", async () => {
  // The stock fixture *has* a phase, so it has to be removed to test the
  // absence -- which is the case that needs explaining, not the presence.
  const frame = baseFrame();
  delete frame.derived.rf_phase_deg;
  const page = await bootEvd(frame, null);
  const diag = page.doc.getElementById("dqm-evd-diag").textContent;
  assert.ok(/run 201/.test(diag), diag);
  assert.ok(/event 4242/.test(diag), diag);
  assert.ok(/board 36/.test(diag), diag);
  assert.ok(/no S1→RF phase/.test(diag),
    "an absent marker must be explained, not just absent");
});

test("with a phase, it is shown rather than explained away", async () => {
  const frame = baseFrame();
  frame.derived.s1_time_smp = 300.5;
  frame.derived.rf_phase_deg = 123.4;
  frame.derived.rf_period_smp = 19.95;
  const page = await bootEvd(frame, null);
  const diag = page.doc.getElementById("dqm-evd-diag").textContent;
  assert.ok(/S1→RF 123\.4°/.test(diag), diag);
  assert.ok(!/no S1→RF/.test(diag));
});

test("no frame at all is explained, not drawn blank", async () => {
  const page = await bootEvd(null, null);
  const chip = page.doc.getElementById("dqm-evd-status");
  assert.strictEqual(chip.textContent, "no event");
  assert.ok(/run is active/.test(page.doc.getElementById("dqm-evd-diag").textContent));
});

test("common y scale puts every big panel on one range", async () => {
  const frame = baseFrame();
  const page = await bootEvd(frame, null);

  const box = page.doc.getElementById("dqm-evd-sharedy");
  box.checked = true;
  box.onchange.call(box);

  const ranges = [0, 1, 2, 3, 4].map((i) => {
    const g = graphFor(page, i);
    return [g.param.yAxis.min, g.param.yAxis.max];
  });
  for (const r of ranges) {
    assert.ok(Number.isFinite(r[0]) && Number.isFinite(r[1]), "range not set");
    assert.deepStrictEqual(r, ranges[0], "pulse heights must compare by eye");
  }
});

test("traces are reduced to the screen", async () => {
  const page = await bootEvd(baseFrame(), null);
  const g = graphFor(page, 0);
  assert.ok(g.data[0].y.length > 0);
  assert.ok(g.data[0].y.length <= 1024, "1024 samples min/max reduced per column");
});
