//
// dqm-waveforms.js -- the accumulated plots.
//
// Unlike the scaler and scope pages this one needs a backend, and the reason is
// worth stating: these histograms accumulate. They have to survive a page
// reload, be the same for everyone looking, and not compete for mhttpd's single
// event-buffer read pointer. That means a persistent consumer, which is the
// analyzer client.
//
// The page itself hardcodes no plot names. It asks the analyzer what it has
// (dqm::list) and draws whatever comes back, so a new histogram appears here
// without touching this file -- and so this page works against musip's analyzer
// too, since the wire format is theirs.
//

(function () {
"use strict";

const LS = "dqm-waveforms-settings";

const state = {
  client: "wd_analyzer",
  names: [],
  selected: new Set(),
  graphs: new Map(),        // name -> {div, mpg}
  intervalMs: 2000,
  updater: null,
  status: null,
  error: null,
};

window.addEventListener("load", function () {
  mhttpd_init(mhttpd_getParameterByName("page") || "Waveforms", 1000);
  restore();
  build();
  discover().catch(function (e) { fail(String(e)); });
});

// ---------------------------------------------------------------------------

async function discover() {
  const clients = await connectedClients();
  buildClientPicker(clients);

  // Ask only the one we are configured to talk to. Probing every MIDAS client
  // to find out which is an analyzer seems tidier and is not: brpc to a client
  // that has no RPC_BRPC handler blocks until rpc_client_connect times out, and
  // logs "[midas.cxx:rpc_client_connect,ERROR] timeout waiting for server
  // reply" where the operator sees it. Monitoring should not put red errors in
  // front of people to answer a question it can ask one client instead.
  try {
    state.names = await BRPC.list(state.client);
  } catch (e) {
    noAnalyzer(clients, e);
    return;
  }
  if (!state.selected.size) {
    // Everything, but capped: a first visit should show the plots, not sixty
    // canvases that take a second each to draw.
    state.names.slice(0, 8).forEach((n) => state.selected.add(n));
  }
  buildPlotPicker();
  layout();

  state.updater = new BRPC.AutoUpdater(refresh, state.intervalMs);
  state.updater.onError = (e) => setError(String(e && e.message ? e.message : e));
  state.updater.start();
}

/** Every MIDAS client currently connected, by name. Read-only, no probing. */
async function connectedClients() {
  try {
    const ls = await DQM.lsODB(["/System/Clients"]);
    const ids = Object.keys(ls[0] || {}).filter((k) => !k.endsWith("/key"));
    if (!ids.length) return [];
    const rpc = await mjsonrpc_db_get_values(ids.map((id) => `/System/Clients/${id}/Name`));
    return (rpc.result.data || []).filter((n) => typeof n === "string").sort();
  } catch (e) {
    return [];
  }
}

async function refresh() {
  state.status = await BRPC.json(state.client, "wd::status", "");
  renderStatus();

  for (const name of state.selected) {
    const entry = state.graphs.get(name);
    if (!entry) continue;
    const hist = await BRPC.histogram(state.client, name);
    BRPC.display(hist, entry.mpg, 0);
    entry.mpg.redraw();
    entry.count.textContent = `${hist.entries.toLocaleString()} entries`;
  }
  state.error = null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function root() { return document.getElementById("dqm-root"); }

function build() {
  const r = root();
  r.innerHTML = "";

  const bar = el("div", { class: "dqm-strip" });
  bar.appendChild(el("span", {}, "analyzer"));
  bar.appendChild(el("span", { id: "dqm-client-picker" }));
  bar.appendChild(labelled("update", select(
    [["1000", "1 Hz"], ["2000", "0.5 Hz"], ["5000", "0.2 Hz"], ["0", "paused"]],
    String(state.intervalMs),
    function (v) {
      state.intervalMs = Number(v);
      save();
      if (!state.updater) return;
      if (Number(v) === 0) state.updater.stop();
      else { state.updater.setInterval(Number(v)); state.updater.start(); }
    })));

  const clear = el("button", { class: "mbutton" }, "Clear all");
  clear.onclick = function () {
    dlgConfirm("Clear every accumulated histogram?", function (yes) {
      if (!yes) return;
      // A back-channel to the analyzer, which the retired stack did not have:
      // it watched a file on the DAQ machine's local disk, so the button broke
      // outright if the web layer was moved to another host.
      BRPC.json(state.client, "dqm::clear", "")
        .then(refresh)
        .catch((e) => setError(String(e)));
    });
  };
  bar.appendChild(clear);
  bar.appendChild(el("span", { class: "dqm-chip", id: "dqm-wf-status" }, "…"));
  r.appendChild(bar);

  r.appendChild(el("div", { class: "dqm-strip", id: "dqm-plot-picker" }));
  r.appendChild(el("div", { class: "dqm-diagnosis", id: "dqm-wf-diag" }, ""));
  r.appendChild(el("div", { class: "dqm-grid", id: "dqm-wf-grid" }));
}

function buildClientPicker(clients) {
  const holder = document.getElementById("dqm-client-picker");
  holder.innerHTML = "";
  // The configured name stays in the list even when nothing by that name is
  // connected, so the picker shows what we are asking for rather than silently
  // switching to something else.
  const options = clients.slice();
  if (options.indexOf(state.client) < 0) options.unshift(state.client);
  holder.appendChild(select(options.map((c) => [c, c]), state.client, function (v) {
    state.client = v;
    save();
    window.location.reload();
  }));
}

function buildPlotPicker() {
  const holder = document.getElementById("dqm-plot-picker");
  holder.innerHTML = "";
  holder.appendChild(el("span", {}, "plots"));
  state.names.forEach(function (name) {
    const id = `dqm-plot-${name.replace(/[^a-zA-Z0-9]/g, "_")}`;
    const box = el("input", { type: "checkbox", id: id });
    box.checked = state.selected.has(name);
    box.onchange = function () {
      if (this.checked) state.selected.add(name);
      else state.selected.delete(name);
      save();
      layout();
      if (state.updater) refresh().catch((e) => setError(String(e)));
    };
    const lab = el("label", { for: id, class: "dqm-chip" }, shortName(name));
    lab.insertBefore(box, lab.firstChild);
    holder.appendChild(lab);
  });
}

function layout() {
  const grid = document.getElementById("dqm-wf-grid");

  for (const [name, entry] of state.graphs) {
    if (!state.selected.has(name)) {
      entry.wrap.remove();
      state.graphs.delete(name);
    }
  }

  for (const name of state.names) {
    if (!state.selected.has(name) || state.graphs.has(name)) continue;

    const wrap = el("div", {});
    wrap.appendChild(el("div", { class: "dqm-histtitle" }, shortName(name)));
    const count = el("span", { class: "dqm-footnote" }, "");
    const div = el("div", { class: "dqm-plot" });
    wrap.appendChild(div);
    wrap.appendChild(count);
    grid.appendChild(wrap);

    const mpg = new MPlotGraph(div, {
      showMenuButtons: true,
      mouseWheelZoom: true,
      title: { text: "" },
      stats: { show: false },
      legend: { show: false },
    });
    div.mpg = mpg;
    mpg.addPlot({ label: name, xData: [], yData: [] });
    state.graphs.set(name, { wrap, div, mpg, count });
    // Sized from clientWidth at construction, before CSS has applied.
    window.setTimeout(function () { mpg.resize(); mpg.draw(); }, 0);
  }
}

function shortName(name) {
  return name.indexOf("/") >= 0 ? name.slice(name.indexOf("/") + 1) : name;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function renderStatus() {
  const chip = document.getElementById("dqm-wf-status");
  const diag = document.getElementById("dqm-wf-diag");
  const s = state.status;
  if (!chip || !diag) return;

  chip.className = "dqm-chip";
  diag.className = "dqm-diagnosis";
  if (!s) { chip.textContent = "no status"; return; }

  const bits = [`${s.events_processed} events`,
                `${s.processed_per_s}/s`,
                s.run_active ? `run ${s.run_number}` : "no run"];
  if (s.reconnects) bits.push(`${s.reconnects} reconnect(s)`);

  if (s.throttled) {
    // The analyzer backed itself off because the DAQ lost packets. That is the
    // one status worth interrupting someone about.
    chip.className = "dqm-chip red";
    chip.textContent = "throttled";
    diag.className = "dqm-diagnosis red";
    diag.textContent =
      `The analyzer reduced its own sampling rate to ${s.rate_limit}/s because the ` +
      `DAQ dropped packets while it was running. Monitoring must never be the cause ` +
      `of data loss, so it backs off rather than assuming it was innocent. Restart ` +
      `it to restore ${s.configured_rate}/s.`;
    return;
  }

  chip.className = "dqm-chip green";
  chip.textContent = "connected";
  diag.textContent = bits.join(" · ");

  // Why an RF plot is empty is a question worth answering before it is asked.
  const rej = s.plugin && s.plugin.rf_rejections;
  if (rej && Object.keys(rej).length) {
    const worst = Object.entries(rej).sort((a, b) => b[1] - a[1])[0];
    diag.textContent += `  —  RF phase rejecting events: ${worst[0]} (${worst[1]})`;
  }
  if (!s.run_active) {
    diag.textContent += "  —  no run is active, so no new waveform events are arriving.";
  }
}

function noAnalyzer(clients, cause) {
  const chip = document.getElementById("dqm-wf-status");
  const diag = document.getElementById("dqm-wf-diag");
  chip.className = "dqm-chip yellow";
  chip.textContent = "no analyzer";
  diag.className = "dqm-diagnosis yellow";

  const connected = (clients && clients.length)
    ? `Connected MIDAS clients are: ${clients.join(", ")}.`
    : "No MIDAS clients are connected at all.";

  diag.textContent =
    `'${state.client}' is not answering dqm::list. ${connected} ` +
    "These plots accumulate over many events, so unlike the Scalers and Scope " +
    "pages they need a process to accumulate them — start it with " +
    "scripts/start-analyzer.sh, or pick a different client above." +
    (cause ? `  (${cause.message || cause})` : "");
}

function setError(message) {
  state.error = message;
  const chip = document.getElementById("dqm-wf-status");
  const diag = document.getElementById("dqm-wf-diag");
  if (!chip || !diag) return;
  chip.className = "dqm-chip red";
  chip.textContent = "error";
  diag.className = "dqm-diagnosis red";
  diag.textContent = `Could not read from ${state.client}: ${message}`;
}

function fail(message) {
  root().innerHTML = "";
  root().appendChild(el("div", { class: "dqm-error" }, message));
}

// ---------------------------------------------------------------------------

function save() {
  try {
    window.localStorage.setItem(LS, JSON.stringify({
      client: state.client,
      intervalMs: state.intervalMs,
      selected: Array.from(state.selected),
    }));
  } catch (e) { /* private browsing or quota; not worth interrupting anyone */ }
}

function restore() {
  try {
    const o = JSON.parse(window.localStorage.getItem(LS) || "{}");
    if (o.client) state.client = o.client;
    if (o.intervalMs !== undefined) state.intervalMs = Number(o.intervalMs);
    (o.selected || []).forEach((n) => state.selected.add(n));
  } catch (e) { /* defaults are fine */ }
}

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

function select(options, current, onChange) {
  const s = el("select", {});
  options.forEach(function (o) {
    const opt = el("option", { value: o[0] }, o[1]);
    if (o[0] === current) opt.setAttribute("selected", "selected");
    s.appendChild(opt);
  });
  s.value = current;
  s.onchange = function () { onChange(this.value); };
  return s;
}

function labelled(text, node) {
  return el("span", { class: "dqm-chip" }, el("span", {}, text), node);
}

})();
