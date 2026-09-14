//
// The five ODB panels on SlowControls.
//
// None of them can draw today, so most of what is tested here is the absent
// path -- which is the code that matters. "Waiting for ATAR_SC" and "ATAR_SC
// exists but has no Temperature key" send a shifter to different people, and a
// page that says the same thing for both is worse than one that says nothing,
// because it will be believed.
//
// The two Refresher tests exist because mhttpd's refresh loop has a contract
// that produces pages which are correct for exactly one second.
//

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { runPage, Refresher } = require(path.join(__dirname, "domstub.js"));

const JS = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(JS, "dqm-common.js"));
globalThis.DQMPanels = require(path.join(JS, "dqm-panels.js"));

const NOW = Math.floor(Date.now() / 1000);

/** An ODB with whatever /Equipment subtrees the test names. */
function odb(tree, events) {
  return {
    db_ls: (p) => ({ data: p.paths.map((x) => (x in tree ? tree[x] : null)) }),
    db_get_values: (p) => ({ data: p.paths.map(() => null), status: p.paths.map(() => 312) }),
    hs_get_events: () => ({ events: events || [] }),
    hs_get_tags: (p) => ({ events: [{ tags: (p.events || []).length ? TAGS : [] }] }),
  };
}

let TAGS = [];

async function boot(tree, events) {
  TAGS = [];
  const page = runPage(path.join(JS, "dqm-page.js"), odb(tree || {}, events),
                       { boot: "SlowControls", also: [path.join(JS, "dqm-slow.js")] });
  await page.load();
  return page;
}

function tile(page, id) { return page.doc.getElementById(id); }
function why(page, id) { return tile(page, id).byClass("dqm-empty-why").map((e) => e.textContent); }
function paths(node) {
  return node.findAll((e) => e.dataset.odbPath !== undefined).map((e) => e.dataset.odbPath);
}

// --- the four absent paths, each with its own sentence ----------------------

test("equipment that does not exist is named, with a way to correct the path", async () => {
  const page = await boot({});
  const text = why(page, "temperature_sensors")[0];
  assert.match(text, /Waiting for ATAR_SC/);
  assert.match(text, /\/Equipment\/ATAR_SC\/Variables does not exist/);
  // And the promise the panel is making: nothing on this side is missing.
  assert.match(text, /this panel draws itself/);

  const buttons = tile(page, "temperature_sensors").byClass("mbutton");
  assert.strictEqual(buttons.length, 1);
  buttons[0].dispatch("click");
  const edit = page.calls.find((c) => c.method === "dlgOdbEdit");
  assert.strictEqual(edit.params, "/DQM/SlowControls/Temperature Path");
});

test("equipment that exists with the wrong key lists what is actually there", async () => {
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": { Humidity: 41.0, Pressure: 980.0 },
  });
  const text = why(page, "temperature_sensors")[0];
  assert.match(text, /has no key "Temperature"/);
  // This is what turns a path typo into a ten-second fix rather than a
  // conversation with whoever wrote the frontend.
  assert.match(text, /What is there: Humidity, Pressure/);
});

test("a key written last week is shown but not vouched for", async () => {
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": {
      Temperature: [21.0, 21.5],
      "Temperature/key": { num_values: 2, last_written: NOW - 86400 },
    },
  });
  const body = tile(page, "temperature_sensors").byClass("dqm-tile-body")[0];
  assert.ok(body.classList.contains("dqm-stale"));
  const diag = tile(page, "temperature_sensors").byClass("dqm-diagnosis");
  assert.ok(diag.some((d) => /last written .* s ago/.test(d.textContent)));
});

test("a fresh key with no history says why there is no trend", async () => {
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": {
      Temperature: [21.0], "Temperature/key": { num_values: 1, last_written: NOW },
    },
  }, []);
  const feet = tile(page, "temperature_sensors").byClass("dqm-footnote")
    .map((f) => f.textContent).join(" ");
  assert.match(feet, /mlogger .* fixes its history schema at startup/);
  assert.strictEqual(page.root.byClass("mjshistory").length, 0);
});

// --- the present path -------------------------------------------------------

test("eight temperatures bind to eight indexed paths", async () => {
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": {
      Temperature: [20, 21, 22, 23, 24, 25, 26, 27],
      "Temperature/key": { num_values: 8, last_written: NOW },
    },
  });
  const bound = paths(tile(page, "temperature_sensors"));
  for (let i = 0; i < 8; i++) {
    assert.ok(bound.includes(`/Equipment/ATAR_SC/Variables/Temperature[${i}]`), `index ${i}`);
  }
});

test("a bare float is one chip, not a crash", async () => {
  // The shape trap this experiment will hit first: num_values is *absent* on a
  // true scalar, not 1, so anything reading meta.num_values without a fallback
  // produces zero cells and a panel that renders empty with no explanation.
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": { "Light level": 0.42, "Light level/key": {} },
  });
  const bound = paths(tile(page, "light_sensors"));
  assert.deepStrictEqual(bound, ["/Equipment/ATAR_SC/Variables/Light level"]);
  assert.strictEqual(tile(page, "light_sensors").byClass("dqm-empty-why").length, 0);
});

