//
// End-to-end render test for the scaler page, driven by the real page script
// against fixtures captured from a live ODB. No browser, no jsdom.
//
// This exists because every interesting bug in this page is in the wiring --
// which ODB path a cell binds to, whether a scalar bank survives discovery,
// whether the staleness logic actually fires -- and none of that is visible to
// a unit test of the helpers alone.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { runPage } = require("./domstub.js");

const PAGES = path.join(__dirname, "..", "..", "pages", "js");
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));

// dqm-common.js defines the DQM global the page script needs.
require(path.join(PAGES, "dqm-common.js"));
globalThis.DQM = require(path.join(PAGES, "dqm-common.js"));

const SCALARS = path.join(PAGES, "dqm-scalars.js");

/** RPC responses matching the live experiment. */
function liveResponses(overrides = {}) {
  return Object.assign({
    db_get_values: ({ paths }) => {
      // The config subtree does not exist on a fresh experiment: status 312.
      if (paths[0] === "/DQM/Scalars") return { data: [null], status: [312] };
      return { data: [null], status: [1] };
    },
    db_ls: ({ paths }) => ({
      data: paths.map((p) => {
        if (p === "/Equipment") return FX.equipment_ls;
        const m = /^\/Equipment\/([^/]+)\/(Variables|Settings)$/.exec(p);
        if (!m) return null;
        const [, eq, sub] = m;
        return (sub === "Variables" ? FX.variables_ls : FX.settings_ls)[eq] || {};
      }),
    }),
    hs_get_events: () => ({ events: FX.hs_events }),
    hs_get_tags: () => ({ events: FX.hs_tags }),
  }, overrides);
}

async function boot(overrides, opts) {
  const page = runPage(SCALARS, liveResponses(overrides), opts);
  await page.load();
  page.flushTimers();
  return page;
}

// ---------------------------------------------------------------------------

test("the page discovers the board and builds a panel for it", async () => {
  const page = await boot();
  const text = page.root.textContent;
  assert.ok(text.includes("WDScalers"), "equipment name missing");
  assert.ok(text.includes("board 036"), `board panel missing; got: ${text.slice(0, 200)}`);
});

test("mhttpd_init is called with the page name from the URL, before discovery", async () => {
  const page = await boot(undefined, { params: { page: "WDScalers" } });
  const init = page.calls.find((c) => c.method === "mhttpd_init");
  assert.ok(init, "mhttpd_init was never called");
  assert.strictEqual(init.params[0], "WDScalers",
    "the page name must come from the URL so a prefixed registration still highlights");
  // It must precede the first RPC, or a page that is still discovering has no
  // header and no connection-lost handling.
  assert.ok(page.calls.indexOf(init) < page.calls.findIndex((c) => c.method === "db_ls"));
});

test("a missing config subtree falls back to built-ins and says so", async () => {
  const page = await boot();
  assert.ok(page.root.textContent.includes("built-in defaults"),
    "the page must admit when it is not using the ODB config");
});

test("every scaler gets a row, fed from one array watcher", async () => {
  const page = await boot();
  for (let i = 0; i < 19; i++) {
    assert.ok(page.doc.getElementById(`rate-WDScalers-036-${i}`), `no cell for scaler ${i}`);
  }
  // One ODB path per board rather than nineteen. The rate cells are deliberately
  // NOT modbvalue: mhttpd rewrites a modbvalue's innerHTML on every tick but
  // fires onchange only on change, so a "masked" label would survive exactly one
  // tick before reverting to "-1".
  const values = watcherFor(page, "S036");
  assert.ok(values, "no array watcher on the rates bank");
  assert.strictEqual(page.root.findAll((e) => e.dataset.odbPath &&
    e.dataset.odbPath.includes("/Variables/S036[")).length, 0);
});

test("a masked channel stays masked across repeated identical reads", async () => {
  // The regression this restructuring exists for: mhttpd rewrites innerHTML
  // every tick and calls onchange only on change, so anything that renders text
  // from an onchange handler reverts as soon as the value stops changing.
  const rates = new Array(19).fill(0);
  rates[5] = -1;
  const { page, cells } = await bootAndFeed(rates, FX.variables_ls.WDScalers.T036);
  assert.strictEqual(cells[5].textContent, "masked");

  // Several more ticks with no change at all.
  for (let i = 0; i < 5; i++) page.tick();
  assert.strictEqual(cells[5].textContent, "masked", "the label must not revert");
  assert.ok(cells[5].classList.contains("masked"));
});

