//
// The ATAR page, rendered against an experiment with nothing in it.
//
// That is not a degenerate case to be covered for completeness -- it is the
// state this page will be in for most of its life, and the state it was
// designed for. Most of its panels are blocked on DAQ work nobody has done, so
// "the ODB is empty and no analyzer is running" is the normal case, and a tab
// that renders a blank div in it has failed at its whole job.
//
// One suite parametrised over the tabs rather than one file each: they differ
// only in their catalogue entry, and four near-identical files would be four
// places to forget an assertion.
//
// Skipped automatically where node is unavailable; see tests/test_js.py.
//

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { runPage } = require(path.join(__dirname, "domstub.js"));

const JS = path.join(__dirname, "..", "..", "pages", "js");
globalThis.DQM = require(path.join(JS, "dqm-common.js"));
globalThis.DQMPanels = require(path.join(JS, "dqm-panels.js"));
globalThis.BRPC = require(path.join(JS, "dqm-brpc.js"));

//: The page the manifest registers. Kept here rather than derived from the
//: catalogue so that it silently vanishing from one of them is a failure.
const PAGE = "ATAR";

//: Its tabs, in order, by spec group id. Same reasoning: a tab that disappears
//: from the spec must fail here rather than quietly render three.
const TABS = ["atar_channels", "atar_scope", "atar_trends", "atar_proposed"];

//
// A bare experiment: no /DQM subtree, no equipment, no history, no analyzer.
// db_get_values returns status 312 (DB_NO_KEY) with a null beside it, which is
// what MIDAS actually does for a missing path -- not an error, an absence.
//
function emptyOdb() {
  return {
    db_get_values: (p) => ({ data: p.paths.map(() => null), status: p.paths.map(() => 312) }),
    db_get_value: (p) => ({ data: p.paths.map(() => null), status: p.paths.map(() => 312) }),
    db_ls: (p) => ({ data: p.paths.map(() => null) }),
    hs_get_events: () => ({ events: [] }),
    // mhttpd answers with JSON, not a binary reply, when it cannot reach the
    // named client -- which dqm-brpc.js turns into a throw.
    brpc: () => Promise.reject(new Error("no such client")),
  };
}

function bootPage(name, responses) {
  return runPage(path.join(JS, "dqm-page.js"), responses || emptyOdb(), { boot: name });
}

function tiles(page) { return page.root.byClass("dqm-tile"); }

//: Open one tab by clicking its button, the way a shifter does. The first tab
//: is already open after load(); clicking it again is harmless and keeps every
//: test below written the same way.
function openTab(page, group) {
  const button = page.doc.getElementById(`tab-${group}`);
  assert.ok(button, `no tab button for ${group}`);
  button.dispatch("click");
  return page.doc.getElementById(`tabpanel-${group}`);
}

function tabEntry(group) {
  return globalThis.DQMPanels.byPage(PAGE).tabs.find((t) => t.group === group);
}

function textOf(node) {
  return node.walk ? [...node.walk()].map((e) => e._text || "").join(" ") : String(node);
}

// --- the tab bar ------------------------------------------------------------

test("the page has a tab per spec group, in spec order", async () => {
  const page = bootPage(PAGE);
  await page.load();
  const bar = page.root.byClass("dqm-tabbar");
  assert.strictEqual(bar.length, 1, "expected exactly one tab bar");
  const labels = page.root.byClass("dqm-tab").map((b) => b.getAttribute("id"));
  assert.deepStrictEqual(labels, TABS.map((g) => `tab-${g}`));
});

test("only the open tab is built, and opening another builds it", async () => {
  const page = bootPage(PAGE);
  await page.load();

  // Lazily on purpose: mplot sizes a graph from its host div, and a host inside
  // a display:none tab measures zero, so a plot built while hidden comes back
  // blank with no error anywhere.
  const first = tabEntry(TABS[0]).elements.filter((e) => e.kind === "panel");
  assert.strictEqual(tiles(page).length, first.length,
    "a tab nobody has opened should not have been built");

  openTab(page, TABS[1]);
  const second = tabEntry(TABS[1]).elements.filter((e) => e.kind === "panel");
  assert.strictEqual(tiles(page).length, first.length + second.length,
    "opening a tab should build it and leave the built one alone");
});

