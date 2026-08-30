//
// dqm-wdbanks.js -- WaveDream bank decoding in the browser.
//
// A direct port of `wdscalers/wdunpack.py`, which is the reference
// implementation of these formats. Keep the two in step: if you change a
// constant here, change it there, and say why in both.
//
// This is the only experiment-specific file in the scope path. Everything else
// -- fetching events, drawing them -- is generic.
//

(function (root) {
"use strict";

const DAQ_CLOCK_HZ = 80e6;      // per-event hardware timestamp tick rate
const VOLTAGE_SCALE = 1e4;      // DRS_CF_V_MODE00: encoded int16 / this = volts
const N_CELLS = 1024;           // DRS4 sampling cells per channel
const ENC_MODE_PLAIN = 0;       // mode 11 is adaptive rebinning
const DRSV_HEADER = 10;         // flags, address, data_size, first_bin, temperature
const DRST_HEADER = 12;         // ...plus trigger_cell and nominal_ps. NOT the same.

const EVENT_IDS_WAVEFORM = [401, 1];   // current first; 1 predates 2026-07-30

/**
 * Global channel 0..17 from the packed address field.
 *
 * Inverse of the frontend's packing, where 16 and 17 are the two DRS clock
 * channels and carry channel-on-chip 8.
 */
function channelIndex(address) {
  const chanOnChip = address & 0x000f;
  const chip = (address >> 4) & 0x1;
  return chanOnChip === 8 ? 16 + chip : chip * 8 + chanOnChip;
}

/**
 * Decode a DRSV bank.
 *
 * `bytes` is the Uint8Array bkToObj() hands back for a TID_BYTE bank.
 * Returns {channels: [{channel, firstBin, volts, decoded, encoding}], temperatureC}.
 *
 * A channel in an encoding mode we cannot read comes back with decoded=false and
 * no samples, never with plausible-looking wrong ones: mode 11 rebins adaptively
 * and the per-bin factors are not reconstructible from this bank alone. The
 * Python reference returns None for exactly this reason.
 */
function decodeDRSV(bytes) {
  const out = { channels: [], temperatureC: null };
  if (!bytes || !bytes.length) return out;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength;
  let off = 0;

  while (off + DRSV_HEADER <= n) {
    const flags = dv.getUint16(off, true);
    const address = dv.getUint16(off + 2, true);
    const dataSize = dv.getUint16(off + 4, true);
    const firstBin = dv.getUint16(off + 6, true);
    const tempRaw = dv.getInt16(off + 8, true);
    off += DRSV_HEADER;

    if (dataSize === 0 || off + dataSize > n) break;

    const channel = channelIndex(address);
    const encoding = (flags & 0x03e0) >> 5;

    let volts = null;
    if (encoding === ENC_MODE_PLAIN) {
      const count = dataSize >> 1;
      volts = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        volts[i] = dv.getInt16(off + i * 2, true) / VOLTAGE_SCALE;
      }
    }

    out.channels.push({
      channel: channel,
      firstBin: firstBin,
      encoding: encoding,
      decoded: volts !== null,
      volts: volts,
    });
    if (out.temperatureC === null) out.temperatureC = tempRaw / 100.0;
    off += dataSize;
  }
  out.channels.sort((a, b) => a.channel - b.channel);
  return out;
}

/**
 * Decode a DRST bank: the DRS time base.
 *
 * Both forms are handled. The full per-channel 1024-cell width table rides only
 * the run's **first** event -- 73,944 bytes, against a 192-byte header-only DRST
 * on every event after it -- so a page that opens mid-run never sees one, and
 * `widths` comes back empty. `nominalPs` is on every event, which is why the
 * uniform-nanosecond axis always works and the calibrated one does not.
 */
function decodeDRST(bytes) {
  const out = { widths: {}, triggerCell: {}, nominalPs: null };
  if (!bytes || !bytes.length) return out;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.byteLength;
  let off = 0;

  while (off + DRST_HEADER <= n) {
    const address = dv.getUint16(off + 2, true);
    const dataSize = dv.getUint16(off + 4, true);
    const triggerCell = dv.getUint16(off + 8, true);
    const nominalPs = dv.getUint16(off + 10, true);
    off += DRST_HEADER;

    const ch = channelIndex(address);
    out.triggerCell[ch] = triggerCell;
    if (out.nominalPs === null && nominalPs) out.nominalPs = nominalPs;

    if (dataSize === 0) continue;
    if (off + dataSize > n) break;
    if (dataSize === N_CELLS * 4) {
      const w = new Float32Array(N_CELLS);
      for (let i = 0; i < N_CELLS; i++) w[i] = dv.getFloat32(off + i * 4, true);
      out.widths[ch] = w;
    }
    off += dataSize;
  }
  return out;
}

/** Decode a WDEH bank: 8 uint32 per board. */
function decodeWDEH(u32) {
  const boards = [];
  if (!u32) return boards;
  for (let i = 0; i + 8 <= u32.length; i += 8) {
    boards.push({
      crate: u32[i], slot: u32[i + 1], boardId: u32[i + 2],
      eventNumber: u32[i + 3], triggerNumber: u32[i + 4], triggerType: u32[i + 5],
      timestampTicks: u32[i + 7] * 4294967296 + u32[i + 6],
    });
  }
  return boards;
}

/** Pull the named bank out of a bkToObj() event. */
function bank(event, name) {
  if (!event || !event.bank) return null;
  for (const b of event.bank) if (b.name === name) return b;
  return null;
}

/**
 * Decode a whole event into something drawable.
 *
 * `widths` is the caller's DRS width table, for the same reason the Python
 * `decode_event` takes one: the table exists only on the run's first event, so
 * whoever is watching has to hold on to it.
 */
function decodeEvent(event, widths) {
  if (!event || EVENT_IDS_WAVEFORM.indexOf(event.event_id) < 0) return null;
  const drsv = bank(event, "DRSV");
  if (!drsv || !drsv.array || !drsv.array.length) return null;

  const wf = decodeDRSV(drsv.array);
  const drst = bank(event, "DRST");
  const t = drst && drst.array ? decodeDRST(drst.array) : null;
  const wdeh = bank(event, "WDEH");
  const boards = wdeh ? decodeWDEH(wdeh.array) : [];

  const haveNew = t && Object.keys(t.widths).length > 0;
  return {
    serial: event.serial_number,
    channels: wf.channels,
    temperatureC: wf.temperatureC,
    triggerCell: t ? t.triggerCell : {},
    nominalPs: t ? t.nominalPs : null,
    widths: haveNew ? t.widths : (widths || null),
    widthsAreCached: !haveNew && !!widths,
    board: boards.length ? boards[0] : null,
  };
}

/**
 * Sample times in nanoseconds.
 *
 * Three modes, and the default is deliberately not the calibrated one. The
 * reference implementation's own docstring records that the 700 MHz width table
 * was visibly wrong on run 113 and that a uniform grid is the better of two
 * imperfect choices there. `nominalPs` rides every event, so uniform always
 * works; calibrated needs a table that a mid-run attach never receives.
 */
function sampleTimes(frame, ch, mode, nSamples) {
  const out = new Float64Array(nSamples);
  if (mode === "bin") {
    const first = chanFirstBin(frame, ch);
    for (let i = 0; i < nSamples; i++) out[i] = first + i;
    return out;
  }
  const nominalNs = (frame.nominalPs || 0) / 1000;
  if (mode === "calibrated" && frame.widths && frame.widths[ch]) {
    const w = frame.widths[ch];
    const cell = (frame.triggerCell && frame.triggerCell[ch]) || 0;
    let t = 0;
    for (let i = 0; i < nSamples; i++) {
      out[i] = t;
      t += w[(cell + i) % N_CELLS] * 1e9;
    }
    return out;
  }
  for (let i = 0; i < nSamples; i++) out[i] = i * nominalNs;
  return out;
}

function chanFirstBin(frame, ch) {
  for (const c of frame.channels) if (c.channel === ch) return c.firstBin;
  return 0;
}

/**
 * Reduce a trace to at most `columns` screen columns without losing spikes.
 *
 * NOT decimation by sampling. Taking every Nth point drops narrow features
 * entirely -- a single-sample spike between two kept samples simply vanishes,
 * and on a monitoring page that is the feature you were looking for. Instead
 * take the min and max of the samples falling in each pixel column and emit
 * both, which preserves the envelope exactly. (Stefan Ritt's Real Time 2020
 * talk measures 90 ms naive against 3 ms this way on 1.5 M points, with better
 * fidelity, and MIDAS's own history plots use it.)
 *
 * Returns {x, y} arrays, at most 2*columns long.
 */
function minMaxDecimate(xs, ys, columns) {
  const n = ys.length;
  if (!n) return { x: [], y: [] };
  if (n <= columns * 2) return { x: Array.from(xs), y: Array.from(ys) };

  const per = n / columns;
  const x = [], y = [];
  for (let c = 0; c < columns; c++) {
    const lo = Math.floor(c * per);
    const hi = Math.min(n, Math.floor((c + 1) * per));
    if (hi <= lo) continue;
    let mn = ys[lo], mx = ys[lo], mnI = lo, mxI = lo;
    for (let i = lo + 1; i < hi; i++) {
      if (ys[i] < mn) { mn = ys[i]; mnI = i; }
      if (ys[i] > mx) { mx = ys[i]; mxI = i; }
    }
    // Emit in sample order so the polyline does not zigzag backwards.
    if (mnI <= mxI) { x.push(xs[mnI], xs[mxI]); y.push(mn, mx); }
    else { x.push(xs[mxI], xs[mnI]); y.push(mx, mn); }
  }
  return { x: x, y: y };
}

const WDBanks = {
  DAQ_CLOCK_HZ, VOLTAGE_SCALE, N_CELLS, EVENT_IDS_WAVEFORM,
  channelIndex, decodeDRSV, decodeDRST, decodeWDEH, decodeEvent,
  bank, sampleTimes, minMaxDecimate,
};
root.WDBanks = WDBanks;
if (typeof module !== "undefined" && module.exports) module.exports = WDBanks;

})(typeof globalThis !== "undefined" ? globalThis : this);
