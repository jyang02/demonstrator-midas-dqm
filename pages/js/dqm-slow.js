//
// dqm-slow.js -- the five ODB panels on the SlowControls page.
//
// Named "slow" rather than "slowcontrols" because a /Custom key containing
// "controls.js" is intercepted by mhttpd before /Custom is consulted, and would
// have served the stock file instead of this one. manifest.check_key() refuses
// it; the name is the fix.
//
// None of them draws anything today, and every line here is written so that
// they draw the moment a frontend appears. That is the whole character of this
// page: it is mechanism A -- ODB Variables, which MIDAS histories for free --
// so there is nothing between these panels and real data except fecaen_hv and
// featar_sc, neither of which has been written. No analyzer, no bank, no
// decoder, no histogram definition.
//
// So the interesting code is the absent path, and it is deliberately four
// different sentences rather than one. "Waiting for ATAR_SC" and "ATAR_SC is
// there but has no key called Temperature" send a shifter to different people,
// and a page that renders the same words for both is worse than one that says
// nothing, because it will be believed.
//
// The sixth panel, humidity, registers no renderer at all. It is blocked one
// step further back than the others -- not "no sensor" but "nowhere to put the
// reading", since the run-conditions vocabulary has no name for humidity -- and
// the catalogue's own blocked_by says that better than any code here could.
//

