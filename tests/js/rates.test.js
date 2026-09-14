//
// The live panels on Rates.
//
// Every interesting bug in a MIDAS custom page is in the wiring to mhttpd's
// refresh loop, not in the rendering, so that is what this file is mostly
// about. Two of its tests exist because the loop's contract is counter-
// intuitive in a way that produces a page which works in a browser for one
// second and then quietly stops being true.
//

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { runPage, Refresher } = require(path.join(__dirname, "domstub.js"));

const JS = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(JS, "dqm-common.js"));
globalThis.DQMPanels = require(path.join(JS, "dqm-panels.js"));

const EQ = ["SAMPIC", "Trigger", "ATAR_HV"];

function odb(opts = {}) {
  const equipment = opts.equipment === undefined ? EQ : opts.equipment;
  const trigger = opts.trigger || {};
  const dir = {};
  equipment.forEach((e) => { dir[e] = {}; });

  return {
    db_ls: (p) => ({
      data: p.paths.map(function (path_) {
        if (path_ === "/Equipment") return dir;
        if (path_ === "/Equipment/Trigger/Settings") return trigger;
        if (path_ === "/Equipment/SAMPIC/Settings") return opts.sampic || null;
        return null;
      }),
    }),
    db_get_values: (p) => ({ data: p.paths.map(() => null), status: p.paths.map(() => 312) }),
    hs_get_events: () => ({ events: opts.events || [] }),
  };
}

async function boot(opts) {
  const page = runPage(path.join(JS, "dqm-page.js"), odb(opts),
                       { boot: "Rates", also: [path.join(JS, "dqm-rates.js")] });
  await page.load();
  return page;
}

function tile(page, id) { return page.doc.getElementById(id); }
function paths(node) {
  return node.findAll((e) => e.dataset.odbPath !== undefined).map((e) => e.dataset.odbPath);
}

// --- midas_event_rate -------------------------------------------------------

test("every equipment gets its own Statistics chips", async () => {
  const page = await boot();
  const bound = paths(tile(page, "midas_event_rate"));
  for (const eq of EQ) {
    assert.ok(bound.includes(`/Equipment/${eq}/Statistics/Events per sec.`), eq);
    assert.ok(bound.includes(`/Equipment/${eq}/Statistics/Events sent`), eq);
  }
  // The alarm is about a counter stalling *while the run is running*, so the
  // panel has to show the run state to be allowed to make the claim.
  assert.ok(bound.includes("/Runinfo/State"));
  assert.ok(bound.includes("/Runinfo/Run number"));
});

test("with no equipment at all it says so, and does not claim to be blocked", async () => {
  const page = await boot({ equipment: [] });
  const why = tile(page, "midas_event_rate").byClass("dqm-empty-why");
  assert.strictEqual(why.length, 1);
  assert.match(why[0].textContent, /No equipment is registered/);
  // It is proposed, not blocked. Borrowing a blocked_by it does not have would
  // tell a shifter to wait for something that is not the problem.
  assert.doesNotMatch(why[0].textContent, /analyzer|fesampic|fetrigger/);
});

test("a counter that never moves while the run is running raises the alarm", async () => {
  const page = await boot();
  const values = {
    "/Runinfo/State": 3,
    "/Runinfo/Run number": 42,
    "/Equipment/SAMPIC/Statistics/Events sent": 1000,
    "/Equipment/Trigger/Statistics/Events sent": 1000,
    "/Equipment/ATAR_HV/Statistics/Events sent": 1000,
  };
  const r = new Refresher(page.root, values);

  // This is the regression test for the rule the whole panel is built around:
  // mhttpd calls a watcher's onload for its first value and fires onchange only
  // on *subsequent changes*, so a handler wired to onchange alone never runs
  // while a value is static -- which is exactly this scenario. If the watcher
  // in dqm-rates.js loses its onload, the alarm below never fires and a dead
  // frontend reads as healthy.
  r.run();
  assert.notStrictEqual(page.root.byClass("dqm-strip").length, 0);

  // Time passes with the counter still. The panel's own interval, not a timer
  // in the refresh loop, is what notices.
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  try {
    for (let i = 0; i < 6; i++) r.run();
    page.tick();
    const alarm = page.doc.getElementById("alarm-midas_event_rate");
    assert.ok(alarm.classList.contains("red"),
      "a stalled counter during a run must colour the diagnosis");
  } finally {
    Date.now = realNow;
  }
});

test("a stalled counter with the run stopped is not an alarm", async () => {
  const page = await boot();
  const r = new Refresher(page.root, {
    "/Runinfo/State": 1,                       // stopped
    "/Equipment/SAMPIC/Statistics/Events sent": 1000,
    "/Equipment/Trigger/Statistics/Events sent": 1000,
    "/Equipment/ATAR_HV/Statistics/Events sent": 1000,
  });
  const realNow = Date.now;
  Date.now = () => realNow() + 60000;
  try {
    for (let i = 0; i < 6; i++) r.run();
    page.tick();
    const alarm = page.doc.getElementById("alarm-midas_event_rate");
    assert.ok(!alarm.classList.contains("red"), "a stopped run is not a fault");
  } finally {
    Date.now = realNow;
  }
});