test("rows are labelled from Settings/Names, not by index", async () => {
  const page = await boot();
  assert.ok(page.root.textContent.includes("ch00"));
  assert.ok(page.root.textContent.includes("ext_clk"));
});

test("thresholds are bound read-only", async () => {
  const page = await boot();
  const thr = page.root.findAll((e) => e.dataset.odbPath &&
    e.dataset.odbPath.includes("/Variables/D036["));
  assert.strictEqual(thr.length, 16);
  assert.ok(thr.every((c) => c.dataset.odbEditable === undefined),
    "a threshold under Variables is rewritten every poll; an edit box would be a trap");
  assert.ok(page.root.textContent.includes("read-only"),
    "the page must explain why thresholds cannot be edited here");
});

test("the record checkbox is editable and points at Settings/Enabled", async () => {
  const page = await boot();
  const boxes = page.root.findAll((e) => e.classList.contains("modbcheckbox"));
  assert.strictEqual(boxes.length, 19);
  assert.strictEqual(boxes[3].dataset.odbPath, "/Equipment/WDScalers/Settings/Enabled S036[3]");
  assert.strictEqual(boxes[3].dataset.odbEditable, "1");
});

test("a timestamp watcher is installed on the T bank", async () => {
  const page = await boot();
  const watcher = watcherFor(page, "T036");
  assert.ok(watcher, "no modb watcher on the timestamp bank");
  assert.strictEqual(watcher.dataset.odbPath, "/Equipment/WDScalers/Variables/T036");
  assert.strictEqual(typeof watcher.onchange, "function");
});

test("history graphs are NOT built until the section is opened", async () => {
  const page = await boot();
  assert.strictEqual(page.root.byClass("mjshistory").length, 0,
    "each MhistoryGraph self-polls at ~1 Hz; building them eagerly costs "
    + "hs_read_arraybuffer per second for plots nobody has looked at");

  const details = page.root.byTag("details")[0];
  assert.ok(details, "no trends section");
  details.open = true;
  details.dispatch("toggle");
  page.flushTimers();

  const graphs = page.root.byClass("mjshistory");
  assert.ok(graphs.length > 0, "opening the section must build the graphs");
  assert.ok(graphs[0].dataset.historyVar.startsWith("WDScalers/S036:ch00"));
});

test("embedded history panels never use index 0", async () => {
  const page = await boot();
  const details = page.root.byTag("details")[0];
  details.open = true;
  details.dispatch("toggle");
  page.flushTimers();

  for (const div of page.root.byClass("mjshistory")) {
    for (const [index] of div.mhg.panels) {
      // MhistoryGraph.draw() calls updateURL() when plotIndex === 0, which
      // replaceState()s a frozen time window onto the page URL.
      assert.notStrictEqual(index, 0, "index 0 rewrites the page URL on every draw");
    }
  }
});

test("the DAQ health panel lists every equipment, ours or not", async () => {
  const page = await boot();
  const text = page.root.textContent;
  assert.ok(text.includes("DAQ health"));
  assert.ok(text.includes("WDWaveforms"),
    "the health panel is generic and must list equipment we do not own");
});

// ---------------------------------------------------------------------------
// Live behaviour
// ---------------------------------------------------------------------------

function watcherFor(page, bank) {
  return page.root.find((e) => e.getAttribute("name") === "modb" &&
    e.dataset.odbPath.endsWith(`/Variables/${bank}`));
}

async function bootAndFeed(rates, ts) {
  const page = await boot();
  const clock = watcherFor(page, "T036");
  clock.value = ts;
  clock.onchange();
  const values = watcherFor(page, "S036");
  values.value = rates;
  values.onchange();
  const cells = [];
  for (let i = 0; i < 19; i++) cells.push(page.doc.getElementById(`rate-WDScalers-036-${i}`));
  return { page, cells };
}

test("a masked scaler reads as masked, not as 0 Hz", async () => {
  const rates = new Array(19).fill(0);
  rates[5] = -1;
  const { cells } = await bootAndFeed(rates, FX.variables_ls.WDScalers.T036);
  assert.ok(cells[5].classList.contains("masked"));
  assert.strictEqual(cells[5].textContent, "masked");
  assert.ok(!cells[0].classList.contains("masked"), "a real 0 Hz is not masked");
});

test("the sum covers input channels only, not triggers or the clock", async () => {
  const rates = new Array(19).fill(0);
  rates[0] = 100; rates[1] = 200;      // channels
  rates[16] = 5000; rates[17] = 6000;  // ptrn_trg, ext_trg
  rates[18] = 80e6;                    // ext_clk
  const { page } = await bootAndFeed(rates, FX.variables_ls.WDScalers.T036);
  const chip = page.doc.getElementById("chip-sum-WDScalers-036");
  assert.strictEqual(chip.textContent, (300).toLocaleString(),
    "trigger counters and the external clock are not per-channel rates");
});