(function () {
"use strict";

const { el, modb, watch, chip, blocked } = DQMPage;

const CFG = `${DQM.CONFIG_ROOT}/SlowControls`;
const PATH_RE = /^\/Equipment\/([^/]+)\/(Variables|Settings)\/(.+)$/;

//: Beyond this, a value is shown but not vouched for. last_written comes free
//: from db_ls, so a page opened onto a frontend that died last week says so on
//: its first paint rather than after enough time has passed to notice nothing
//: is changing.
const STALE_S = 120;

let historyIndex = 1;

//: The page config, kept here so the inline modb handlers below can read a
//: threshold. They are reached by name from an attribute, so they cannot be
//: closures over a renderer's argument.
let cfg = null;

// ---------------------------------------------------------------------------
// The shared shape of an ODB-backed panel
// ---------------------------------------------------------------------------

/**
 * Resolve one configured path, or explain precisely which part of it is missing.
 *
 * Returns {eq, sub, key, base, values, n, lastWritten, names} or null, having
 * already rendered the reason into ctx.body when it returns null.
 */
async function resolve(ctx, pathKey) {
  const path = String(ctx.cfg[pathKey] || "");
  const m = PATH_RE.exec(path);
  const editKey = `${CFG}/${pathKey}`;

  if (!m) {
    blocked(ctx.body,
      `${pathKey} is not an /Equipment/<name>/{Variables,Settings}/<key> path. `
      + `It is currently ${path ? `"${path}"` : "empty"}.`,
      ctx.panel, editKey);
    return null;
  }

  const [, eq, sub, key] = m;
  const base = `/Equipment/${eq}/${sub}`;
  let ls = null;
  try {
    ls = (await DQM.lsODB([base]))[0];
  } catch (e) { /* treated as absent below */ }

  if (!ls) {
    blocked(ctx.body,
      `Waiting for ${eq}. ${base} does not exist in this experiment, because the `
      + "frontend that would write it has not been written. Nothing on this side "
      + "is missing: the moment that frontend writes its Variables, MIDAS "
      + "histories them and this panel draws itself.",
      ctx.panel, editKey);
    return null;
  }

  // db_ls preserves case, but match forgivingly anyway: the key names here are
  // proposed rather than deployed, and a frontend author who wrote "temperature"
  // should get a working panel rather than a silent absence.
  const hit = Object.keys(ls).find(
    (k) => !k.endsWith("/key") && k.toLowerCase() === key.toLowerCase());

  if (hit === undefined) {
    const there = Object.keys(ls).filter((k) => !k.endsWith("/key"));
    // Listing what *is* there is what turns a path typo into a ten-second fix
    // instead of a conversation with whoever wrote the frontend.
    blocked(ctx.body,
      `${base} exists but has no key "${key}". `
      + (there.length ? `What is there: ${there.join(", ")}.`
                      : "It is empty."),
      ctx.panel, editKey);
    return null;
  }

  const meta = ls[`${hit}/key`] || {};
  // num_values is absent, not 1, for a true scalar -- which is the shape trap
  // this experiment will hit first, on Light level.
  const n = meta.num_values || 1;
  return {
    eq, sub, key: hit, path: `${base}/${hit}`, base,
    values: DQM.asArray(ls[hit], n), n,
    lastWritten: meta.last_written,
    names: DQM.bankLabels(hit, ls[`Names ${hit}`], n),
  };
}

/** Say so when the numbers below are older than we are willing to vouch for. */
function stalenessNote(ctx, found) {
  if (!found.lastWritten) return;
  const age = Math.round(Date.now() / 1000 - Number(found.lastWritten));
  if (age < STALE_S) return;
  ctx.body.appendChild(el("div", { class: "dqm-diagnosis yellow" },
    `${found.path} was last written ${age} s ago. These numbers are shown but `
    + "not current, and nothing below should be read as live."));
  ctx.body.classList.add("dqm-stale");
}

/**
 * A MIDAS history trend, if mlogger recorded one.
 *
 * `inline` for a panel whose question is temporal (the spec says so with
 * sketch: "trend"), behind a <details> otherwise -- a tile of trend answering a
 * question nobody asked costs a request per second for as long as it is open.
 */
async function trend(ctx, found, inline) {
  let events = [];
  try {
    events = (await mjsonrpc_call("hs_get_events", { time: 0 })).result.events || [];
  } catch (e) {
    return;                            // history is a bonus, never a hard failure
  }
  const event = events.find((e) => e === found.eq || e === `${found.eq}/${found.sub}`);
  if (!event) {
    ctx.body.appendChild(el("div", { class: "dqm-footnote" },
      `mlogger has no history event for ${found.eq}. It fixes its history schema `
      + "at startup, so equipment that appeared after mlogger started has none "
      + "until mlogger is restarted."));
    return;
  }

  let tags = [];
  try {
    tags = (await mjsonrpc_call("hs_get_tags", { events: [event] })).result.events[0].tags
      .filter((t) => t.name.toLowerCase().startsWith(found.key.toLowerCase()))
      .map((t) => t.name);
  } catch (e) { /* fall back to the Settings names below */ }

  const vars = DQM.historyVarString(event, tags, found.names, found.n);
  if (!vars.length) return;

  if (inline) return ctx.body.appendChild(graphNode(ctx, vars, `${event}/${found.key}`));

  const d = el("details", {});
  d.appendChild(el("summary", {}, `${found.key} over time`));
  let built = false;
  d.addEventListener("toggle", function () {
    if (built) return;
    built = true;
    d.appendChild(graphNode(ctx, vars, `${event}/${found.key}`));
  });
  ctx.body.appendChild(d);
}

function graphNode(ctx, vars, title) {
  const wrap = el("div", {});
  // The title goes in a sibling div: MhistoryGraph draws its own inside the
  // canvas, eating plot area, and for eight channels the variable list it draws
  // there is an unreadable smear.
  wrap.appendChild(el("div", { class: "dqm-histtitle" }, title));
  const d = el("div", { class: "mjshistory dqm-hist" });
  d.dataset.baseURL = window.location.href.split("?")[0] + "?cmd=history";
  d.dataset.historyVar = vars.join(",");
  d.dataset.showTitle = "0";
  if (vars.length > 6) d.dataset.showValues = "0";
  wrap.appendChild(d);
  setTimeout(function () {
    d.mhg = new MhistoryGraph(d, false, false);
    // Never index 0: mhistory.js treats a falsy index as "no panel".
    d.mhg.initializePanel(historyIndex++, { "Timescale": ctx.cfg["History Timescale"] });
    d.mhg.resize();
  }, 0);
  return wrap;
}

/** One pill per element of an array key, labelled from Settings/Names. */
function valueStrip(found, opts) {
  const o = opts || {};
  const strip = el("div", { class: "dqm-strip" });
  for (let i = 0; i < found.n; i++) {
    const cell = modb("span", found.n > 1 ? `${found.path}[${i}]` : found.path,
                      { format: o.format, id: `${o.idPrefix}-${i}`,
                        onchange: o.onchange });
    strip.appendChild(chip(found.names[i], cell, o.unit));
  }
  return strip;
}

// ---------------------------------------------------------------------------
// Temperature -- the question is temporal, so the trend is the panel
// ---------------------------------------------------------------------------

DQMPage.register("temperature_sensors", async function (ctx) {
  cfg = ctx.cfg;
  const found = await resolve(ctx, "Temperature Path");
  if (!found) return;
  stalenessNote(ctx, found);
  ctx.body.appendChild(valueStrip(found, { format: "f1", unit: "°C",
                                           idPrefix: "temp", onchange: "dqmTempCell" }));
  await trend(ctx, found, true);
  ctx.body.appendChild(el("div", { class: "dqm-footnote" },
    `${found.path} — warns above ${ctx.cfg["Temp Warn C"]} °C, the same `
    + "threshold frontend_requirements.md gives the MIDAS alarm."));
});

// Referenced from the modb onload/onchange attributes above, so it has to be
// reachable by name from an inline handler.
window.dqmTempCell = function (cell) {
  const warn = Number((cfg || {})["Temp Warn C"]);
  const v = Number(cell.value);
  cell.style.color = (warn > 0 && v >= warn) ? "var(--mred, #c00)" : "";
};

// ---------------------------------------------------------------------------
// Light level -- one bare float, and the shape trap that comes with it
// ---------------------------------------------------------------------------

DQMPage.register("light_sensors", async function (ctx) {
  const found = await resolve(ctx, "Light Path");
  if (!found) return;
  stalenessNote(ctx, found);
  // found.n is 1 here because num_values is *absent* on a true scalar rather
  // than 1, and DQM.asArray is what makes that indistinguishable downstream.
  ctx.body.appendChild(valueStrip(found, { format: "f2", idPrefix: "light" }));
  // sketch is "scalar": the question is what it is now, so a trend tile would
  // answer something nobody asked. Behind a disclosure it costs nothing.
  await trend(ctx, found, false);
  ctx.body.appendChild(el("div", { class: "dqm-footnote" }, found.path));
});

// ---------------------------------------------------------------------------
// Leakage current -- a bar per channel, filled from one watcher
// ---------------------------------------------------------------------------

DQMPage.register("leakage_current", async function (ctx) {
  const found = await resolve(ctx, "Leakage Path");
  if (!found) return;
  stalenessNote(ctx, found);

  const warn = Number(ctx.cfg["Leakage Warn uA"]);
  const table = el("table", { class: "dqm-table mtable", id: "leak-table" });
  table.appendChild(el("tr", {}, el("th", { class: "label" }, "channel"),
                                 el("th", {}, "current (uA)")));
  for (let i = 0; i < found.n; i++) {
    table.appendChild(el("tr", { id: `leak-${i}` },
      el("td", { class: "label" }, found.names[i]),
      el("td", { id: `leak-v-${i}` }, "—")));
  }
  ctx.body.appendChild(table);

  // One watcher on the whole array, not one modbvalue per channel. mhttpd
  // rewrites a modbvalue's innerHTML every tick while firing onchange only on a
  // change, so per-cell colouring is correct for one tick and then reverts.
  // Owning the text outright costs one ODB path instead of eight and is the
  // only way an over-threshold channel can render differently at all.
  ctx.body.appendChild(watch(found.path, function (value) {
    const vals = DQM.asArray(value, found.n);
    let over = 0;
    for (let i = 0; i < found.n; i++) {
      const cell = document.getElementById(`leak-v-${i}`);
      const row = document.getElementById(`leak-${i}`);
      if (!cell) continue;
      const v = Number(vals[i]);
      cell.textContent = Number.isFinite(v) ? v.toFixed(2) : "—";
      const bad = warn > 0 && Number.isFinite(v) && Math.abs(v) >= warn;
      if (row) row.classList.toggle("alarm", bad);
      if (bad) over++;
    }
    DQMPage.setAlarm("leakage_current", over ? "red" : "yellow");
  }));

  await trend(ctx, found, false);
  ctx.body.appendChild(el("div", { class: "dqm-footnote" },
    `${found.path} — warns above ${warn} uA. A rising leakage current is an `
    + "early damage warning, which is why it is here and not only in the alarm system."));
});

// ---------------------------------------------------------------------------
// Bias: demand against measured -- the only panel that reads two paths
// ---------------------------------------------------------------------------

DQMPage.register("hv_readback", async function (ctx) {
  const measured = await resolve(ctx, "Measured Path");
  if (!measured) return;

  // Half an answer is worth more than none here: the entire point of the panel
  // is that nothing anywhere currently checks a setpoint against a readback, so
  // a readback with no demand beside it is still the more informative half.
  let demand = null;
  const demandPath = String(ctx.cfg["Demand Path"] || "");
  const dm = PATH_RE.exec(demandPath);
  if (dm) {
    try {
      const ls = (await DQM.lsODB([`/Equipment/${dm[1]}/${dm[2]}`]))[0];
      if (ls) {
        const hit = Object.keys(ls).find(
          (k) => !k.endsWith("/key") && k.toLowerCase() === dm[3].toLowerCase());
        if (hit !== undefined) demand = `/Equipment/${dm[1]}/${dm[2]}/${hit}`;
      }
    } catch (e) { /* rendered as "no demand" below */ }
  }

  stalenessNote(ctx, measured);
  if (!demand) {
    ctx.body.appendChild(el("div", { class: "dqm-diagnosis yellow" },
      `${demandPath} does not exist, so there is a readback here and nothing to `
      + "compare it against. Today the crate is driven from its own front panel "
      + "and the demand is whatever somebody typed into a record."));
  }

  const tol = Number(ctx.cfg["Bias Tolerance V"]);
  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {},
    el("th", { class: "label" }, "channel"), el("th", {}, "demand (V)"),
    el("th", {}, "measured (V)"), el("th", {}, "delta")));
  for (let i = 0; i < measured.n; i++) {
    table.appendChild(el("tr", { id: `hv-${i}` },
      el("td", { class: "label" }, measured.names[i]),
      el("td", {}, demand ? modb("span", `${demand}[${i}]`, { format: "f1" })
                          : el("span", { class: "masked" }, "—")),
      el("td", {}, modb("span", `${measured.path}[${i}]`, { format: "f1" })),
      el("td", { id: `hv-d-${i}` }, "—")));
  }
  ctx.body.appendChild(table);

  // The delta is NOT a modbvalue and NOT computed in one's onchange. mhttpd
  // rewrites a modbvalue's innerHTML on every tick, so a delta written from a
  // handler is correct on the tick it changed and blank on every tick after.
  // Two array watchers feed a plain <td> that this panel owns outright.
  const latest = { demand: [], measured: [] };
  const recompute = function () {
    let bad = 0;
    for (let i = 0; i < measured.n; i++) {
      const cell = document.getElementById(`hv-d-${i}`);
      const row = document.getElementById(`hv-${i}`);
      if (!cell) continue;
      const d = Number(latest.demand[i]);
      const m = Number(latest.measured[i]);
      if (!Number.isFinite(d) || !Number.isFinite(m)) { cell.textContent = "—"; continue; }
      const delta = m - d;
      cell.textContent = delta.toFixed(1);
      const off = tol > 0 && Math.abs(delta) > tol;
      if (row) row.classList.toggle("alarm", off);
      if (off) bad++;
    }
    DQMPage.setAlarm("hv_readback", bad ? "red" : (demand ? "yellow" : ""));
  };

  if (demand) {
    ctx.body.appendChild(watch(demand, function (v) {
      latest.demand = DQM.asArray(v, measured.n); recompute();
    }));
  }
  ctx.body.appendChild(watch(measured.path, function (v) {
    latest.measured = DQM.asArray(v, measured.n); recompute();
  }));

  await trend(ctx, measured, false);
  ctx.body.appendChild(el("div", { class: "dqm-footnote" },
    `Flags a channel more than ${tol} V from its demand.`));
});

