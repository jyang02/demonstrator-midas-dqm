//
// dqm-scalars.js -- the scaler page.
//
// Has no backend. Everything on this page is already in the ODB or in MIDAS
// history, put there by whatever frontend is running; this file only discovers
// it, lays it out, and then gets out of the way. After render() the periodic
// updating belongs entirely to mhttpd's own modb* refresh loop and to
// MhistoryGraph's own timer -- nothing here polls the network.
//

(function () {
"use strict";

const cfgRootFromUrl = mhttpd_getParameterByName("config");
let cfg = null;
let boards = [];

// Per-board runtime state for the health chips, keyed "<equipment>/<board>".
const state = {};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

window.addEventListener("load", function () {
  // The page name must equal the /Custom key or the sidenav highlight breaks.
  // Reading it from the URL rather than hardcoding "Scalers" is what lets the
  // same file be registered as "WDScalers" in a shared experiment without
  // editing anything.
  const page = mhttpd_getParameterByName("page") || "Scalers";

  // Deliberately before the async discovery below: this builds the header and
  // sidenav and installs the connection-lost handling, so a page that is still
  // discovering still looks like a MIDAS page and still reports a dead mhttpd.
  // getMElements() re-scans the DOM every tick, so the modb* elements we add
  // later are picked up on the next cycle with no re-init.
  mhttpd_init(page, 1000);

  boot().catch(function (e) {
    fail("Could not build the page: " + e);
    throw e;
  });
});

async function boot() {
  cfg = await DQM.loadConfig(cfgRootFromUrl || DQM.CONFIG_ROOT);
  mhttpd_set_refresh_interval(Number(cfg["Refresh ms"]) || 1000);

  const equipment = await discoverEquipment();
  const varsByEq = await lsFor(equipment, "Variables");
  boards = DQM.groupBoards(varsByEq, cfg);

  if (!boards.length) {
    renderNothingFound(equipment, varsByEq);
    return;
  }

  const settingsByEq = await lsFor(uniq(boards.map((b) => b.equipment)), "Settings");
  attachLabels(settingsByEq);
  await attachHistory();

  render();
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverEquipment() {
  const named = DQM.asArray(cfg["Equipment"]).filter((s) => s);
  if (named.length) return named;
  const ls = await DQM.lsODB(["/Equipment"]);
  // db_ls returns subdirectories as empty objects, with original case -- which
  // is the reason discovery uses db_ls rather than db_get_values throughout:
  // the latter lower-cases every key name.
  return Object.keys(ls[0] || {})
    .filter((k) => !k.endsWith("/key"))
    .sort();
}

async function lsFor(equipment, subtree) {
  if (!equipment.length) return {};
  const paths = equipment.map((n) => `/Equipment/${n}/${subtree}`);
  const data = await DQM.lsODB(paths);
  const out = {};
  equipment.forEach(function (name, i) {
    // A missing subtree comes back null rather than throwing; an equipment
    // with no Settings at all is normal (musip's Readout has none).
    out[name] = data[i] || {};
  });
  return out;
}

function attachLabels(settingsByEq) {
  boards.forEach(function (board) {
    const settings = settingsByEq[board.equipment] || {};
    Object.keys(board.banks).forEach(function (role) {
      const bank = board.banks[role];
      const names = settings[`Names ${bank.name}`] !== undefined
        ? settings[`Names ${bank.name}`]
        : settings["Names"];
      bank.labels = DQM.bankLabels(bank.name, names, bank.numValues);
      bank.enabled = DQM.asArray(settings[`Enabled ${bank.name}`], bank.numValues);
    });
  });
}

async function attachHistory() {
  // Ask mlogger what it actually recorded rather than reading
  // /History/Display: the panels there are optional and an experiment where
  // nobody ever made one should still get trend plots.
  let events = [];
  try {
    const rpc = await mjsonrpc_call("hs_get_events", { time: 0 });
    events = rpc.result.events || [];
  } catch (e) {
    return;                       // history is a bonus, never a hard failure
  }
  const wanted = [];
  boards.forEach(function (board) {
    Object.keys(board.banks).forEach(function (role) {
      const bank = board.banks[role];
      const name = `${board.equipment}/${bank.name}`;
      if (events.indexOf(name) >= 0) {
        bank.historyEvent = name;
        wanted.push(name);
      }
    });
  });
  if (!wanted.length) return;

  try {
    const rpc = await mjsonrpc_call("hs_get_tags", { events: wanted });
    const tagsByEvent = {};
    (rpc.result.events || []).forEach(function (e) {
      tagsByEvent[e.name] = (e.tags || []).map((t) => t.name);
    });
    boards.forEach(function (board) {
      Object.keys(board.banks).forEach(function (role) {
        const bank = board.banks[role];
        if (!bank.historyEvent) return;
        bank.historyVars = DQM.historyVarString(
          bank.historyEvent, tagsByEvent[bank.historyEvent], bank.labels, bank.numValues);
      });
    });
  } catch (e) {
    // Fall back to the Settings/Names labels we already have.
    boards.forEach(function (board) {
      Object.keys(board.banks).forEach(function (role) {
        const bank = board.banks[role];
        if (bank.historyEvent) {
          bank.historyVars = DQM.historyVarString(
            bank.historyEvent, null, bank.labels, bank.numValues);
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function root() { return document.getElementById("dqm-root"); }

function fail(message) {
  root().innerHTML = "";
  root().appendChild(el("div", { class: "dqm-error" }, message));
}

function render() {
  const r = root();
  r.innerHTML = "";

  if (!cfg._seeded) {
    r.appendChild(el("div", { class: "dqm-note" },
      `Using built-in defaults: ${cfgRootFromUrl || DQM.CONFIG_ROOT} does not exist. ` +
      `Run mdqm-register-pages to make these settings editable.`));
  }

  uniq(boards.map((b) => b.equipment)).forEach(function (eq) {
    r.appendChild(equipmentStrip(eq));
  });

  boards.forEach(function (board) {
    r.appendChild(boardPanel(board));
  });

  r.appendChild(healthPanel());

  // One interval for every chip on the page, and it touches no network: it
  // only re-reads timestamps this page already recorded. This is what turns
  // "the ODB stopped changing" into a visible statement.
  setInterval(updateAllChips, 1000);
}

function equipmentStrip(eq) {
  const base = `/Equipment/${eq}`;
  return el("div", { class: "dqm-strip" },
    el("b", {}, eq),
    chipStatic("status", modb("span", `${base}/Common/Status`)),
    chipStatic("frontend", modb("span", `${base}/Common/Frontend name`)),
    chipStatic("period", modb("span", `${base}/Common/Period`, { editable: true }), "ms"),
    chipStatic("events", modb("span", `${base}/Statistics/Events sent`)),
    chipStatic("rate", modb("span", `${base}/Statistics/Events per sec.`, { format: "f1" }), "/s"));
}

function boardPanel(board) {
  const key = boardKey(board);
  state[key] = { lastChange: null, ticks: null, stale: 0, rates: [], allZero: false,
                 periodMs: 0 };
  // Not null: "we have never seen a value" and "the value has not changed
  // since we first saw it" are different states, and only the first should
  // read as "waiting".

  const panel = el("div", { class: "dqm-panel" });
  panel.appendChild(el("h2", {}, `${board.equipment} — board ${board.board}`));

  // Two invisible watchers. For array values mhttpd compares JSON.stringify
  // against its cached copy (mhttpd.js:2662), so onchange fires only on a real
  // change -- for the timestamp bank that means "the frontend has read the
  // board again", which is exactly the event the health chips need to time.
  if (board.banks.timestamp) {
    const clock = el("div", { name: "modb" });
    clock.dataset.odbPath =
      `/Equipment/${board.equipment}/Variables/${board.banks.timestamp.name}`;
    // onload AND onchange, and the pairing is load-bearing: mhttpd stores a
    // watcher's first value silently and calls onload for it, firing onchange
    // only on *subsequent* changes (mhttpd.js:2658-2670). A handler wired to
    // onchange alone therefore never runs at all while the value is static --
    // which is precisely the case when the frontend is dead, i.e. exactly when
    // this page most needs to say something.
    clock.onload = clock.onchange = function () { onTimestamp(board, this.value); };
    panel.appendChild(clock);
  }

  // The rates arrive as one array through one watcher rather than as nineteen
  // separate modbvalue cells, and the cells are rendered by hand.
  //
  // That is not an optimisation, it is a correctness fix. mhttpd's refresh loop
  // writes `modbvalue.innerHTML = html` on *every* tick but only calls onchange
  // when the value has *changed* (mhttpd.js:2690-2726). A cell whose handler
  // rewrites the text -- "masked" for the -1 sentinel -- would therefore be
  // correct for one tick and then silently revert to showing "-1" forever.
  // Owning the text outright avoids fighting the framework, costs one ODB path
  // per board instead of nineteen, and is what lets a masked channel, a stale
  // read and an alarm rate all render differently.
  const values = el("div", { name: "modb" });
  values.dataset.odbPath = `/Equipment/${board.equipment}/Variables/${board.banks.rates.name}`;
  values.onload = values.onchange = function () { onRates(board, this.value); };
  panel.appendChild(values);

  // The poll interval is an operator-editable knob, so the staleness threshold
  // has to follow it rather than be fixed. Watched, not read once, because
  // changing it from this very page must not leave the page judging by the old
  // value.
  const period = el("div", { name: "modb" });
  period.dataset.odbPath = `/Equipment/${board.equipment}/Common/Period`;
  period.onload = period.onchange = function () {
    state[key].periodMs = Number(this.value) || 0;
  };
  panel.appendChild(period);

  panel.appendChild(chipStrip(board));
  panel.appendChild(el("div", { class: "dqm-diagnosis", id: `diag-${key}` }, ""));

  const grid = el("div", { class: "dqm-grid" });
  grid.appendChild(ratesPlotHolder(board));
  grid.appendChild(scalerTable(board));
  panel.appendChild(grid);

  panel.appendChild(historySection(board));
  return panel;
}

function chipStrip(board) {
  const key = boardKey(board);
  const strip = el("div", { class: "dqm-strip" });
  strip.appendChild(el("span", { class: "dqm-chip", id: `chip-live-${key}` }, "…"));
  strip.appendChild(chipStatic("sum", el("span", { id: `chip-sum-${key}` }, "—"), "Hz"));
  if (board.banks.temperature) {
    strip.appendChild(chipStatic("FPGA",
      modb("span", `/Equipment/${board.equipment}/Variables/${board.banks.temperature.name}`,
           { format: "f1", id: `chip-temp-${key}`, onchange: "dqmTempCell" }), "°C"));
  }
  const clockIdx = indexOfName(board, cfg["Clock Scaler Name"]);
  if (clockIdx >= 0) {
    strip.appendChild(chipStatic(cfg["Clock Scaler Name"],
      el("span", { id: `chip-clk-${key}` }, "—"), "MHz"));
  }
  return strip;
}

function scalerTable(board) {
  const rates = board.banks.rates;
  const thr = board.banks.threshold;
  const wrap = el("div", {});
  const table = el("table", { class: "dqm-table mtable" });

  const head = el("tr", {},
    el("th", { class: "label" }, "#"),
    el("th", { class: "label" }, "channel"),
    el("th", {}, "rate"),
    el("th", {}, thr ? "threshold" : ""),
    el("th", {}, "record"),
    el("th", {}, ""));
  table.appendChild(head);

  const triggers = DQM.asArray(cfg["Trigger Scaler Names"]).filter((s) => s);
  const clock = cfg["Clock Scaler Name"];
  const isSpecial = (label) => triggers.indexOf(label) >= 0 || label === clock;

  let wroteSubhead = false;
  for (let i = 0; i < rates.numValues; i++) {
    const label = rates.labels[i];
    if (isSpecial(label) && !wroteSubhead) {
      const sub = el("tr", { class: "subhead" });
      const td = el("td", { colspan: "6" }, "triggers and clock — not per-channel rates");
      sub.appendChild(td);
      table.appendChild(sub);
      wroteSubhead = true;
    }
    table.appendChild(scalerRow(board, i, label, isSpecial(label)));
  }
  wrap.appendChild(table);

  if (thr) {
    wrap.appendChild(el("div", { class: "dqm-footnote" },
      "Thresholds are read-only here: they live under Variables and are rewritten " +
      "from the board on every poll, so a value typed in would be overwritten within " +
      "one period and would never reach the hardware. Set them in the board config " +
      "or the WaveDAQ web interface."));
  }
  return wrap;
}

function scalerRow(board, i, label, special) {
  const key = boardKey(board);
  const eq = board.equipment;
  const rates = board.banks.rates;
  const thr = board.banks.threshold;

  // Plain cell: filled by onRates() from the array watcher above.
  const rateCell = el("td", { id: `rate-${key}-${i}` }, "—");

  const thrCell = (thr && i < thr.numValues)
    ? modb("td", `/Equipment/${eq}/Variables/${thr.name}[${i}]`, { format: "f0" })
    : el("td", {}, "");

  let recordCell = el("td", {}, "");
  if (rates.enabled && rates.enabled.length > i && rates.enabled[i] !== null) {
    const box = el("input", { type: "checkbox", class: "modbcheckbox" });
    box.dataset.odbPath = `/Equipment/${eq}/Settings/Enabled ${rates.name}[${i}]`;
    box.dataset.odbEditable = "1";
    recordCell = el("td", {}, box);
  }

  let histCell = el("td", {}, "");
  if (rates.historyVars && rates.historyVars[i]) {
    const b = el("button", { class: "mbutton", title: "history for this channel" }, "↗");
    const v = rates.historyVars[i];
    b.onclick = function () { mhistory_dialog_var(v, { width: 900, height: 500 }); };
    histCell = el("td", {}, b);
  }

  const row = el("tr", { id: `row-${key}-${i}` },
    el("td", { class: "label" }, String(i)),
    el("td", { class: "label" }, label + (special ? "" : "")),
    rateCell, thrCell, recordCell, histCell);
  return row;
}

function ratesPlotHolder(board) {
  const div = el("div", { class: "dqm-plot", id: `plot-${boardKey(board)}` });
  // Constructed directly rather than through mplot_init(): that function
  // snapshots the .mplot divs once and starts its own loop, so a div created
  // after it (which all of ours are -- the DOM is built after an async
  // discovery) ends up with mpg === undefined and crashes both that loop and
  // its resize handler. Doing it by hand also lets us mask the disabled
  // sentinel before it reaches an axis, which the declarative data-y path
  // cannot: a single -1 drags the minimum negative and kills a log scale.
  setTimeout(function () {
    const g = new MPlotGraph(div, {
      title: { text: "" },
      showMenuButtons: true,
      xAxis: { type: "category", title: { text: "" } },
      yAxis: { title: { text: "Hz" }, min: 0 },
      stats: { show: false },
    });
    g.addPlot({ type: "bar", label: "rate", xData: [], yData: [] });
    div.mpg = g;
    g.draw();
  }, 0);
  return div;
}

function historySection(board) {
  const details = el("details", {});
  details.appendChild(el("summary", {}, "trends"));
  const body = el("div", { class: "dqm-grid" });
  details.appendChild(body);

  // Built on first open, not on load. Each MhistoryGraph reschedules its own
  // ~1 Hz data fetch, so four panels across four boards would be sixteen
  // hs_read_arraybuffer per second for plots nobody has looked at.
  let built = false;
  details.addEventListener("toggle", function () {
    if (!details.open || built) return;
    built = true;
    historyGroups(board).forEach(function (group) {
      body.appendChild(historyGraph(group.vars, group.title));
    });
    if (!body.children.length) {
      body.appendChild(el("div", { class: "dqm-note" },
        "No history recorded for this board yet. mlogger fixes its history schema " +
        "at startup, so a bank that appeared after mlogger started has none until " +
        "mlogger is restarted."));
    }
  });
  return details;
}

// A running index, never 0. MhistoryGraph.draw() ends with
//   if (this.plotIndex === 0 && this.floating !== true) ... updateURL()
// which history.replaceState()s &A=<tmin>&B=<tmax> onto the page URL on every
// draw -- so any URL someone copies would carry a frozen time window.
let historyIndex = 1;

/**
 * Which trend graphs to build, and what goes on each.
 *
 * The rates bank is deliberately split: the external clock reads ~80 MHz when
 * one is connected, and putting it on the same axes as channels running at a
 * few hundred Hz makes every real trace a flat line along the bottom. The
 * trigger counters are an order of magnitude off the channels for the same
 * reason. This is the same split `create-history-plots.py` makes for the stock
 * History page, and for the same reason.
 */
function historyGroups(board) {
  const groups = [];
  const triggers = DQM.asArray(cfg["Trigger Scaler Names"]).filter((x) => x);
  const clock = cfg["Clock Scaler Name"];
  const special = (label) => triggers.indexOf(label) >= 0 || label === clock;

  Object.keys(board.banks).forEach(function (role) {
    const bank = board.banks[role];
    if (!bank.historyVars || !bank.historyVars.length) return;

    // The timestamp bank is lsb/msb/stale. Trending a 64-bit counter split
    // across two words plots two sawtooths and a flag, which tells nobody
    // anything; its value is as a liveness signal, and the chips already use it.
    if (role === "timestamp") return;

    if (role !== "rates") {
      groups.push({ title: `${bank.name} — ${role}`, vars: bank.historyVars });
      return;
    }
    const channels = [], others = [];
    bank.historyVars.forEach(function (v) {
      const label = v.slice(v.indexOf(":") + 1);
      (special(label) ? others : channels).push(v);
    });
    if (channels.length) groups.push({ title: `${bank.name} — channels`, vars: channels });
    if (others.length) groups.push({ title: `${bank.name} — triggers and clock`, vars: others });
  });
  return groups;
}

function historyGraph(vars, title) {
  const wrap = el("div", {});
  // The title goes in a sibling div rather than into the panel parameters:
  // MhistoryGraph draws its own title inside the canvas, eating plot area.
  wrap.appendChild(el("div", { class: "dqm-histtitle" }, title));

  const d = el("div", { class: "mjshistory dqm-hist" });
  const base = window.location.href.split("?cmd")[0].split("?")[0];
  d.dataset.baseURL = base + "?cmd=history";
  d.dataset.historyVar = vars.join(",");
  // Without this MhistoryGraph draws its own title bar containing the entire
  // comma-separated variable list (mhistory.js:2753), which for sixteen
  // channels is an unreadable smear across the top. We have a real title in the
  // sibling div, and suppressing this one gives the plot back 26 px.
  d.dataset.showTitle = "0";
  // The legend doubles as a value table, one row per variable, drawn over the
  // plot area. Past a handful of channels it covers the data it is annotating.
  if (vars.length > 6) d.dataset.showValues = "0";
  wrap.appendChild(d);

  setTimeout(function () {
    d.mhg = new MhistoryGraph(d, false, false);
    d.mhg.initializePanel(historyIndex++, { "Timescale": cfg["History Timescale"] });
    d.mhg.resize();
  }, 0);
  return wrap;
}

function healthPanel() {
  const panel = el("div", { class: "dqm-panel" });
  panel.appendChild(el("h2", {}, "DAQ health"));
  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {},
    el("th", { class: "label" }, "equipment"),
    el("th", { class: "label" }, "status"),
    el("th", { class: "label" }, "frontend"),
    el("th", { class: "label" }, "host"),
    el("th", {}, "events"),
    el("th", {}, "ev/s"),
    el("th", {}, "kB/s")));
  panel.appendChild(table);
  panel.appendChild(el("div", { class: "dqm-note", id: "dqm-health-note" },
    "Enumerating equipment…"));

  // Every equipment in the experiment, ours or not -- that is the correct
  // generic behaviour, and it is a table row rather than a figure.
  DQM.lsODB(["/Equipment"]).then(function (data) {
    const names = Object.keys(data[0] || {}).filter((k) => !k.endsWith("/key")).sort();
    names.forEach(function (eq) {
      const base = `/Equipment/${eq}`;
      table.appendChild(el("tr", {},
        el("td", { class: "label" }, eq),
        el("td", { class: "label" }, modb("span", `${base}/Common/Status`)),
        el("td", { class: "label" }, modb("span", `${base}/Common/Frontend name`)),
        el("td", { class: "label" }, modb("span", `${base}/Common/Frontend host`)),
        el("td", {}, modb("span", `${base}/Statistics/Events sent`)),
        el("td", {}, modb("span", `${base}/Statistics/Events per sec.`, { format: "f1" })),
        el("td", {}, modb("span", `${base}/Statistics/kBytes per sec.`, { format: "f1" }))));
    });
    document.getElementById("dqm-health-note").remove();
  }).catch(function (e) {
    document.getElementById("dqm-health-note").textContent = "Could not enumerate equipment: " + e;
  });

  return panel;
}

function renderNothingFound(equipment, varsByEq) {
  const r = root();
  r.innerHTML = "";
  r.appendChild(el("h2", {}, "No scaler equipment found"));
  r.appendChild(el("div", { class: "dqm-note" },
    `Looked under /Equipment/*/Variables for keys matching ` +
    `${cfg["Bank Pattern"]} (capture 1 = role letter, capture 2 = board id), ` +
    `with role letters ${cfg["Role Rates"]}/${cfg["Role Timestamp"]}/` +
    `${cfg["Role Temperature"]}/${cfg["Role Threshold"]}. ` +
    `Configuration root: ${cfgRootFromUrl || DQM.CONFIG_ROOT}.`));

  const edit = el("button", { class: "mbutton" }, "Edit the bank pattern");
  edit.onclick = function () {
    dlgOdbEdit(`${cfgRootFromUrl || DQM.CONFIG_ROOT}/Bank Pattern`);
  };
  r.appendChild(edit);

  // Show what *is* there, so somebody porting this to another experiment can
  // see the shape they need to match without going to odbedit.
  r.appendChild(el("h3", {}, "What this experiment does have"));
  const table = el("table", { class: "dqm-table mtable" });
  table.appendChild(el("tr", {},
    el("th", { class: "label" }, "equipment"),
    el("th", { class: "label" }, "Variables keys"),
    el("th", {}, "lengths")));
  equipment.forEach(function (eq) {
    const ls = varsByEq[eq] || {};
    const keys = Object.keys(ls).filter((k) => !k.endsWith("/key"));
    table.appendChild(el("tr", {},
      el("td", { class: "label" }, eq),
      el("td", { class: "label" }, keys.join(", ") || "(none)"),
      el("td", {}, keys.map((k) => (ls[k + "/key"] || {}).num_values || 1).join(", "))));
  });
  r.appendChild(table);
  r.appendChild(healthPanel());
}

// ---------------------------------------------------------------------------
// Live behaviour
// ---------------------------------------------------------------------------

function onTimestamp(board, value) {
  const s = state[boardKey(board)];
  const v0 = DQM.asArray(value, board.banks.timestamp.numValues);
  const ticks = DQM.asUInt64(v0[0], v0[1]);
  // Only treat this as a fresh read if the timestamp actually moved. The first
  // callback is the initial ODB value, which may be minutes or days old -- and
  // dating stale numbers as current is the one thing this page must never do.
  if (s.ticks === null || ticks !== s.ticks) s.lastChange = Date.now();
  s.ticks = ticks;
  // The stale flag means the firmware had not recomputed since the last poll,
  // so the rates repeat the previous read rather than being a fresh measurement.
  s.stale = v0.length > 2 ? DQM.asUInt(v0[2]) : 0;
  updateChips(board);
}

function onRates(board, value) {
  const key = boardKey(board);
  const s = state[key];
  const rates = board.banks.rates;
  const disabled = Number(cfg["Disabled Value"]);
  const warn = Number(cfg["Rate Warn Hz"]);
  const alarm = Number(cfg["Rate Alarm Hz"]);

  // A board with no timestamp bank has nothing else to date its reads by.
  if (!board.banks.timestamp) s.lastChange = Date.now();

  const values = DQM.asArray(value, rates.numValues);
  for (let i = 0; i < rates.numValues; i++) {
    const v = Number(values[i]);
    s.rates[i] = v;

    const cell = document.getElementById(`rate-${key}-${i}`);
    if (!cell) continue;
    cell.classList.remove("masked", "warn", "alarm");

    if (values[i] === null || values[i] === undefined || Number.isNaN(v)) {
      cell.textContent = "—";
    } else if (v === disabled) {
      // Deliberately not "0": the frontend uses a signed sentinel precisely so
      // a channel excluded from the record reads differently from one that is
      // genuinely quiet.
      cell.classList.add("masked");
      cell.textContent = "masked";
    } else {
      cell.textContent = v.toLocaleString();
      if (alarm > 0 && v >= alarm) cell.classList.add("alarm");
      else if (warn > 0 && v >= warn) cell.classList.add("warn");
    }
  }
  updateDerived(board);
}

function updateDerived(board) {
  const key = boardKey(board);
  const s = state[key];
  const rates = board.banks.rates;
  const disabled = Number(cfg["Disabled Value"]);
  const triggers = DQM.asArray(cfg["Trigger Scaler Names"]).filter((x) => x);
  const clock = cfg["Clock Scaler Name"];

  // The sum covers input channels only. Trigger counters and the external
  // clock are not per-channel rates, and including them would produce a
  // number that disagrees with the one the beam-tuning loop optimises.
  let sum = 0, nReal = 0, allZero = true;
  const xs = [], ys = [];
  for (let i = 0; i < rates.numValues; i++) {
    const label = rates.labels[i];
    const v = s.rates[i];
    if (v === undefined) continue;
    if (triggers.indexOf(label) >= 0 || label === clock) continue;
    if (v !== disabled) {
      sum += v;
      nReal++;
      if (v !== 0) allZero = false;
      xs.push(label);
      ys.push(v);
    }
  }
  s.allZero = nReal > 0 && allZero;
  setText(`chip-sum-${key}`, nReal ? sum.toLocaleString() : "—");

  const clockIdx = indexOfName(board, clock);
  if (clockIdx >= 0 && s.rates[clockIdx] !== undefined) {
    setText(`chip-clk-${key}`, (s.rates[clockIdx] / 1e6).toFixed(3));
  }

  const div = document.getElementById(`plot-${key}`);
  if (div && div.mpg && xs.length) {
    div.mpg.setData(0, xs, ys);
    div.mpg.redraw();
  }
  updateChips(board);
}

function updateAllChips() {
  boards.forEach(updateChips);
}

function updateChips(board) {
  const key = boardKey(board);
  const s = state[key];
  const chip = document.getElementById(`chip-live-${key}`);
  const diag = document.getElementById(`diag-${key}`);
  if (!chip || !diag) return;

  const limit = staleLimit(board);
  const age = s.lastChange === null ? null : (Date.now() - s.lastChange) / 1000;

  chip.className = "dqm-chip";
  diag.className = "dqm-diagnosis";

  if (age === null) {
    chip.textContent = "waiting for first read";
    diag.textContent = "";
    setRowsStale(board, false);
    return;
  }

  if (age > limit) {
    // The failure that matters, and the one an ODB-driven page will otherwise
    // hide completely: the keys persist, so every number below goes on looking
    // live forever. Say the age and say the time.
    const when = new Date(s.lastChange).toLocaleTimeString();
    chip.className = "dqm-chip red";
    chip.textContent = `no new reads for ${Math.round(age)} s`;
    diag.className = "dqm-diagnosis red";
    diag.textContent =
      `No new scaler reads for ${Math.round(age)} s. The rates below are the last ` +
      `values seen at ${when}, not current. Check that the frontend is running and ` +
      `that the board is reachable.`;
    setRowsStale(board, true);
    return;
  }

  setRowsStale(board, false);

  if (s.stale) {
    chip.className = "dqm-chip yellow";
    chip.textContent = "stale";
    diag.className = "dqm-diagnosis yellow";
    diag.textContent =
      "The firmware had not recomputed its rates since the previous poll, so the " +
      "values below repeat the previous read rather than being a fresh measurement.";
    return;
  }

  if (s.allZero) {
    // Worth stating outright: this is the case people misread as a dead
    // readout, and the timestamp is the evidence that it is not.
    chip.className = "dqm-chip blue";
    chip.textContent = "live, all zero";
    diag.className = "dqm-diagnosis blue";
    diag.textContent =
      "Scaler subsystem alive — the board timestamp is advancing — and every input " +
      "rate is genuinely 0 Hz. Nothing is crossing threshold; this is not a dead readout.";
    return;
  }

  chip.className = "dqm-chip green";
  chip.textContent = "live";
  diag.textContent = s.ticks
    ? `Board timestamp ${(s.ticks / Number(cfg["Ticks Per Second"])).toFixed(1)} s of uptime.`
    : "";
}

/**
 * How long the timestamp may stand still before we stop calling the numbers current.
 *
 * The configured value is a floor, not the answer: the frontend's own
 * Common/Period decides how often a read can possibly happen, and an operator
 * who sets a 30 s poll interval must not get a page permanently in the red.
 * Two and a half periods allows one missed read plus jitter.
 */
function staleLimit(board) {
  const configured = Number(cfg["Stale Seconds"]) || 10;
  const period = state[boardKey(board)].periodMs;
  if (!period) return configured;
  return Math.max(configured, 2.5 * period / 1000);
}

function setRowsStale(board, stale) {
  const key = boardKey(board);
  const rates = board.banks.rates;
  for (let i = 0; i < rates.numValues; i++) {
    const row = document.getElementById(`row-${key}-${i}`);
    if (row) row.classList.toggle("stale", stale);
  }
}

// Referenced from a modb onchange attribute on the temperature chip.
window.dqmTempCell = function (cell) {
  const warn = Number(cfg["Temp Warn C"]);
  const alarm = Number(cfg["Temp Alarm C"]);
  const v = Number(cell.value);
  cell.style.color = (alarm > 0 && v >= alarm) ? "var(--mred, #c00)"
                   : (warn > 0 && v >= warn) ? "var(--myellow, #a80)" : "";
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  Object.keys(attrs || {}).forEach(function (k) {
    if (k === "class") e.className = attrs[k];
    else e.setAttribute(k, attrs[k]);
  });
  children.forEach(function (c) {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return e;
}

function modb(tag, path, opts) {
  const o = opts || {};
  const e = el(tag, { class: "modbvalue" });
  e.dataset.odbPath = path;
  if (o.format) e.dataset.format = o.format;
  if (o.editable) e.dataset.odbEditable = "1";
  if (o.id) e.id = o.id;
  if (o.onchange) {
    // Same first-value rule as the watchers above: onload covers the initial
    // read, onchange every one after it.
    e.setAttribute("onchange", `${o.onchange}(this)`);
    e.setAttribute("onload", `${o.onchange}(this)`);
  }
  return e;
}

function chipStatic(label, valueEl, unit) {
  return el("span", { class: "dqm-chip" },
    el("span", {}, label), el("b", {}, valueEl), unit ? el("span", {}, unit) : null);
}

function setText(id, text) {
  const e = document.getElementById(id);
  if (e) e.textContent = text;
}

function boardKey(board) { return `${board.equipment}-${board.board}`; }

function uniq(a) { return a.filter((v, i) => a.indexOf(v) === i); }

function indexOfName(board, name) {
  return board.banks.rates.labels.indexOf(name);
}

})();
