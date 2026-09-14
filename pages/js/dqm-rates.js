//
// dqm-rates.js -- the live panels on the Rates page.
//
// Two of the nine, and they are the only two on this page that can be written
// at all today. The other seven wait on a counting equipment nobody has built:
// there is no fetrigger, no fecalo, no femupix, and so no /Equipment/<name>/
// Variables key carrying a rate and nothing for MIDAS history to trend. They
// render the reason instead, from the catalogue, with no code here.
//
//   midas_event_rate  -- is anything arriving at all. The one panel in the
//                        whole page set that requires nothing new: MIDAS
//                        maintains Statistics for any equipment that exists.
//   trigger_settings  -- what the rates above are divided by. Every one of its
//                        four keys is absent today, and the panel is built to
//                        make a *partial* deployment visible rather than
//                        silently half-right.
//

(function () {
"use strict";

const { el, modb, watch, chip, blocked, editButton, setAlarm } = DQMPage;

//: How long an event counter may stand still, while the run is marked running,
//: before this page stops believing data is arriving. Two mhttpd refresh
//: periods plus slack.
const STALL_S = 5;

//: MIDAS run state 3 is "running". A stalled counter with the run stopped is
//: not a fault, it is a stopped run.
const STATE_RUNNING = 3;

// Per-equipment: when its counter last moved, and the chip to colour.
const seen = {};
let runState = null;
let stallTimer = null;

// ---------------------------------------------------------------------------
// Is anything arriving, and how much of it?
// ---------------------------------------------------------------------------

DQMPage.register("midas_event_rate", async function (ctx) {
  const named = DQM.asArray(ctx.cfg["Rate Equipment"]).filter((s) => s);
  let equipment = named;

  if (!equipment.length) {
    // db_ls rather than db_get_values, and not only out of habit: the latter
    // lower-cases every key name, and an equipment called ATAR_SC would come
    // back as atar_sc and never match a configured path again.
    const ls = await DQM.lsODB(["/Equipment"]);
    equipment = Object.keys(ls[0] || {}).filter((k) => !k.endsWith("/key")).sort();
  }

  if (!equipment.length) {
    // Deliberately not this panel's blocked_by: it has none. It is *proposed*,
    // not blocked, and nothing about it is waiting on a decision. What it is
    // waiting for is a frontend, which is a different sentence.
    blocked(ctx.body,
      "No equipment is registered in this experiment, so there is nothing to "
      + "count. That is not a DQM problem and there is nothing to fix here: "
      + "start a frontend, and this panel fills itself in.",
      ctx.panel, `${DQM.CONFIG_ROOT}/Rates/Rate Equipment`);
    return;
  }

  ctx.body.appendChild(runStrip());
  equipment.forEach(function (eq) { ctx.body.appendChild(equipmentStrip(eq, ctx)); });
  await attachTrends(ctx, equipment);

  // One interval for the whole panel, reading timestamps the watchers recorded.
  // No network traffic at all: every value on this panel is already arriving on
  // mhttpd's own refresh loop, and asking again would be work inside the
  // process serving run control for an answer it just gave us.
  if (stallTimer === null) stallTimer = setInterval(checkStalled, 1000);
});

function runStrip() {
  // The alarm is "the counter stops moving *while the run is marked running*".
  // A panel that cannot show the run state cannot make that claim, so the run
  // state is part of the panel rather than something to look up elsewhere.
  const strip = el("div", { class: "dqm-strip" });
  strip.appendChild(chip("run", modb("span", "/Runinfo/Run number")));
  strip.appendChild(chip("state", modb("span", "/Runinfo/State", { id: "rates-state" })));
  strip.appendChild(watch("/Runinfo/State", function (v) { runState = Number(v); }));
  return strip;
}

function equipmentStrip(eq, ctx) {
  const base = `/Equipment/${eq}`;
  seen[eq] = { at: null, events: null };

  const strip = el("div", { class: "dqm-strip", id: `eq-${eq}` });
  strip.appendChild(el("b", {}, eq));
  strip.appendChild(chip("status", modb("span", `${base}/Common/Status`)));
  strip.appendChild(chip("frontend", modb("span", `${base}/Common/Frontend name`)));
  strip.appendChild(chip("events", modb("span", `${base}/Statistics/Events sent`)));
  strip.appendChild(chip("rate", modb("span", `${base}/Statistics/Events per sec.`,
                                      { format: "f1" }), "/s"));
  strip.appendChild(chip("data", modb("span", `${base}/Statistics/kBytes per sec.`,
                                      { format: "f1" }), "kB/s"));

  // onload as well as onchange, and the pairing is the whole trick: mhttpd
  // stores a watcher's first value silently and calls onload for it, firing
  // onchange only on subsequent *changes*. A handler wired to onchange alone
  // never runs while the value is static -- which is exactly the dead-frontend
  // case, i.e. precisely when this panel has something to say.
  strip.appendChild(watch(`${base}/Statistics/Events sent`, function (v) {
    const n = Number(v);
    if (seen[eq].events !== n) { seen[eq].events = n; seen[eq].at = Date.now(); }
  }));
  return strip;
}

function checkStalled() {
  const stalled = Object.keys(seen).filter(function (eq) {
    const s = seen[eq];
    // Never seen a value and not moving since we first saw it are different
    // states. Only the second is evidence of anything.
    return s.at !== null && (Date.now() - s.at) / 1000 > STALL_S;
  });

  Object.keys(seen).forEach(function (eq) {
    const strip = document.getElementById(`eq-${eq}`);
    if (!strip) return;
    strip.classList.toggle("stale", runState === STATE_RUNNING && stalled.indexOf(eq) >= 0);
  });

  if (runState !== STATE_RUNNING) return setAlarm("midas_event_rate", "");
  setAlarm("midas_event_rate", stalled.length ? "red" : "");
}

/**
 * A trend, but only for the equipment MIDAS actually recorded.
 *
 * docs/dqm_inventory.md says in one place that Statistics are history-logged
 * and implies in another that history covers Variables only. Both cannot be
 * relied on, so this assumes neither: ask mlogger what it has, offer a tile
 * where the answer is yes, and a popup button where it is no. The popup costs
 * no page area and is honest about being a different question -- "is anything
 * arriving" is one number, "has the rate changed since the run started" is not.
 */
async function attachTrends(ctx, equipment) {
  let events = [];
  try {
    const rpc = await mjsonrpc_call("hs_get_events", { time: 0 });
    events = rpc.result.events || [];
  } catch (e) {
    return;                            // history is a bonus, never a hard failure
  }

  const strip = el("div", { class: "dqm-strip" });
  equipment.forEach(function (eq) {
    const match = events.find((e) => e === eq || e === `${eq}/Statistics`);
    if (match) {
      ctx.body.appendChild(trendDetails(ctx, match, eq));
      return;
    }
    const b = el("button", { class: "mbutton" }, `${eq} rate history`);
    b.addEventListener("click", function () {
      mhistory_dialog_var(`${eq}:Events per sec.`);
    });
    strip.appendChild(b);
  });
  if (strip.children.length) {
    ctx.body.appendChild(el("div", { class: "dqm-footnote" },
      "mlogger recorded no history event for these, so their trends open in a "
      + "dialog rather than a tile:"));
    ctx.body.appendChild(strip);
  }
}

/**
 * Built on first open, never on load.
 *
 * Each MhistoryGraph reschedules its own ~1 Hz fetch for as long as it exists,
 * so constructing one per equipment at load costs the machine taking data a
 * request per second per panel nobody is looking at.
 */
function trendDetails(ctx, event, eq) {
  const d = el("details", {});
  d.appendChild(el("summary", {}, `${eq} — event rate over time`));
  let built = false;
  d.addEventListener("toggle", function () {
    if (built) return;
    built = true;
    const graph = el("div", { class: "mjshistory dqm-hist" });
    const base = window.location.href.split("?")[0];
    graph.dataset.baseURL = base + "?cmd=history";
    graph.dataset.historyVar = `${event}:Events per sec.`;
    // MhistoryGraph draws its own title inside the canvas, eating plot area,
    // and the summary above already says what this is.
    graph.dataset.showTitle = "0";
    d.appendChild(graph);
    setTimeout(function () {
      graph.mhg = new MhistoryGraph(graph, false, false);
      // Never index 0: mhistory.js treats a falsy index as "no panel".
      graph.mhg.initializePanel(historyIndex++, { "Timescale": ctx.cfg["History Timescale"] });
      graph.mhg.resize();
    }, 0);
  });
  return d;
}

let historyIndex = 1;

// ---------------------------------------------------------------------------
// What made these events, and what is this rate divided by?
// ---------------------------------------------------------------------------

DQMPage.register("trigger_settings", async function (ctx) {
  const root = String(ctx.cfg["Trigger Settings Path"] || "");
  const keys = DQM.asArray(ctx.cfg["Trigger Settings Keys"]).filter((s) => s);
  const thresholdPath = String(ctx.cfg["Threshold Path"] || "");

  const present = await readSettings(root, keys);
  const threshold = await readThreshold(thresholdPath);
  const found = keys.filter((k) => present[k] !== undefined).length;

  if (!found && threshold === null) {
    // Its blocked_by already names all four paths, so there is nothing to add.
    blocked(ctx.body, ctx.panel.blocked_by, ctx.panel,
            `${DQM.CONFIG_ROOT}/Rates/Trigger Settings Path`);
    return;
  }

  // Partial presence is the interesting case, and the reason every row is built
  // whether or not its key exists. A table showing only what happens to be
  // there reads as complete, and "every rate on this screen is an uncorrected
  // count" is exactly what nothing else on the page would say.
  const missing = keys.length - found;
  if (missing) {
    ctx.body.appendChild(el("div", { class: "dqm-diagnosis yellow" },
      `${missing} of ${keys.length} trigger settings are absent. `
      + "Every rate on this page is an uncorrected count until they exist."));
  }

  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {},
    el("th", { class: "label" }, "setting"), el("th", {}, "value"), el("th", { class: "label" }, "path")));

  const expected = Number(ctx.cfg["Expected Prescale"]);
  keys.forEach(function (key) {
    const path = `${root}/${key}`;
    const row = el("tr", { id: `trig-${key}` });
    row.appendChild(el("td", { class: "label" }, key));
    if (present[key] === undefined) {
      row.appendChild(el("td", { class: "masked" }, "absent"));
    } else {
      // Prescale and the coincidence window are Settings, and a shifter
      // correcting one at 3am is the point of this panel rather than a risk of
      // it. Mode is left read-only: it is a word, not a number, and a typo
      // there is not correctable by looking at this table.
      const editable = key !== "Mode";
      row.appendChild(el("td", {}, modb("span", path, { editable: editable })));
    }
    row.appendChild(el("td", { class: "label" }, path));
    table.appendChild(row);
  });
  ctx.body.appendChild(table);

  // The alarm, implemented. A prescale that is not the expected one silently
  // divides every rate above it; it is the one condition on this page that
  // turns the numbers into something you can act on.
  if (expected > 0 && present["Prescale"] !== undefined) {
    const got = Number(present["Prescale"]);
    if (got !== expected) {
      const row = document.getElementById("trig-Prescale");
      if (row) row.classList.add("alarm");
      setAlarm("trigger_settings", "red");
      ctx.body.appendChild(el("div", { class: "dqm-diagnosis red" },
        `Prescale is ${got}, not the expected ${expected}. Every rate on this `
        + `page is ${got} times lower than the true one.`));
    } else {
      setAlarm("trigger_settings", "yellow");   // evaluable, and currently fine
    }
  }

  if (threshold !== null) ctx.body.appendChild(thresholdSummary(thresholdPath, threshold));

  // The shifter's next action is to note this against the run, so say where it
  // lands in the run-conditions database.
  ctx.body.appendChild(el("div", { class: "dqm-footnote" },
    "Recorded per run as cond.trigger_config.{prescale, coincidence_window_ns, logic}."));
});