test("temperature trends inline; light level hides its trend behind a disclosure", async () => {
  TAGS = [{ name: "Temperature" }];
  const page = await boot({
    "/Equipment/ATAR_SC/Variables": {
      Temperature: [20, 21], "Temperature/key": { num_values: 2, last_written: NOW },
      "Light level": 0.42, "Light level/key": {},
    },
  }, ["ATAR_SC"]);

  // sketch: "trend" -- the question is temporal, so the graph is the panel.
  assert.strictEqual(tile(page, "temperature_sensors").byClass("mjshistory").length, 1);
  // sketch: "scalar" -- a trend tile would answer a question nobody asked, and
  // would cost a request a second for as long as it is open.
  assert.strictEqual(tile(page, "light_sensors").byClass("mjshistory").length, 0);
  assert.strictEqual(tile(page, "light_sensors").byTag("details").length, 1);
});

// --- the two refresh-loop traps ---------------------------------------------

test("a bias channel off its demand stays flagged across ten refresh ticks", async () => {
  const page = await boot({
    "/Equipment/ATAR_HV/Variables": {
      Measured: [-200, -250], "Measured/key": { num_values: 2, last_written: NOW },
    },
    "/Equipment/ATAR_HV/Settings": { Demand: [-250, -250], "Demand/key": { num_values: 2 } },
  });

  const r = new Refresher(page.root, {
    "/Equipment/ATAR_HV/Settings/Demand": [-250, -250],
    "/Equipment/ATAR_HV/Variables/Measured": [-200, -250],
  });
  r.run();

  const row = page.doc.getElementById("hv-0");
  assert.ok(row.classList.contains("alarm"), "50 V off a 5 V tolerance must flag");
  assert.strictEqual(page.doc.getElementById("hv-d-0").textContent, "50.0");
  assert.ok(!page.doc.getElementById("hv-1").classList.contains("alarm"));

  // The trap: mhttpd rewrites a modbvalue's innerHTML every tick while firing
  // onchange only on a change, so a delta computed in an onchange is right on
  // the tick it changed and blank on every tick after. The delta here is a
  // plain <td> the panel owns, fed by two array watchers.
  for (let i = 0; i < 10; i++) r.run();
  assert.strictEqual(page.doc.getElementById("hv-d-0").textContent, "50.0",
    "the delta did not survive the refresh loop");
  assert.ok(row.classList.contains("alarm"));
  assert.ok(page.doc.getElementById("alarm-hv_readback").classList.contains("red"));
});

test("a readback with no demand still shows the readback", async () => {
  const page = await boot({
    "/Equipment/ATAR_HV/Variables": {
      Measured: [-200], "Measured/key": { num_values: 1, last_written: NOW },
    },
  });
  const t = tile(page, "hv_readback");
  assert.ok(paths(t).includes("/Equipment/ATAR_HV/Variables/Measured[0]"));
  // Half an answer is the more informative half here: the point of the panel is
  // that nothing currently checks a setpoint against a readback at all.
  const diag = t.byClass("dqm-diagnosis").map((d) => d.textContent).join(" ");
  assert.match(diag, /nothing to compare it against/);
  assert.strictEqual(t.byClass("masked").length, 1);
});

test("leakage current is filled from one watcher, not eight cells", async () => {
  const page = await boot({
    "/Equipment/ATAR_HV/Variables": {
      Current: [0.1, 5.0], "Current/key": { num_values: 2, last_written: NOW },
    },
  });
  const t = tile(page, "leakage_current");
  // One ODB path for the whole array. Eight modbvalues would have their text
  // rewritten every tick, making per-channel colouring impossible.
  const bound = paths(t);
  assert.deepStrictEqual(bound, ["/Equipment/ATAR_HV/Variables/Current"]);

  const r = new Refresher(page.root, { "/Equipment/ATAR_HV/Variables/Current": [0.1, 5.0] });
  for (let i = 0; i < 10; i++) r.run();

  assert.strictEqual(page.doc.getElementById("leak-v-1").textContent, "5.00");
  assert.ok(page.doc.getElementById("leak-1").classList.contains("alarm"),
    "5 uA over a 2 uA warn must flag");
  assert.ok(!page.doc.getElementById("leak-0").classList.contains("alarm"));
});

// --- the panel that correctly has no code -----------------------------------

test("humidity keeps the one blocker on this page that is not a frontend", async () => {
  const page = await boot({});
  const text = why(page, "humidity_sensors")[0];
  assert.strictEqual(text.trim(),
    globalThis.DQMPanels.BY_ID.humidity_sensors.blocked_by.trim());
  assert.match(text, /no name for humidity/);
});

test("motion says plainly that there is nothing to read back", async () => {
  const page = await boot({});
  const feet = tile(page, "motion_readback").byClass("dqm-footnote")
    .map((f) => f.textContent).join(" ");
  assert.match(feet, /There are no actuators/);
});

test("motion puts the typed settings beside the readback", async () => {
  const page = await boot({
    "/Equipment/Motion/Variables": {
      Position: [1.0, 2.0, 3.0], "Position/key": { num_values: 3, last_written: NOW },
    },
    "/Equipment/Motion/Settings": { "Degrader thickness": 2.5, "ATAR rotation": 0.0 },
  });
  const bound = paths(tile(page, "motion_readback"));
  assert.ok(bound.includes("/Equipment/Motion/Variables/Position[2]"));
  // Putting the number somebody typed next to the number the stage reports is
  // the comparison; separately they say nothing.
  assert.ok(bound.includes("/Equipment/Motion/Settings/Degrader thickness"));
});