test("opening a tab twice does not build it twice", async () => {
  const page = bootPage(PAGE);
  await page.load();
  openTab(page, TABS[1]);
  const after = tiles(page).length;
  openTab(page, TABS[0]);
  openTab(page, TABS[1]);
  assert.strictEqual(tiles(page).length, after,
    "a rebuilt tab would duplicate every tile and every timer in it");
});

test("exactly one tab is shown at a time", async () => {
  const page = bootPage(PAGE);
  await page.load();
  openTab(page, TABS[2]);
  const shown = TABS.filter((g) => page.doc.getElementById(`tabpanel-${g}`).style.display !== "none");
  assert.deepStrictEqual(shown, [TABS[2]]);
  const active = page.root.byClass("dqm-tab").filter((b) => b.classList.contains("active"));
  assert.strictEqual(active.length, 1, "exactly one tab button should be active");
});

for (const group of TABS) {
  const catalogue = tabEntry(group);
  const name = catalogue.name;

  test(`${name}: renders every panel with nothing in the ODB`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    const host = openTab(page, group);

    const panels = catalogue.elements.filter((e) => e.kind === "panel");
    assert.strictEqual(host.byClass("dqm-tile").length, panels.length,
      `expected one tile per panel in the catalogue`);
    for (const p of panels) {
      assert.ok(page.doc.getElementById(p.id), `no tile for ${p.id}`);
    }
  });

  test(`${name}: every panel names the question it answers`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    const host = openTab(page, group);
    // One .dqm-tile-q for the tab's own question, then one per panel that has
    // a question -- which, per tests/test_panels.py, is all of them.
    const questions = host.byClass("dqm-tile-q");
    const panels = catalogue.elements.filter((e) => e.kind === "panel");
    assert.strictEqual(questions.length, panels.length + 1);
  });

  test(`${name}: every blocked panel carries its own reason`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    openTab(page, group);

    for (const p of catalogue.elements) {
      if (p.kind !== "panel" || p.status !== "blocked") continue;
      const tile = page.doc.getElementById(p.id);
      const why = tile.byClass("dqm-empty-why");
      assert.strictEqual(why.length, 1, `${p.id} has no empty-state reason`);
      // The panel's own blocked_by, not a generic one. A shared sentence would
      // be worse than none: it would read as an answer.
      assert.strictEqual(why[0].textContent.trim(), p.blocked_by.trim(),
        `${p.id} is not showing its own blocked_by`);
    }
  });

  test(`${name}: says what would have been drawn, without drawing it`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    const host = openTab(page, group);
    for (const p of catalogue.elements) {
      if (p.kind !== "panel" || !p.sketch || p.sketch === "none") continue;
      const tile = page.doc.getElementById(p.id);
      assert.ok(tile.byClass("dqm-empty-what").length === 1, `${p.id} has no shape sentence`);
    }
    // No history plot is constructed on a tab where no panel can draw one.
    assert.strictEqual(host.byClass("mjshistory").length, 0);
  });

  test(`${name}: raises no dialog at the operator`, async () => {
    globalThis.__alerts = [];
    const page = bootPage(PAGE);
    await page.load();
    openTab(page, group);
    assert.deepStrictEqual(globalThis.__alerts, [],
      "an empty experiment must not produce a modal");
  });

  test(`${name}: is neither blank nor an error page`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    const host = openTab(page, group);
    assert.strictEqual(page.root.byClass("dqm-error").length, 0);
    assert.ok(host.byClass("dqm-tile").length > 0, "the tab rendered nothing at all");
    assert.ok(page.root.byClass("dqm-footnote").length > 0);
  });

  test(`${name}: the tab counts its own panels that are not drawing`, async () => {
    const page = bootPage(PAGE);
    await page.load();
    // Panels only: a note is not a plot that is missing.
    const waiting = catalogue.elements.filter(
      (e) => e.kind === "panel" && e.status !== "ready").length;
    const button = page.doc.getElementById(`tab-${group}`);
    const count = button.byClass("dqm-tabcount");
    if (!waiting) {
      assert.strictEqual(count.length, 0, "a tab that draws everything wears no number");
    } else {
      assert.strictEqual(count.length, 1);
      assert.strictEqual(count[0].textContent.trim(), String(waiting));
    }
  });
}