async function readSettings(root, keys) {
  const out = {};
  if (!root) return out;
  try {
    const ls = (await DQM.lsODB([root]))[0] || {};
    keys.forEach(function (key) {
      // db_ls preserves case, but be forgiving about it anyway: the key names
      // here are proposed, and a frontend author writing "prescale" should get
      // a working panel rather than a silent "absent".
      const hit = Object.keys(ls).find(
        (k) => !k.endsWith("/key") && k.toLowerCase() === key.toLowerCase());
      if (hit !== undefined) out[key] = ls[hit];
    });
  } catch (e) { /* an absent subtree is the expected case */ }
  return out;
}

async function readThreshold(path) {
  if (!path) return null;
  const slash = path.lastIndexOf("/");
  try {
    const ls = (await DQM.lsODB([path.slice(0, slash)]))[0] || {};
    const key = path.slice(slash + 1);
    const hit = Object.keys(ls).find(
      (k) => !k.endsWith("/key") && k.toLowerCase() === key.toLowerCase());
    return hit === undefined ? null : DQM.asArray(ls[hit], (ls[`${hit}/key`] || {}).num_values || 1);
  } catch (e) { return null; }
}

/**
 * Sixty-four thresholds, summarised.
 *
 * A row per channel would bury the three keys above it, which are the ones the
 * shift question is about. The spread is what says whether the channels are set
 * alike; the full list is one click away for when it is not.
 */
function thresholdSummary(path, values) {
  const nums = values.map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const wrap = el("div", {});
  if (!nums.length) return wrap;

  const strip = el("div", { class: "dqm-strip" });
  strip.appendChild(el("b", {}, "thresholds"));
  strip.appendChild(chip("min", el("span", {}, String(nums[0]))));
  strip.appendChild(chip("median", el("span", {}, String(nums[Math.floor(nums.length / 2)]))));
  strip.appendChild(chip("max", el("span", {}, String(nums[nums.length - 1]))));
  strip.appendChild(chip("channels", el("span", {}, String(nums.length))));
  wrap.appendChild(strip);

  const d = el("details", {});
  d.appendChild(el("summary", {}, `all ${values.length} channels`));
  const table = el("table", { class: "dqm-table mtable" });
  values.forEach(function (v, i) {
    table.appendChild(el("tr", {},
      el("td", { class: "label" }, `[${i}]`),
      el("td", {}, modb("span", `${path}[${i}]`, { editable: true }))));
  });
  d.appendChild(table);
  wrap.appendChild(d);
  return wrap;
}

})();
