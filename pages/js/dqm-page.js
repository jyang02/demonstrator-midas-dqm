//
// dqm-page.js -- the page renderer, and the file every page loads.
//
// There is one page now, ATAR, and it is a heading, a row of tabs, and inside
// the open tab one tile per element in spec order. A tab is a spec group; see
// buildTab below for why that is the whole of the mechanism. What differs
// between tiles is which of them have a renderer registered against them, and
// most do not.
//
// No tile says its own status. Every panel that is waiting for something now
// lives on the Proposed tab, so the tab a shifter is looking at is the status,
// and the count on the tab button is what says how much is waiting.
//
// That is not a placeholder arrangement. Most of the panels in the spec are
// blocked on DAQ work that does not exist -- no documented calorimeter bank, no
// track finding, no energy calibration with an owner. The deliverable is a page
// that *says so, in the panel*. A shifter who opens the Channels tab at 3am and
// finds a blank page learns nothing and stops trusting the menu; one who finds
// titled panels each naming what it is waiting for has just been told the state
// of the experiment.
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

//: The empty-state boxes of the blocked panels built so far, collected as they
//: are built so the analyzer probe can append to them without re-walking the
//: DOM. Cleared by render().
let blockedBoxes = [];

//: What the analyzer probe found, once it has answered: {note, editPath}, or
//: null while it is still in flight.
//:
//: Cached rather than applied and forgotten, because tabs are built lazily: the
//: probe runs once at boot and most of the boxes it has something to say about
//: do not exist yet. A box built later reads the cached answer on the spot, so
//: a tab opened ten minutes in carries the same footnote as the one that was
//: open when the page loaded.
let probe = null;

//: One record per tab: {entry, button, host, built}. Order is the spec's.
let tabs = [];

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Build one page. `canonical` is the spec's name for it, e.g. "ATAR".
 *
 * Deliberately not the /Custom key: with --prefix the key is "PIATAR" and the
 * URL says page=PIATAR, but a prefix is a menu-collision fix rather than an
 * experiment fork, so the catalogue lookup and the config subtree both stay
 * keyed on the spec's name. mhttpd_init() gets the URL's name, because that is
 * what the sidenav highlight matches against.
 */