// --- the page itself --------------------------------------------------------

test("boots under its own name and sets the refresh interval", async () => {
  const page = bootPage(PAGE);
  await page.load();
  const init = page.calls.find((c) => c.method === "mhttpd_init");
  assert.ok(init, "mhttpd_init was never called");
  assert.strictEqual(init.params[0], PAGE);
  assert.ok(page.calls.some((c) => c.method === "refresh" && c.params === 1000));
});

test("says it is using built-in defaults when /DQM is absent", async () => {
  const page = bootPage(PAGE);
  await page.load();
  const feet = page.root.byClass("dqm-footnote").map((f) => f.textContent).join(" ");
  assert.match(feet, /built-in defaults/);
});

// --- the failure paths, which are the same path -----------------------------

test("a renderer that throws still leaves the reason in the panel", async () => {
  const page = bootPage(PAGE);
  const id = "channel_health";
  globalThis.DQMPage.register(id, () => { throw new Error("boom"); });
  await page.load();
  openTab(page, "atar_proposed");

  const tile = page.doc.getElementById(id);
  const why = tile.byClass("dqm-empty-why");
  assert.strictEqual(why.length, 1);
  assert.match(why[0].textContent, /failed to draw.*boom/);
  delete require.cache[require.resolve(path.join(JS, "dqm-page.js"))];
});

test("a renderer whose promise rejects still leaves the reason in the panel", async () => {
  const page = bootPage(PAGE);
  const id = "hits_per_event";
  globalThis.DQMPage.register(id, async () => { throw new Error("late boom"); });
  await page.load();

  const tile = page.doc.getElementById(id);
  const why = tile.byClass("dqm-empty-why");
  assert.strictEqual(why.length, 1);
  assert.match(why[0].textContent, /failed to draw.*late boom/);
});

test("a page with no catalogue entry says so rather than rendering nothing", async () => {
  const page = bootPage("NotAPage");
  await page.load();
  const err = page.root.byClass("dqm-error");
  assert.strictEqual(err.length, 1);
  assert.match(err[0].textContent, /No catalogue entry/);
});

// --- the analyzer probe -----------------------------------------------------

test("the page loads every renderer its tabs need", async () => {
  // The page opts into the analyzer probe by loading dqm-brpc.js; nothing else
  // gates it. Assert the HTML actually matches, because the gate is invisible
  // from the JS side. One page now, so it loads the lot -- a tab is not a
  // document boundary, and which of them the shifter opens is not something the
  // <head> can know.
  const fs = require("node:fs");
  const text = fs.readFileSync(
    path.join(__dirname, "..", "..", "pages", "atar.html"), "utf8");
  for (const asset of ["dqm-common.js", "dqm-panels.js", "dqm-page.js",
                       "dqm-brpc.js", "dqm-hists.js", "dqm-adbanks.js",
                       "dqm-scope.js"]) {
    assert.ok(text.includes(asset), `atar.html does not load ${asset}`);
  }
});

test("with no analyzer answering, the panels say which name was tried", async () => {
  const page = bootPage(PAGE);
  await page.load();
  const probes = page.root.byClass("dqm-probe");
  assert.ok(probes.length > 0, "the probe appended nothing");
  assert.match(probes[0].textContent, /No client answered dqm::list as "mdqm_analyzer"/);
});

