//
// dqm-page.js -- the shared page renderer, and the only file all seven pages load.
//
// Every page in this set is the same page with a different catalogue entry: a
// heading, a strip of status counts, and one tile per element in spec order.
// What differs is which tiles have a renderer registered against them. Five of
// the seven pages register none at all, and are complete as they stand.
//
// That is not a placeholder arrangement. Forty-one of the forty-four panels in
// the spec are blocked on DAQ work that does not exist -- no counting
// equipment, no documented ATAR bank, no analyzer client, no slow-control
// frontends. The deliverable is a page that *says so, in the panel*. A shifter
// who opens Channels at 3am and finds a blank page learns nothing and stops
// trusting the menu; one who finds eleven titled panels each naming what it is
// waiting for has just been told the state of the experiment.
//
// So the empty state is the primary state here, and the failure path and the
// normal path are the same path: a panel with no renderer, a renderer that
// throws, and a renderer whose promise rejects all end up showing the reason
// rather than nothing. One broken panel must never blank a page.
//

(function (root) {
"use strict";

const renderers = {};
let cfg = null;

//: The empty-state boxes of the blocked panels on this page, collected as they
//: are built so the analyzer probe can append to them without re-walking the
//: DOM. Cleared by render().
let blockedBoxes = [];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Build one page. `canonical` is the spec's name for it, e.g. "SlowControls".
 *
 * Deliberately not the /Custom key: with --prefix the key is "PISlowControls"
 * and the URL says page=PISlowControls, but a prefix is a menu-collision fix
 * rather than an experiment fork, so the catalogue lookup and the config
 * subtree both stay keyed on the spec's name. mhttpd_init() gets the URL's
 * name, because that is what the sidenav highlight matches against.
 */
async function boot(canonical) {
  const urlName = mhttpd_getParameterByName("page") || canonical;

  // Before the async work below, not after: this builds the header and sidenav
  // and installs the connection-lost handling, so a page that is still reading
  // the ODB still looks like a MIDAS page and still reports a dead mhttpd.
  // getMElements() re-scans the DOM every tick, so modb* elements added later
  // are picked up on the next cycle with no re-init.
  mhttpd_init(urlName, 1000);

  const group = DQMPanels.byPage(canonical);
  if (!group) {
    return fail(`No catalogue entry for the page "${canonical}". `
              + "pages/js/dqm-panels.js is generated from the spec; either this "
              + "page booted under the wrong name or the spec dropped it.");
  }

  try {
    cfg = await DQM.loadConfig(canonical);
  } catch (e) {
    // loadConfig does not throw, but a page that renders nothing because of a
    // config read would be the worst possible failure for this design.
    cfg = Object.assign({}, DQM.DEFAULTS["Common"], DQM.DEFAULTS[canonical] || {});
  }
  mhttpd_set_refresh_interval(Number(cfg["Refresh ms"]) || 1000);

  render(group, canonical);

  // After the first paint, never before it. The page is complete without this;
  // what the probe adds is the difference between a sentence that was true when
  // it was written and one that is true now.
  if (group.elements.some((e) => e.status === "blocked") && typeof BRPC !== "undefined") {
    probeAnalyzer(canonical).catch(function () { /* the probe is a bonus */ });
  }
}

// ---------------------------------------------------------------------------
// Is anybody actually serving histograms?
// ---------------------------------------------------------------------------

/**
 * Ask the configured analyzer for its histogram list, once, and say what came back.
 *
 * Every panel on Channels, Pulses and Physics is blocked on "the analyzer
 * client nobody has started". That sentence is in the catalogue because it was
 * true when the spec was written. Checking it costs one serialised RPC per page
 * load and buys two things: the reason a shifter reads is about this experiment
 * right now, and the day somebody does start an analyzer these pages say so
 * before any renderer has been written for them.
 *
 * Deliberately not a poll. There is nothing to update -- a panel that gains a
 * renderer will do its own polling, and until then re-asking every second would
 * be work inside the process serving run control for no answer that changes.
 */
async function probeAnalyzer(page) {
  const client = String(cfg["Analyzer Client"] || "").trim();
  const wanted = DQM.asArray(cfg["Histograms"]).filter((s) => s);
  let published = null;
  let note;

  if (!client) {
    note = `No analyzer client is named in ${DQM.CONFIG_ROOT}/Analyzer Client, `
         + "so this page does not know whom to ask.";
  } else {
    try {
      published = await BRPC.list(client);
    } catch (e) {
      note = `No client answered dqm::list as "${client}". That is the analyzer `
           + "these panels are waiting for; nothing is running under that name.";
    }
  }

  if (published && !wanted.length) {
    note = `"${client}" answers, but ${DQM.CONFIG_ROOT}/${page}/Histograms names `
         + `none of the ${published.length} histograms it publishes, so this page `
         + "does not know what to ask it for.";
  } else if (published) {
    const missing = wanted.filter((n) => published.indexOf(n) < 0);
    note = missing.length
      ? `"${client}" answers and does not publish ${missing.join(", ")}. `
        + `It publishes: ${published.join(", ") || "nothing"}.`
      : `"${client}" answers and publishes ${wanted.join(", ")}.`;
  }

  const editPath = published && !wanted.length
    ? `${DQM.CONFIG_ROOT}/${page}/Histograms`
    : `${DQM.CONFIG_ROOT}/Analyzer Client`;

  blockedBoxes.forEach(function (box) {
    const foot = el("div", { class: "dqm-footnote dqm-probe" }, note + " ");
    foot.appendChild(editButton(editPath, "Edit"));
    box.appendChild(foot);
  });
}

function fail(message) {
  const rootEl = document.getElementById("dqm-root");
  if (rootEl) {
    rootEl.innerHTML = "";
    rootEl.appendChild(el("div", { class: "dqm-error" }, message));
  }
}

// ---------------------------------------------------------------------------
// The renderer registry
// ---------------------------------------------------------------------------

/**
 * Claim one panel id. `fn({panel, cfg, body, page})` fills `body`, sync or async.
 *
 * Called at load time by the page files, which is why they are loaded after
 * this one. A panel nobody claims gets the empty state, which is the correct
 * outcome for forty-one of them and needs no code anywhere.
 */
function register(id, fn) { renderers[id] = fn; }

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

//
// What each sketch kind would have drawn, said in words. The spec's mockups
// drew a silhouette here; a silhouette in a real page is a shape that can be
// mistaken for a measurement, so this set says what the shape would have been
// and leaves the reason to carry the panel.
//
const SHAPE = {
  hist1d: "A histogram, one bar per channel, once there is data.",
  hist2d: "A two-dimensional histogram, once there is data.",
  trend: "A MIDAS history trend, drawn by mhistory.js once a frontend writes it.",
  table: "A table, once there is something to put in it.",
  scalar: "One number.",
  status: "A status line.",
  event: "One event's waveforms.",
  none: "",
};

// Keys are the spec's status vocabulary (spec/schema.md): ready, blocked,
// proposed, dropped. This said `live`, which the spec has never used, so the
// first panel to go ready would have worn an uncoloured chip.
const CHIP = { ready: "green", blocked: "yellow", proposed: "blue", dropped: "" };

function render(group, page) {
  const rootEl = document.getElementById("dqm-root");
  rootEl.innerHTML = "";
  blockedBoxes = [];

  const head = el("div", { class: "dqm-pagehead" },
    el("h2", {}, group.name),
    el("div", { class: "dqm-tile-q" }, group.question));
  rootEl.appendChild(head);
  rootEl.appendChild(summaryStrip(group));

  group.elements.forEach(function (element) {
    rootEl.appendChild(element.kind === "note" ? noteNode(element) : panelNode(element, page));
  });

  rootEl.appendChild(footer(page));
}

/**
 * The counts, so the state of the page is legible before any panel is read.
 */
function summaryStrip(group) {
  const counts = {};
  group.elements.forEach(function (e) { counts[e.status] = (counts[e.status] || 0) + 1; });
  const strip = el("div", { class: "dqm-strip" });
  ["blocked", "proposed", "dropped"].forEach(function (status) {
    if (!counts[status]) return;
    strip.appendChild(el("span", { class: `dqm-chip ${CHIP[status] || ""}` },
      el("b", {}, String(counts[status])), el("span", {}, status)));
  });
  return strip;
}

function statusChip(status) {
  return el("span", { class: `dqm-chip ${CHIP[status] || ""}` }, status);
}

/**
 * Why this panel is not showing data, in the panel's own words.
 *
 * A blocked panel is waiting for something somebody has to build; a dropped one
 * is not waiting for anything, it was decided against and is kept so the
 * decision is not re-argued. Those are different sentences and must not be
 * merged.
 */
function reasonFor(p) {
  if (p.status === "blocked") return p.blocked_by || "Blocked, for a reason nobody wrote down.";
  if (p.status === "dropped") return "Dropped from the page set. " + (p.note || "");
  if (p.status === "proposed") {
    return "Proposed. Nobody has agreed to this panel yet, so nothing draws it.";
  }
  return "Nothing draws this panel yet.";
}

function panelNode(p, page) {
  const sec = el("section", { class: `dqm-panel dqm-tile dqm-tile-${p.size || "m"}`, id: p.id });
  sec.dataset.status = p.status;
  sec.appendChild(el("h3", { class: "dqm-tile-title" }, p.label, statusChip(p.status)));
  if (p.question) sec.appendChild(el("div", { class: "dqm-tile-q" }, p.question));

  const body = el("div", { class: "dqm-tile-body" });
  sec.appendChild(body);
  if (p.alarm) sec.appendChild(alarmNode(p));
  // The spec's `help` slot -- the sentence a shifter reads at 3am -- is empty on
  // every element, so `why` is the only prose besides the blocker. It is the
  // field that says what you *would* have learned from this panel, which is
  // what an empty tile most needs to carry.
  if (p.why) sec.appendChild(el("div", { class: "dqm-footnote" }, "Why this panel exists: " + p.why));

  const fn = renderers[p.id];
  if (!fn) {
    const box = blocked(body, reasonFor(p), p);
    if (p.status === "blocked") blockedBoxes.push(box);
    return sec;
  }

  // Both arms of this matter. A renderer is the only code on the page that
  // touches an ODB path nobody has verified, so it is the code most likely to
  // throw -- and a page that blanks because one panel threw is worse than a
  // page with one panel's excuse in it.
  try {
    const out = fn({ panel: p, cfg: cfg, body: body, page: page });
    if (out && typeof out.catch === "function") {
      out.catch(function (e) { drawFailed(body, p, e); });
    }
  } catch (e) {
    drawFailed(body, p, e);
  }
  return sec;
}

function drawFailed(body, p, e) {
  body.innerHTML = "";
  blocked(body, `This panel failed to draw: ${e}`, p);
}

/**
 * The empty state. A dashed box, never an empty axis.
 *
 * `editPath` is an ODB key the operator can correct. It appears whenever a
 * panel is empty *because a configured path did not resolve*, which is what
 * makes "every path here is proposed, correct it during a shift" a visible
 * property rather than merely a true one.
 */
function blocked(body, reason, p, editPath) {
  const box = el("div", { class: "dqm-empty" });
  const what = SHAPE[(p && p.sketch) || "none"];
  if (what) box.appendChild(el("div", { class: "dqm-empty-what" }, what));
  box.appendChild(el("div", { class: "dqm-empty-why" }, reason));

  // A panel the spec pinned to an ODB path says which one, even when it is
  // waiting on the frontend that would write it. "Waiting for ATAR_SC" is an
  // instruction someone can act on; "no data" is not. The path is the spec's,
  // which is the one to check the deployed build against -- the live one the
  // page would read is in this page's own config subtree, and the footer names
  // that.
  if (p && p.odb && p.odb.path) {
    const kind = p.odb.type ? ` (${p.odb.type}${p.odb.array_size ? `[${p.odb.array_size}]` : ""})` : "";
    box.appendChild(el("div", { class: "dqm-footnote dqm-waitsfor" },
      `Specified against ${p.odb.path}${kind}. Nothing writes it yet.`));
  }

  if (editPath) {
    const foot = el("div", { class: "dqm-footnote" }, `Path: ${editPath} `);
    foot.appendChild(editButton(editPath));
    box.appendChild(foot);
  }
  body.appendChild(box);
  return box;
}

/** An .mbutton that opens one ODB key in mhttpd's own editor. */
function editButton(path, label) {
  const b = el("button", { class: "mbutton" }, label || "Edit this path");
  b.addEventListener("click", function () { dlgOdbEdit(path); });
  return b;
}

/**
 * The alarm, as the two-part sentence the spec wrote it as.
 *
 * Uncoloured by default, and that is a claim rather than a default: on a
 * blocked panel the condition cannot be evaluated, so colouring it would say
 * something the page does not know. A live renderer upgrades it with
 * classList.add("yellow"|"red") once it can actually test the condition.
 */
function alarmNode(p) {
  return el("div", { class: "dqm-diagnosis", id: `alarm-${p.id}` },
    el("b", {}, "If "), p.alarm.condition,
    el("b", {}, " then "), p.alarm.action);
}

/** Colour a panel's alarm line, or clear it. `level` is "", "yellow" or "red". */
function setAlarm(id, level) {
  const node = document.getElementById(`alarm-${id}`);
  if (!node) return;
  node.classList.remove("yellow", "red");
  if (level) node.classList.add(level);
}

/**
 * A note is a page-level statement, not a tile: it is the sentence the spec
 * wanted read before the panels under it.
 */
function noteNode(n) {
  const box = el("div", { class: `dqm-diagnosis ${CHIP[n.status] || ""}`, id: n.id });
  box.appendChild(el("b", {}, n.label));
  if (n.body) {
    box.appendChild(el("br"));
    box.appendChild(document.createTextNode(n.body));
  }
  const wrap = el("div", {}, box);
  if (n.blocked_by) wrap.appendChild(el("div", { class: "dqm-footnote" }, n.blocked_by));
  return wrap;
}

function footer(page) {
  const bits = [`Panels generated from the page spec, ${DQMPanels.SPEC_SHA256.slice(0, 12)}.`];
  bits.push(`Configuration: ${DQM.CONFIG_ROOT}/${page}.`);
  if (cfg && (!cfg._seeded || !cfg._pageSeeded)) {
    bits.push("That subtree does not exist, so this page is using built-in defaults; "
            + "run mdqm-register-pages to make them editable.");
  }
  return el("div", { class: "dqm-footnote" }, bits.join(" "));
}

// ---------------------------------------------------------------------------
// Small helpers, shared rather than copied into every page file
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

/**
 * A cell mhttpd's refresh loop keeps current.
 *
 * `onchange` is paired with `onload` on purpose and the pairing is load-bearing:
 * mhttpd stores a watcher's first value silently and calls onload for it,
 * firing onchange only on *subsequent* changes. A handler wired to onchange
 * alone never runs while a value is static -- which is exactly the dead
 * frontend case, i.e. exactly when a panel most needs to say something.
 */
function modb(tag, path, opts) {
  const o = opts || {};
  const e = el(tag, { class: "modbvalue" });
  e.dataset.odbPath = path;
  if (o.format) e.dataset.format = o.format;
  if (o.editable) e.dataset.odbEditable = "1";
  if (o.id) e.id = o.id;
  if (o.onchange) {
    e.setAttribute("onchange", `${o.onchange}(this)`);
    e.setAttribute("onload", `${o.onchange}(this)`);
  }
  return e;
}

/**
 * An invisible watcher on a whole ODB key, calling `fn(value)` every tick.
 *
 * Deliberately one watcher per array rather than one modbvalue per element.
 * mhttpd rewrites a modbvalue's innerHTML on every tick while firing onchange
 * only on a change, so any per-cell post-processing is correct for one tick and
 * then silently reverts. Owning the text outright is the only way a masked
 * value, a stale read and an alarm can render differently.
 */
function watch(path, fn) {
  const w = el("div", { name: "modb" });
  w.dataset.odbPath = path;
  w.onload = w.onchange = function () { fn(this.value); };
  return w;
}

/** A label/value/unit pill, the page set's one readout idiom. */
function chip(label, valueNode, unit, cls) {
  return el("span", { class: `dqm-chip ${cls || ""}` },
    label ? el("span", {}, label) : null,
    el("b", {}, valueNode),
    unit ? el("span", {}, unit) : null);
}

// ---------------------------------------------------------------------------
// Publish. `DQMPage` in a browser, module.exports under node --test.
// ---------------------------------------------------------------------------
const DQMPage = { boot, register, render, blocked, editButton, setAlarm, SHAPE,
                  probeAnalyzer,
                  el, modb, watch, chip, statusChip, reasonFor };
root.DQMPage = DQMPage;
if (typeof module !== "undefined" && module.exports) module.exports = DQMPage;

})(typeof globalThis !== "undefined" ? globalThis : this);