async function boot(canonical) {
  const urlName = mhttpd_getParameterByName("page") || canonical;

  // Before the async work below, not after: this builds the header and sidenav
  // and installs the connection-lost handling, so a page that is still reading
  // the ODB still looks like a MIDAS page and still reports a dead mhttpd.
  // getMElements() re-scans the DOM every tick, so modb* elements added later
  // are picked up on the next cycle with no re-init.
  mhttpd_init(urlName, 1000);

  const entry = DQMPanels.byPage(canonical);
  if (!entry) {
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

  render(entry, canonical);

  // After the first paint, never before it. The page is complete without this;
  // what the probe adds is the difference between a sentence that was true when
  // it was written and one that is true now.
  //
  // Asked across every tab, not only the open one: the answer is cached and a
  // tab built later reads it, so probing once at boot is what makes the
  // footnote the same wherever a shifter starts.
  const anyBlocked = entry.tabs.some((tb) => tb.elements.some((e) => e.status === "blocked"));
  if (anyBlocked && typeof BRPC !== "undefined") {
    probeAnalyzer(canonical).catch(function () { /* the probe is a bonus */ });
  }
}

// ---------------------------------------------------------------------------
// Is anybody actually serving histograms?
// ---------------------------------------------------------------------------

/**
 * Ask the configured analyzer for its histogram list, once, and say what came back.
 *
 * Many panels here are blocked on "the analyzer client nobody has started".
 * That sentence is in the catalogue because it was true when the spec was
 * written. Checking it costs one serialised RPC per page load and buys two
 * things: the reason a shifter reads is about this experiment right now, and
 * the day somebody does start an analyzer these panels say so before any
 * renderer has been written for them.
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

  probe = { note: note, editPath: editPath };
  blockedBoxes.forEach(applyProbe);
}

/** Footnote one empty state with what the probe found. */
function applyProbe(box) {
  const foot = el("div", { class: "dqm-footnote dqm-probe" }, probe.note + " ");
  foot.appendChild(editButton(probe.editPath, "Edit"));
  box.appendChild(foot);
}

/**
 * Collect an empty state for the analyzer probe, and footnote it now if the
 * probe has already answered.
 *
 * Both halves are needed once tabs are built lazily. A box built before the
 * probe returns is footnoted when it does; a box built after -- every box on
 * every tab a shifter opens later -- is footnoted on the spot from the cache.
 */
function noteBlocked(box) {
  if (!box) return box;
  blockedBoxes.push(box);
  if (probe) applyProbe(box);
  return box;
}

/**
 * Have the analyzer probe footnote this box too.
 *
 * The probe normally reaches only panels nobody renders, which was right while
 * "no renderer" and "no analyzer" were the same sentence. A panel that renders
 * a placeholder *about* the analyzer -- dqm-hists.js holds the 2D plots back
 * for the browser's sake, not the analyzer's -- needs the same footnote, and
 * needs it more: its placeholder claims the histogram is still being
 * accumulated, and this is the line that checks rather than asserts it.
 *
 * Called from a renderer while its tab is being built, which may be before or
 * long after probeAnalyzer() ran; noteBlocked handles both.
 */
function probeThisBox(box) {
  return noteBlocked(box);
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

function render(entry, page) {
  const rootEl = document.getElementById("dqm-root");
  rootEl.innerHTML = "";
  blockedBoxes = [];
  probe = null;
  tabs = [];

  rootEl.appendChild(el("div", { class: "dqm-pagehead" }, el("h2", {}, entry.page)));

  const bar = el("div", { class: "dqm-tabbar", role: "tablist" });
  rootEl.appendChild(bar);

  entry.tabs.forEach(function (tab, i) {
    const button = el("button", { class: "dqm-tab", type: "button", role: "tab",
                                  id: `tab-${tab.group}` }, tab.name);
    // Panels only. A note is a sentence the tab wants read, not a plot that is
    // missing, and counting one as waiting made the Scope tab claim two empty
    // panels when it had one. With the waiting panels gathered onto Proposed
    // this is the only number on the page, so it must count the right things.
    const waiting = tab.elements.filter(
      (e) => e.kind === "panel" && e.status !== "ready").length;
    // The count is on the tab and not only inside it, so the size of the gap is
    // legible without opening anything. A tab that draws everything it has
    // wears no number rather than a zero.
    if (waiting) button.appendChild(el("span", { class: "dqm-tabcount" }, String(waiting)));
    button.addEventListener("click", function () { showTab(i, page); });
    bar.appendChild(button);

    const host = el("div", { class: "dqm-tabpanel", role: "tabpanel",
                             id: `tabpanel-${tab.group}` });
    host.style.display = "none";
    rootEl.appendChild(host);
    tabs.push({ entry: tab, button: button, host: host, built: false });
  });

  rootEl.appendChild(footer(page));
  showTab(openingTab(entry), page);
}

/**
 * Show one tab, building it the first time it is shown.
 *
 * Lazy on purpose, and it is load-bearing rather than an optimisation. mplot
 * sizes a graph from its host div, and a div inside a `display: none` tab
 * measures zero, so a plot built while hidden comes back blank with no error
 * anywhere -- the same silent failure as an mplot panel with no explicit
 * bounds. Building a tab when it is first shown means every renderer runs
 * against a host that has a size.
 *
 * It has a second effect worth having: the Scope tab's event poll and the
 * histogram tiles' timers do not start until somebody opens the tab they are
 * on. A page left open on Channels asks mhttpd for nothing that Scope would
 * have asked for.
 */
function showTab(i, page) {
  tabs.forEach(function (rec, j) {
    const on = i === j;
    rec.host.style.display = on ? "" : "none";
    rec.button.classList.toggle("active", on);
    rec.button.setAttribute("aria-selected", on ? "true" : "false");
  });

  const rec = tabs[i];
  if (!rec) return;
  if (!rec.built) {
    rec.built = true;
    buildTab(rec.entry, page, rec.host);
  }
  rememberTab(rec.entry.group);
}

/**
 * Fill one tab: its question, its counts, and a tile per element in spec order.
 *
 * A tab is a spec group, and that is the whole of the mechanism -- there is no
 * tab key in the spec and no second layout concept. A group was always "one
 * screen's worth of panels"; all that changed is that several groups now name
 * the same page.
 */
function buildTab(tab, page, host) {
  host.appendChild(el("div", { class: "dqm-tile-q" }, tab.question));
  tab.elements.forEach(function (element) {
    host.appendChild(element.kind === "note" ? noteNode(element) : panelNode(element, page));
  });
}

/**
 * Which tab to open with: the one named in `#tab=<group>`, else the first.
 *
 * A hash rather than a stored preference, so that "look at the Trends tab" is a
 * link somebody can paste into the eLog. An unknown or absent name opens the
 * first tab rather than nothing, because a page that renders no tab because a
 * bookmark went stale is the blank page this design exists to avoid.
 */
function openingTab(entry) {
  let want = "";
  try {
    want = String((typeof location !== "undefined" && location.hash) || "")
             .replace(/^#tab=/, "");
  } catch (e) { want = ""; }
  for (let i = 0; i < entry.tabs.length; i++) {
    if (entry.tabs[i].group === want) return i;
  }
  return 0;
}

/** Put the open tab in the URL, without adding a history entry per click. */
function rememberTab(group) {
  try {
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", `#tab=${group}`);
    }
  } catch (e) { /* a page served where history is unavailable is still a page */ }
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
  sec.appendChild(el("h3", { class: "dqm-tile-title" }, p.label));
  if (p.question) sec.appendChild(el("div", { class: "dqm-tile-q" }, p.question));

  const body = el("div", { class: "dqm-tile-body" });
  sec.appendChild(body);
  if (p.alarm) sec.appendChild(alarmNode(p));

  const fn = renderers[p.id];
  // The spec's `help` slot -- the sentence a shifter reads at 3am -- is empty on
  // every element, so `why` is the only prose besides the blocker. By its own
  // description it is the field that says what you *would* have learned from
  // this panel, "which is what an empty tile most needs to carry" -- and that
  // sentence is also the argument for not printing it under a tile that is
  // already showing the answer. A page of plots each carrying a paragraph
  // about why it is there is a page people stop reading, including the
  // paragraphs that matter.
  //
  // So it is printed on the tiles that cannot answer for themselves, and put
  // on the heading everywhere else, where it costs a hover rather than a
  // column inch and nothing is actually lost.
  if (p.why) {
    if (fn) sec.firstChild.title = "Why this panel exists: " + p.why;
    else sec.appendChild(el("div", { class: "dqm-footnote" },
      "Why this panel exists: " + p.why));
  }

  if (!fn) {
    const box = blocked(body, reasonFor(p), p);
    if (p.status === "blocked") noteBlocked(box);
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

// Keys are the spec's status vocabulary (spec/schema.md): ready, blocked,
// proposed, dropped. Panels no longer wear their status -- the tab they are on
// says it, and the tile's left border keeps the colour -- so a note's rule is
// the one reader left.
const CHIP = { ready: "green", blocked: "yellow", proposed: "blue", dropped: "" };

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
                  probeAnalyzer, probeThisBox, showTab,
                  el, modb, watch, chip, reasonFor };
root.DQMPage = DQMPage;
if (typeof module !== "undefined" && module.exports) module.exports = DQMPage;

})(typeof globalThis !== "undefined" ? globalThis : this);