test("a tab opened after the probe answered still carries its footnote", async () => {
  // The probe runs once, at boot, and most of the boxes it has something to say
  // about are on tabs nobody has opened yet. Caching the answer is what makes
  // the footnote the same wherever a shifter starts reading.
  const page = bootPage(PAGE);
  await page.load();
  const before = page.root.byClass("dqm-probe").length;
  openTab(page, "atar_proposed");
  const after = page.root.byClass("dqm-probe").length;
  assert.ok(after > before,
    "a blocked panel built after the probe answered got no footnote");
});

test("with an analyzer answering, the panels say what it publishes instead", async () => {
  const responses = emptyOdb();
  // dqm-brpc.js's list() decodes a binary reply; stub the decoded layer, which
  // is the data source, rather than the transport.
  globalThis.BRPC.list = async () => ["wd/persistence_ch00", "wd/amplitude_ch00"];
  const page = bootPage(PAGE, responses);
  await page.load();

  const probes = page.root.byClass("dqm-probe");
  assert.ok(probes.length > 0);
  // The panel names what it wanted and what the client has instead, which is
  // what makes the mismatch actionable. This asserted a phrasing the page has
  // never produced -- written in the same commit as the message and never run,
  // because the JS suite needs a node this repository's checkouts often lack.
  assert.match(probes[0].textContent, /"mdqm_analyzer" answers and does not publish/);
  assert.match(probes[0].textContent,
    /It publishes: wd\/persistence_ch00, wd\/amplitude_ch00\./);
});

// --- how often a big histogram is refetched ---------------------------------

test("a per-channel colormap is refetched far less often than a small histogram", () => {
  const H = require(path.join(__dirname, "..", "..", "pages", "js", "dqm-hists.js"));

  // The sizes this page actually asks for.
  assert.strictEqual(H.refreshFor(256), H.REFRESH_MS, "occupancy is small");
  assert.strictEqual(H.refreshFor(200), H.REFRESH_MS, "amplitude is small");
  assert.strictEqual(H.refreshFor(64 * 110), H.REFRESH_MS, "persistence is small");

  // 32 channels was small enough; 256 is not, which is the regression this
  // guards. Three of those at the small cadence is what made the tab crawl.
  assert.strictEqual(H.refreshFor(32 * 200), H.REFRESH_MS);
  const big = H.refreshFor(256 * 200);
  assert.ok(big > H.REFRESH_MS * 4, `256x200 still refetched every ${big} ms`);

  // The point of scaling rather than picking a number: above the threshold,
  // cells per second is constant, so doubling the channel count cannot make
  // the page cost twice as much again. Below it, a small histogram costs less
  // than that ceiling and is left alone.
  const rate = (cells) => cells / H.refreshFor(cells);
  const ceiling = H.BIG_HIST_CELLS / H.REFRESH_MS;
  // Flat only up to the cap: past it, "never slower than MAX_REFRESH_MS" wins
  // and the cost per second rises again. That is the deliberate trade -- a tile
  // that stops updating is worse than one that costs a little more -- and
  // 256 x 200 is comfortably under it.
  [256 * 200, 300 * 150, 40 * 200].filter(
    (c) => c > H.BIG_HIST_CELLS
        && H.refreshFor(c) < H.MAX_REFRESH_MS).forEach(function (cells) {
    assert.ok(Math.abs(rate(cells) - ceiling) < 1e-9,
      `${cells} bins costs ${rate(cells)} cells/ms, not the ${ceiling} ceiling`);
  });
  assert.ok(rate(32 * 200) < ceiling, "a small histogram should cost less");
  assert.strictEqual(H.refreshFor(512 * 200), H.MAX_REFRESH_MS,
    "past the cap it should sit at the cap, not keep slowing down");

  // And it never stops updating.
  assert.ok(H.refreshFor(10 ** 9) <= H.MAX_REFRESH_MS);
});
