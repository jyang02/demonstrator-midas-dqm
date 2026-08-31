//
// dqm-brpc.js -- talking to an analyzer client through mhttpd's binary RPC.
//
// Generic: nothing here knows about WaveDream, or about which histograms exist.
// The framing is musip's, so this also drives musip's analyzer unmodified.
//
// Adapted from musip/custom/onlineDQM.js, with its truncation retry folded into
// a loop rather than duplicated, and its histogram decoder kept byte-identical.
//

(function (root) {
"use strict";

const HEADER_BYTES = 8;

/** Sensible first guesses. The header carries the true size, so one retry suffices. */
const DEFAULT_MAX = {
  "dqm::list": 64 * 1024,
  "dqm::metadata": 16 * 1024,
  "dqm::histogram": 1024 * 1024,
  "dqm::clear": 4 * 1024,
  "wd::status": 64 * 1024,
  "wd::defs": 64 * 1024,
};

/**
 * One binary RPC call, with the truncation retry.
 *
 * mhttpd's brpc mallocs `max_reply_length` on *every* call (mjsonrpc.cxx:3537),
 * so asking for 64 MB up front to be safe would cost a 64 MB allocation per
 * poll. Ask small, read the true size from the header, retry once.
 */
async function call(client, cmd, args, maxLength) {
  let max = maxLength || DEFAULT_MAX[cmd] || 64 * 1024;

  for (let attempt = 0; attempt < 2; attempt++) {
    const rpc = await mjsonrpc_call("brpc", {
      client_name: client,
      cmd: cmd,
      args: args || "",
      max_reply_length: max,
    }, "arraybuffer");

    if (rpc && rpc.result !== undefined) {
      // A JSON reply rather than binary: mhttpd could not reach the client.
      throw new Error(`${client} did not answer ${cmd} (status ${rpc.result.status})`);
    }
    if (!rpc || rpc.byteLength === 0) {
      return { tag: "", payload: new ArrayBuffer(0) };
    }
    if (rpc.byteLength < HEADER_BYTES) {
      throw new Error(`short reply to ${cmd}: ${rpc.byteLength} bytes`);
    }

    const view = new DataView(rpc);
    const size = view.getUint32(0, true);
    // The tag is four ASCII bytes. Read them as bytes, not as an integer:
    // musip's C++ and its JavaScript disagree about the endianness of that
    // word, and only the bytes are unambiguous.
    let tag = "";
    for (let i = 4; i < 8; i++) tag += String.fromCharCode(view.getUint8(i));

    if (rpc.byteLength < size) {
      if (attempt === 0) {
        max = size;
        continue;                    // the header told us how much to ask for
      }
      throw new Error(`${cmd} still truncated at ${size} bytes`);
    }
    return { tag: tag.trim(), payload: rpc.slice(HEADER_BYTES, size) };
  }
  throw new Error(`${cmd}: unreachable`);
}

function textOf(payload) {
  return new TextDecoder().decode(new Uint8Array(payload));
}

async function list(client) {
  const { tag, payload } = await call(client, "dqm::list", "");
  if (tag === "err") throw new Error(textOf(payload));
  return textOf(payload).split("\n").filter((s) => s.length);
}

async function json(client, cmd, args) {
  const { tag, payload } = await call(client, cmd, args);
  if (!payload.byteLength) return null;
  const text = textOf(payload);
  if (tag === "err") throw new Error(text);
  return JSON.parse(text);
}

async function histogram(client, name) {
  const { tag, payload } = await call(client, "dqm::histogram", name);
  if (tag === "err") throw new Error(textOf(payload));
  return decodeHistogram(payload);
}

/**
 * Decode the binary histogram format.
 *
 * Kept deliberately equivalent to musip's decodeHistogram: the alignment rules
 * are the fiddly part and there is no value in a second, subtly different
 * reading of the same bytes. See mdqm/dqm/framing.py for the layout.
 */
function decodeHistogram(arraybuffer) {
  const alignTo = (i, a) => (i % a === 0 ? i : i + (a - (i % a)));
  const dv = new DataView(arraybuffer);
  const LE = true;
  let at = 0;

  const version = dv.getUint8(at++);
  if (version !== 1) throw new Error(`unknown histogram version ${version}`);

  const type = dv.getUint8(at++);
  const isInteger = (type === 3 || type === 4);
  const dims = dv.getUint8(at++);

  const abscissa = [];
  for (let d = 0; d < dims; d++) abscissa.push(dv.getUint8(at++));
  const ordinate = dv.getUint8(at++);

  at = alignTo(at, 4);
  const nBins = [];
  let total = 1;
  for (let d = 0; d < dims; d++) {
    nBins.push(dv.getUint32(at, LE));
    at += 4;
    total *= nBins[d] + 2;             // +2 for under and overflow
  }

  const readFloat = (size, off) =>
    (size === 4 ? dv.getFloat32(off, LE) : dv.getFloat64(off, LE));

  const lowEdge = [], highEdge = [];
  for (let d = 0; d < dims; d++) {
    const size = abscissa[d];
    at = alignTo(at, size);
    lowEdge.push(readFloat(size, at)); at += size;
    highEdge.push(readFloat(size, at)); at += size;
  }

  at = alignTo(at, 8);
  const entries = Number(dv.getBigUint64(at, LE));
  at += 8;

  at = alignTo(at, ordinate);
  let data;
  if (ordinate === 4 && isInteger) data = new Uint32Array(arraybuffer, at, total);
  else if (ordinate === 4) data = new Float32Array(arraybuffer, at, total);
  else if (ordinate === 8) data = new Float64Array(arraybuffer, at, total);
  else throw new Error(`unknown ordinate size ${ordinate}`);

  return { dimensions: dims, nBins, lowEdge, highEdge, entries, data };
}

/**
 * Feed a decoded histogram to an MPlotGraph.
 *
 * 1D becomes a "histogram" plot, 2D a "colormap". Two mplot constraints drive
 * the shape of this:
 *
 *   - A colormap must be plot[0]: both the renderer (mplot.js:1962) and the
 *     z-scale bar (:2005) read param.plot[0] unconditionally. So one colormap
 *     per graph, never overlaid.
 *   - setData() computes a histogram's xData from the PREVIOUS yData length
 *     (:1108-1123), because g.yData is only assigned afterwards. On the first
 *     call yData is [] and dx comes out Infinity, so the first render is blank.
 *     Seeding yData first is the workaround.
 */
function display(hist, graph, index) {
  const plot = graph.param.plot[index];
  if (!plot) return;

  if (hist.dimensions === 1) {
    plot.type = "histogram";
    // Under/overflow are carried in the payload and shown as the outermost
    // bins, so the axis is widened by one bin at each end to hold them.
    const width = (hist.highEdge[0] - hist.lowEdge[0]) / hist.nBins[0];
    plot.xMin = hist.lowEdge[0] - width;
    plot.xMax = hist.highEdge[0] + width;
    plot.yData = Array.from(hist.data);        // seed the length setData reads
    plot.xData = undefined;                    // force the recompute
    graph.setData(index, undefined, Array.from(hist.data));
    return;
  }

  plot.type = "colormap";
  plot.showZScale = true;
  // Without this a persistence plot is a solid rainbow: the empty bins
  // dominate, and giving zero its own colour is what makes the trace visible.
  plot.zeroColor = "white";
  plot.nx = hist.nBins[0] + 2;
  plot.ny = hist.nBins[1] + 2;
  const wx = (hist.highEdge[0] - hist.lowEdge[0]) / hist.nBins[0];
  const wy = (hist.highEdge[1] - hist.lowEdge[1]) / hist.nBins[1];
  plot.xMin = hist.lowEdge[0] - wx;
  plot.xMax = hist.highEdge[0] + wx;
  plot.yMin = hist.lowEdge[1] - wy;
  plot.yMax = hist.highEdge[1] + wy;
  graph.setData(index, undefined, undefined, Array.from(hist.data));
}

/**
 * Serialised polling. One request in flight at a time, paused when hidden.
 *
 * The serialisation is the point: a fixed setInterval against a reply that
 * sometimes takes longer than the interval stacks requests behind each other
 * until mhttpd is the bottleneck. Re-arming from the response cannot.
 */
class AutoUpdater {
  constructor(update, intervalMs) {
    this.update = update;
    this.intervalMs = intervalMs || 1000;
    this.running = false;
    this._timer = null;
    this._onVisible = () => {
      if (!document.hidden && this.running && !this._timer) this._tick();
    };
    document.addEventListener("visibilitychange", this._onVisible);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this._timer) { window.clearTimeout(this._timer); this._timer = null; }
  }

  setInterval(ms) { this.intervalMs = ms; }

  async _tick() {
    this._timer = null;
    if (!this.running || document.hidden) return;
    let delay = this.intervalMs;
    try {
      await this.update();
    } catch (e) {
      // Back off rather than hammering an analyzer that is not answering.
      delay = Math.max(5000, this.intervalMs);
      if (typeof console !== "undefined") console.error("dqm update failed:", e);
      if (this.onError) this.onError(e);
    }
    if (this.running) this._timer = window.setTimeout(() => this._tick(), delay);
  }
}

const BRPC = { call, list, json, histogram, decodeHistogram, display, AutoUpdater, textOf };
root.BRPC = BRPC;
if (typeof module !== "undefined" && module.exports) module.exports = BRPC;

})(typeof globalThis !== "undefined" ? globalThis : this);
