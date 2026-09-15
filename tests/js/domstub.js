//
// A minimal DOM + MIDAS stub, enough to run a page end to end under node.
//
// Not jsdom: the page uses a small, known slice of the DOM, and a stub we can
// read the source of is worth more here than a dependency. Anything the page
// starts using that is missing shows up immediately as a TypeError rather than
// as a silently wrong render.
//

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.id = "";
    this._text = null;
    this.listeners = {};
    this.onchange = null;
    this.onclick = null;
    this.classList = {
      add: (...c) => this._classes(c, true),
      remove: (...c) => this._classes(c, false),
      toggle: (c, on) => this._classes([c], on),
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  _classes(list, on) {
    const cur = new Set(this.className.split(/\s+/).filter(Boolean));
    for (const c of list) { if (on) cur.add(c); else cur.delete(c); }
    this.className = [...cur].join(" ");
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "id") this.id = String(v);
    if (k === "class") this.className = String(v);
  }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  get firstChild() { return this.children.length ? this.children[0] : null; }
  // The DOM spells this parentNode; the stub stored it as `parent` and page
  // code reaching for the standard name got undefined, which surfaces as a
  // TypeError three frames from the cause.
  get parentNode() { return this.parent || null; }
  remove() {
    if (!this.parent) return;
    const i = this.parent.children.indexOf(this);
    if (i >= 0) this.parent.children.splice(i, 1);
  }
  addEventListener(name, fn) { (this.listeners[name] = this.listeners[name] || []).push(fn); }
  dispatch(name) { (this.listeners[name] || []).forEach((f) => f.call(this)); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (this._text !== null) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set innerHTML(v) { this.children = []; this._text = v === "" ? null : String(v); }
  get innerHTML() { return this.textContent; }

  // --- helpers for tests ---
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  find(pred) { for (const e of this.walk()) if (pred(e)) return e; return null; }
  findAll(pred) { return [...this.walk()].filter(pred); }
  byClass(c) { return this.findAll((e) => e.classList.contains(c)); }
  byTag(t) { return this.findAll((e) => e.tagName === t.toUpperCase()); }
}

class TextNode extends El {
  constructor(t) { super("#text"); this._text = String(t); }
}