test("a trend tile only for equipment mlogger actually recorded", async () => {
  const page = await boot({ events: ["SAMPIC"] });
  const body = tile(page, "midas_event_rate");
  const summaries = body.byTag("summary").map((s) => s.textContent);
  assert.strictEqual(summaries.length, 1);
  assert.match(summaries[0], /SAMPIC/);
  // The other two get a button that opens a dialog, which costs no page area.
  const buttons = body.byClass("mbutton").map((b) => b.textContent);
  assert.ok(buttons.some((t) => /Trigger rate history/.test(t)));
  assert.ok(buttons.some((t) => /ATAR_HV rate history/.test(t)));
});

test("a history tile is built on open, not on load", async () => {
  const page = await boot({ events: ["SAMPIC"] });
  // Each MhistoryGraph reschedules its own ~1 Hz fetch for as long as it
  // exists, so building them at load costs the machine taking data one request
  // per second per panel nobody is looking at.
  assert.strictEqual(page.root.byClass("mjshistory").length, 0);

  const details = tile(page, "midas_event_rate").byTag("details")[0];
  details.dispatch("toggle");
  assert.strictEqual(page.root.byClass("mjshistory").length, 1);
});

// --- trigger_settings -------------------------------------------------------

test("a partly-deployed trigger shows every key, present or not", async () => {
  const page = await boot({ trigger: { Mode: "coincidence", Prescale: 1 } });
  const t = tile(page, "trigger_settings");

  assert.ok(t.findAll((e) => e.dataset.odbPath === "/Equipment/Trigger/Settings/Prescale").length);
  const masked = t.byClass("masked");
  assert.strictEqual(masked.length, 1, "the one absent key must still have a row");
  assert.strictEqual(masked[0].textContent, "absent");

  // The absent key's full path is on the page, so it can be checked against the
  // deployed build without reading this source.
  const text = [...t.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /\/Equipment\/Trigger\/Settings\/Coincidence window/);
  assert.match(text, /1 of 3 trigger settings are absent/);
});

test("a prescale that is not the expected one reddens, and stays red", async () => {
  const page = await boot({ trigger: { Mode: "coincidence", Prescale: 8,
                                       "Coincidence window": 20 } });
  const row = page.doc.getElementById("trig-Prescale");
  assert.ok(row.classList.contains("alarm"));

  const alarm = page.doc.getElementById("alarm-trigger_settings");
  assert.ok(alarm.classList.contains("red"));

  // The second refresh-loop rule: mhttpd rewrites a modbvalue's innerHTML on
  // every tick while firing onchange only on a change. Anything computed inside
  // an onchange is correct for one tick and then silently reverts. The alarm
  // here lives on the row, not in a cell's text, so ten ticks must not undo it.
  const r = new Refresher(page.root, { "/Equipment/Trigger/Settings/Prescale": 8 });
  for (let i = 0; i < 10; i++) r.run();
  assert.ok(row.classList.contains("alarm"), "the alarm did not survive the refresh loop");
  assert.ok(alarm.classList.contains("red"));
});

test("an expected prescale marks the alarm evaluable rather than met", async () => {
  const page = await boot({ trigger: { Mode: "coincidence", Prescale: 1,
                                       "Coincidence window": 20 } });
  const alarm = page.doc.getElementById("alarm-trigger_settings");
  assert.ok(alarm.classList.contains("yellow"));
  assert.ok(!alarm.classList.contains("red"));
});

test("no trigger equipment at all falls back to the catalogue's own reason", async () => {
  const page = await boot({ trigger: null });
  const t = tile(page, "trigger_settings");
  const why = t.byClass("dqm-empty-why");
  assert.strictEqual(why.length, 1);
  assert.strictEqual(why[0].textContent.trim(),
    globalThis.DQMPanels.BY_ID.trigger_settings.blocked_by.trim());
});

test("sixty-four thresholds are summarised, not listed in the panel", async () => {
  const values = Array.from({ length: 64 }, (_, i) => 100 + i);
  const page = await boot({
    trigger: { Mode: "coincidence", Prescale: 1, "Coincidence window": 20 },
    sampic: { Threshold: values, "Threshold/key": { num_values: 64 } },
  });
  const t = tile(page, "trigger_settings");
  const text = [...t.walk()].map((e) => e._text || "").join(" ");
  assert.match(text, /min/);
  assert.match(text, /all 64 channels/);
  // Every channel is reachable, but behind a disclosure rather than above the
  // three settings the shift question is actually about.
  const details = t.byTag("details");
  assert.strictEqual(details.length, 1);
});