// ---------------------------------------------------------------------------
// Degrader and rotations -- the readback beside the number somebody typed
// ---------------------------------------------------------------------------

DQMPage.register("motion_readback", async function (ctx) {
  const found = await resolve(ctx, "Position Path");
  if (!found) {
    // Worth saying plainly, because this is the one panel on the page whose
    // blocker is not a frontend at all.
    ctx.body.appendChild(el("div", { class: "dqm-footnote" },
      "There are no actuators to read back: the degrader plate is swapped by "
      + "hand and the turntables are set by hand, so the only record is what "
      + "somebody typed. This panel exists to make that visible on the screen a "
      + "shifter is actually looking at."));
    return;
  }
  stalenessNote(ctx, found);

  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {}, el("th", { class: "label" }, "axis"), el("th", {}, "readback")));
  for (let i = 0; i < found.n; i++) {
    table.appendChild(el("tr", {},
      el("td", { class: "label" }, found.names[i]),
      el("td", {}, modb("span", `${found.path}[${i}]`, { format: "f2" }))));
  }
  ctx.body.appendChild(table);
  await settingsTable(ctx);
  ctx.body.appendChild(el("div", { class: "dqm-footnote" }, found.path));
});

/**
 * The four numbers somebody types, beside the readback.
 *
 * Putting them together *is* the comparison the panel's alarm is about: a stage
 * that moved and was never typed, or was typed and never moved, is invisible to
 * every analysis downstream.
 */
async function settingsTable(ctx) {
  const root = String(ctx.cfg["Motion Settings"] || "");
  if (!root) return;
  let ls = null;
  try {
    ls = (await DQM.lsODB([root]))[0];
  } catch (e) { /* absent is normal */ }
  if (!ls) return;

  const keys = Object.keys(ls).filter((k) => !k.endsWith("/key"));
  if (!keys.length) return;

  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", { class: "subhead" },
    el("th", { class: "label" }, "set by hand"), el("th", {}, "value")));
  keys.forEach(function (key) {
    table.appendChild(el("tr", {},
      el("td", { class: "label" }, key),
      el("td", {}, modb("span", `${root}/${key}`, { editable: true }))));
  });
  ctx.body.appendChild(table);
}

})();