function makeDocument() {
  const doc = {
    _byId: new Map(),
    createElement: (t) => new El(t),
    createTextNode: (t) => new TextNode(t),
    getElementById(id) {
      if (this._byId.has(id)) return this._byId.get(id);
      for (const rootEl of this._roots) {
        const hit = rootEl.find((e) => e.id === id);
        if (hit) return hit;
      }
      return null;
    },
    getElementsByName: () => [],
    getElementsByClassName: () => [],
    _roots: [],
    // A page that keeps pulling 33 kB events out of a shared buffer while its
    // tab is hidden is a bug, so the pages check this and the stub models it.
    hidden: false,
    _listeners: {},
    addEventListener(name, fn) { (this._listeners[name] = this._listeners[name] || []).push(fn); },
    removeEventListener(name, fn) {
      const l = this._listeners[name] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatch(name) { (this._listeners[name] || []).forEach((f) => f()); },
  };
  return doc;
}

/**
 * Install globals and run a page script. Returns handles for assertions.
 *
 * `responses` maps an RPC method name to a function(params) -> result object.
 */
function runPage(scriptPath, responses, opts = {}) {
  const fs = require("node:fs");
  const doc = makeDocument();
  const root = new El("div");
  root.id = "dqm-root";
  doc._roots.push(root);
  doc._byId.set("dqm-root", root);

  const calls = [];
  const timers = [];
  const intervals = [];
  const g = globalThis;

  const rpc = (method, params) => {
    calls.push({ method, params });
    const fn = responses[method];
    if (!fn) return Promise.reject(new Error(`unstubbed RPC: ${method}`));
    const out = fn(params);
    return out instanceof Promise ? out : Promise.resolve({ result: out });
  };

  const loadHandlers = [];
  g.document = doc;
  g.window = {
    addEventListener: (n, f) => { if (n === "load") loadHandlers.push(f); },
    location: { href: "http://localhost:8088/?cmd=custom&page=" + (opts.boot || "") },
  };
  // The page assigns window.dqmTempCell; keep window and globalThis in sync so
  // an inline onchange="dqmTempCell(this)" would resolve the same way.
  g.window.__proto__ = g;

  g.mhttpd_getParameterByName = (n) => (opts.params || {})[n] || "";
  g.mhttpd_init = (...a) => calls.push({ method: "mhttpd_init", params: a });
  g.mhttpd_set_refresh_interval = (ms) => calls.push({ method: "refresh", params: ms });
  g.mjsonrpc_call = (m, p) => rpc(m, p);
  g.mjsonrpc_db_get_values = (paths) => rpc("db_get_values", { paths });
  g.mjsonrpc_db_get_value = (path) => rpc("db_get_value", { paths: [path] });
  g.mjsonrpc_db_paste = (paths, values) => rpc("db_paste", { paths, values });
  g.mjsonrpc_error_alert = (e) => calls.push({ method: "error_alert", params: e });
  g.mhistory_dialog_var = (v, o) => calls.push({ method: "mhistory_dialog_var", params: [v, o] });
  g.dlgOdbEdit = (p) => calls.push({ method: "dlgOdbEdit", params: p });

  // Models mplot.js closely enough to catch API misuse, including the two sharp
  // edges that bit during development:
  //   findPlot()   alerts when the label is missing (mplot.js:977) -- it is not
  //                an existence test, and using it as one puts a modal dialog in
  //                front of the operator.
  //   deletePlot() splices findPlot()'s return with no check, so a missing label
  //                alerts and then removes the LAST plot instead.
  g.__alerts = [];
  g.alert = (msg) => { g.__alerts.push(String(msg)); };
  g.MPlotGraph = class {
    constructor(div, param) {
      this.div = div;
      this.param = Object.assign({ plot: [] }, param || {});
      if (!this.param.plot) this.param.plot = [];
      this.data = []; this.draws = 0; this.resizes = 0;
    }
    get plots() { return this.param.plot; }
    addPlot(p) { this.param.plot.push(p); return this.param.plot.length - 1; }
    findPlot(label) {
      if (typeof label === "string") {
        for (let i = 0; i < this.param.plot.length; i++) {
          if (this.param.plot[i].label === label) return i;
        }
        g.alert('Plot "' + label + '" not found');
        return -1;
      }
      return label;
    }
    deletePlot(label) { this.param.plot.splice(this.findPlot(label), 1); }
    setData(i, x, y, z) { this.data[i] = { x, y, z }; }
    // mplot.js folds the per-plot xMin/xMax/yMin/yMax the caller set into the
    // graph-level bounds drawYAxis() reads. Modelled rather than stubbed
    // empty: a page that sets per-plot bounds and never has them folded draws
    // an axis over the wrong range, and a no-op here would pass that.
    calcMinMax() {
      const vals = (k) => this.param.plot
        .map((p) => p[k])
        .filter((v) => typeof v === "number" && isFinite(v));
      const lo = (k) => (vals(k).length ? Math.min.apply(null, vals(k)) : undefined);
      const hi = (k) => (vals(k).length ? Math.max.apply(null, vals(k)) : undefined);
      this.xMin = lo("xMin"); this.xMax = hi("xMax");
      this.yMin = lo("yMin"); this.yMax = hi("yMax");
      this.calcs = (this.calcs || 0) + 1;
    }
    draw() { this.draws++; }
    redraw() { this.draws++; }
    resize() { this.resizes++; }
  };
  g.MhistoryGraph = class {
    constructor(div) { this.div = div; this.panels = []; }
    initializePanel(i, p) { this.panels.push([i, p]); }
    resize() {}
  };

  g.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  g.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };

  // The scripts, in the order the page's <head> lists them. Order is not
  // cosmetic: a page file calls DQMPage.register() at load, so dqm-page.js has
  // to have run first, exactly as in the browser.
  new Function(fs.readFileSync(scriptPath, "utf8"))();
  for (const extra of (opts.also || [])) new Function(fs.readFileSync(extra, "utf8"))();

  // The page's own inline <script>: one boot call naming the page. Modelled
  // rather than parsed out of the HTML; tests/test_manifest.py separately
  // asserts that each page file contains exactly this call for its own key.
  if (opts.boot) loadHandlers.push(() => g.DQMPage.boot(opts.boot));

  return {
    doc, root, calls, timers, intervals,
    async load() {
      for (const h of loadHandlers) h();
      // Let the boot() promise chain settle.
      for (let i = 0; i < 50; i++) await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    flushTimers() { const t = timers.splice(0); t.forEach((f) => f()); },
    tick() { this.intervals.forEach((i) => i.fn()); },
  };
}

/**
 * Model mhttpd's refresh loop faithfully, because its contract is subtle enough
 * that guessing at it produces pages that work in a test and not in a browser.
 *
 * From mhttpd.js:2651-2733, per tick:
 *
 *   modb (invisible watcher)
 *     first tick : store json_value and value; call onload(); do NOT call onchange()
 *     later ticks: call onchange() only if JSON.stringify(value) actually changed
 *
 *   modbvalue (visible cell)
 *     every tick : rewrite innerHTML from the ODB value, unconditionally
 *     first tick : call onload()
 *     later ticks: call onchange() only if the value changed
 *
 * The two traps that follow, and that this models:
 *   - a watcher whose handler renders anything never renders it at all while
 *     the value is static -- which is exactly the case when a frontend is down;
 *   - a modbvalue whose onchange rewrites its text is correct for one tick and
 *     then reverts, because innerHTML is rewritten every tick regardless.
 */
class Refresher {
  constructor(root, values) {
    this.root = root;
    this.values = values;          // {odbPath: value}
    this.tick = 0;
  }
  set(path, value) { this.values[path] = value; }
  run() {
    this.tick++;
    for (const e of this.root.walk()) {
      const path = e.dataset.odbPath;
      if (path === undefined) continue;
      const isWatcher = e.getAttribute("name") === "modb";
      const isValue = e.classList.contains("modbvalue");
      const isCheck = e.classList.contains("modbcheckbox");
      if (!isWatcher && !isValue && !isCheck) continue;
      if (!(path in this.values)) continue;

      const x = this.values[path];
      const json = JSON.stringify(x);

      if (isValue) e.innerHTML = String(x);   // unconditional, every tick
      if (isCheck) e.checked = !!x;

      const first = e._odbLoaded === undefined;
      const changed = e._json !== undefined && e._json !== json;
      e._json = json;
      e.value = x;

      if (!first && changed && typeof e.onchange === "function") e.onchange();
      if (first) {
        e._odbLoaded = true;
        if (typeof e.onload === "function") e.onload();
      }
    }
  }
}

module.exports = { El, runPage, makeDocument, Refresher };