test("all-zero with a live timestamp is reported as genuinely zero", async () => {
  const { page } = await bootAndFeed(new Array(19).fill(0), FX.variables_ls.WDScalers.T036);
  const diag = page.doc.getElementById("diag-WDScalers-036");
  assert.ok(diag.textContent.includes("genuinely 0 Hz"),
    "this is the case people misread as a dead readout");
  assert.ok(diag.textContent.includes("not a dead readout"));
});

test("the stale firmware flag is surfaced", async () => {
  const ts = ["0x90c1849e", "0x00000017", "0x00000001"];   // stale = 1
  const { page } = await bootAndFeed(new Array(19).fill(1), ts);
  const chip = page.doc.getElementById("chip-live-WDScalers-036");
  assert.strictEqual(chip.textContent, "stale");
  assert.ok(page.doc.getElementById("diag-WDScalers-036").textContent
    .includes("repeat the previous read"));
});

test("a frontend that stops updating turns the page red and dates the values", async () => {
  const rates = new Array(19).fill(42);
  const { page } = await bootAndFeed(rates, FX.variables_ls.WDScalers.T036);

  // No further onchange: the ODB keys persist, so without this the numbers
  // would go on looking live forever. That is the failure that matters.
  const key = "WDScalers-036";
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now + 37_000;
  try {
    page.tick();
  } finally {
    Date.now = realNow;
  }

  const chip = page.doc.getElementById(`chip-live-${key}`);
  const diag = page.doc.getElementById(`diag-${key}`);
  assert.ok(chip.classList.contains("red"), "chip must go red");
  assert.ok(/no new reads for 3[67] s/.test(chip.textContent), chip.textContent);
  assert.ok(diag.textContent.includes("not current"), diag.textContent);
  assert.ok(/last values seen at /.test(diag.textContent),
    "the diagnosis must date the values it is showing");

  const row = page.doc.getElementById(`row-${key}-0`);
  assert.ok(row.classList.contains("stale"), "rows must be visibly de-emphasised");
});

test("the rate bar chart excludes triggers, the clock and masked channels", async () => {
  const rates = new Array(19).fill(0);
  rates[0] = 100; rates[1] = -1; rates[2] = 300;
  rates[16] = 5000; rates[17] = 6000; rates[18] = 80e6;
  const { page } = await bootAndFeed(rates, FX.variables_ls.WDScalers.T036);
  const plot = page.doc.getElementById("plot-WDScalers-036");
  const { x, y } = plot.mpg.data[0];
  assert.ok(!x.includes("ext_clk"), "80 MHz would flatten every real channel");
  assert.ok(!x.includes("ptrn_trg"));
  assert.ok(!x.includes("ch01"), "a masked -1 must not be plotted as a value");
  assert.deepStrictEqual(y.filter((v) => v > 0).sort((a, b) => a - b), [100, 300]);
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

test("an experiment with no scaler equipment gets a diagnosis, not a blank page", async () => {
  const page = await boot({
    db_ls: ({ paths }) => ({
      data: paths.map((p) => (p === "/Equipment" ? { Other: {} } : { "Trigger Rate": 1.0 })),
    }),
  });
  const text = page.root.textContent;
  assert.ok(text.includes("No scaler equipment found"));
  assert.ok(text.includes("Bank Pattern") || text.includes("([STXD])"),
    "it must say what it looked for");
  assert.ok(text.includes("Other"), "it must show what the experiment does have");
  assert.ok(text.includes("Trigger Rate"), "including the keys that failed to match");
});

test("history failing does not stop the page rendering", async () => {
  const page = await boot({
    hs_get_events: () => { throw new Error("no history channel"); },
  });
  assert.ok(page.root.textContent.includes("board 036"),
    "history is a bonus, never a hard failure");
});

test("a board with only a rates bank still renders", async () => {
  const page = await boot({
    db_ls: ({ paths }) => ({
      data: paths.map((p) => {
        if (p === "/Equipment") return { Eq: {} };
        if (p.endsWith("/Variables")) {
          return { "S007": [1, 2], "S007/key": { type: 7, num_values: 2 } };
        }
        return {};
      }),
    }),
  });
  const text = page.root.textContent;
  assert.ok(text.includes("board 007"));
  assert.ok(page.doc.getElementById("rate-Eq-007-0"));
  assert.ok(page.doc.getElementById("rate-Eq-007-1"));
});
