//
// dqm-adbanks.js -- SAMPIC AD00 / AT00 / AC00 bank decoding, in the browser.
//
// This is the browser half of mechanism B: mhttpd hands the page one raw event
// out of the shared buffer and the page decodes it here, with no analyzer in
// between. Nothing in this file talks to the network or touches the DOM.
//
// The layout is specified in docs/sampic-bank-layout.md and has a Python twin
// in src/mdqm/dqm/sampic.py.
// tests/generate_adbank_cases.py encodes cases on the Python side that
// tests/js/adbank.test.js decodes here, so a field that moves on one side fails
// on the other -- and tests/js/ad-event-fixture.json holds real bytes out of
// run 108 with the Python decode beside them.
//
// Three things this file is careful about, each of which produces a plot that
// draws and is wrong rather than an error:
//
//   * the samples are ALREADY VOLTS. The frontend's .bin source is int16 and
//     the converter divides by 1e4 on the way in. Scaling again gives a trace
//     four orders of magnitude out that still looks like a pulse.
//   * every hit carries all 64 slots whatever data_size says, and the tail is
//     zeros. Plotting the tail draws a cliff to 0 V that reads as a real edge.
//   * the sampling period is NOT in the bank. It lives in the SAMPIC .bin
//     header and does not survive into MIDAS, so a time axis has to be
//     configured (/DQM/Scope/Sample Period ns) rather than inferred.
//

(function (root) {
"use strict";

const AD_BANK = "AD00";
const AT_BANK = "AT00";
const AC_BANK = "AC00";
const AD_MAX_SAMPLES = 64;            // kMaxSamples in EventBankUnpacker.hh
const CHANNELS_PER_SAMPIC = 16;
const AD_HIT_BYTES = 344;             // 11*4 header + 64*4 waveform + 40 scalars
const AT_RECORD_BYTES = 56;
const AC_RECORD_BYTES = 32;

// Everything after nparents in AT00. Zero means "not reported": the .bin and
// .root repackagers leave these empty and only generated files fill them.
const AT_TELEMETRY_FIELDS = [
  "sp_prepare_us_sum", "sp_read_us_sum", "sp_decode_us_sum", "sp_total_us_sum",
  "sp_prepare_us_max", "sp_read_us_max", "sp_decode_us_max", "sp_total_us_max",
  "sp_acq_retry_max", "sp_acq_retry_sum",
];

//: The converter writes this into tot_value where the standalone .bin format
//: carries no time-over-threshold. A sentinel, not a measurement: a page that
//: plots it draws a spike at -1 ns.
const TOT_ABSENT = -1.0;

const HEADER_FIELDS = ["fe_board_index", "channel", "hit_number", "sampic_index",
                       "channel_index", "data_size", "inl_corrected", "adc_corrected",
                       "residual_pedestal_corrected", "cell_info",
                       "first_cell_physical_index"];

/**
 * One 344-byte AD record at `offset`.
 *
 * Little-endian throughout, and read field by field rather than through a typed
 * array over the buffer: an ArrayBuffer arriving from mjsonrpc has no alignment
 * guarantee, and a Float32Array view on an odd offset throws.
 */
function decodeHit(view, offset) {
  const hit = {};
  HEADER_FIELDS.forEach(function (name, i) {
    hit[name] = view.getInt32(offset + i * 4, true);
  });

  // Truncated to data_size, never the full 64.
  const n = Math.max(0, Math.min(hit.data_size, AD_MAX_SAMPLES));
  const wf = new Float32Array(n);
  const wfAt = offset + HEADER_FIELDS.length * 4;
  for (let i = 0; i < n; i++) wf[i] = view.getFloat32(wfAt + i * 4, true);
  hit.waveform = wf;

  let p = wfAt + AD_MAX_SAMPLES * 4;
  hit.raw_tot_value = view.getInt32(p, true); p += 4;
  hit.tot_value = view.getFloat32(p, true); p += 4;
  hit.amplitude = view.getFloat32(p, true); p += 4;
  hit.baseline = view.getFloat32(p, true); p += 4;
  hit.peak = view.getFloat32(p, true); p += 4;
  hit.time_index = view.getFloat32(p, true); p += 4;
  hit.time_instant = view.getFloat64(p, true); p += 8;
  hit.time_amplitude = view.getFloat32(p, true); p += 4;
  hit.first_cell_timestamp = view.getFloat64(p, true);

  hit.haveTot = hit.tot_value !== TOT_ABSENT;
  return hit;
}

/**
 * The AD00 payload: hits back to back, no count prefix.
 *
 * The hit count is the bank size over 344, so a size that is not a multiple of
 * it means this decoder and the frontend disagree about the layout. Throwing is
 * the whole point: reading a partial hit would produce a plausible waveform
 * from the wrong bytes, which is the failure the spec's blocker warned about
 * ("a silent field-order change gives a plot that draws and is wrong").
 */
function decodeAD(buffer) {
  const bytes = buffer.byteLength !== undefined ? buffer : new Uint8Array(buffer).buffer;
  if (bytes.byteLength % AD_HIT_BYTES) {
    throw new Error(
      `AD00 is ${bytes.byteLength} bytes, not a multiple of ${AD_HIT_BYTES}. `
      + "This decoder and the frontend disagree about the bank layout; see "
      + "docs/sampic-bank-layout.md.");
  }
  const view = new DataView(bytes);
  const hits = [];
  for (let off = 0; off < bytes.byteLength; off += AD_HIT_BYTES) {
    hits.push(decodeHit(view, off));
  }
  return hits;
}

/** The AT00 payload: exactly one 56-byte record. */
function decodeAT(buffer) {
  const bytes = buffer.byteLength !== undefined ? buffer : new Uint8Array(buffer).buffer;
  if (bytes.byteLength < AT_RECORD_BYTES) {
    throw new Error(`AT00 is ${bytes.byteLength} bytes, expected ${AT_RECORD_BYTES}`);
  }
  const view = new DataView(bytes);
  // A u64 of nanoseconds. Number is exact to 2^53 ns, which is 104 days of
  // uptime -- comfortably longer than a run, and reading it as a BigInt would
  // make every arithmetic site below have to know that.
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  const out = {
    timestamp_ns: hi * 4294967296 + lo,
    nhits: view.getUint32(8, true),
    nparents: view.getUint32(12, true),
  };
  // The ten telemetry words. Read by name rather than skipped: they are the
  // only per-chip readout timing there is, and they are zero in files whose
  // frontend does not report them.
  AT_TELEMETRY_FIELDS.forEach(function (name, i) {
    out[name] = view.getUint32(16 + 4 * i, true);
  });
  return out;
}

/**
 * The AC00 payload: exactly one 32-byte collector-timing record.
 *
 * Exact rather than "at least", mirroring the unpacker, which refuses any
 * other size instead of reading the first 32 bytes of something else.
 */
function decodeAC(buffer) {
  const bytes = buffer.byteLength !== undefined ? buffer : new Uint8Array(buffer).buffer;
  if (bytes.byteLength !== AC_RECORD_BYTES) {
    throw new Error(`AC00 is ${bytes.byteLength} bytes, expected ${AC_RECORD_BYTES}`);
  }
  const view = new DataView(bytes);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return {
    collector_timestamp_ns: hi * 4294967296 + lo,
    n_events: view.getUint32(8, true),
    total_hits: view.getUint32(12, true),
    wait_us: view.getUint32(16, true),
    group_build_us: view.getUint32(20, true),
    finalize_us: view.getUint32(24, true),
    total_us: view.getUint32(28, true),
  };
}

/**
 * Turn one decoded MIDAS event into the shape the Scope page draws.
 *
 * `banks` is {name: ArrayBuffer}, which is what bkToObj gives after
 * bm_receive_event. An event with no AD00 is not an error: the buffer carries
 * whatever every frontend in the experiment writes, and the page has to be able
 * to say "that was somebody else's event".
 */
function decodeEvent(banks, opts) {
  const o = opts || {};
  const adName = o.waveformBank || AD_BANK;
  const atName = o.hitTimeBank || AT_BANK;
  const acName = o.collectorBank || AC_BANK;

  const out = { hits: [], timing: null, collector: null, channels: [],
                haveAD: false, haveAT: false, haveAC: false };
  if (banks[adName]) {
    out.hits = decodeAD(banks[adName]);
    out.haveAD = true;
  }
  if (banks[atName]) {
    out.timing = decodeAT(banks[atName]);
    out.haveAT = true;
  }
  if (banks[acName]) {
    out.collector = decodeAC(banks[acName]);
    out.haveAC = true;
  }

  // Hits arrive in the order the frontend clustered them, which is time order
  // within an event rather than channel order. Sorting by channel is what makes
  // a per-channel panel layout stable between events -- otherwise the same
  // channel moves around the screen from one refresh to the next.
  out.channels = out.hits.map((h) => h.channel)
    .filter((c, i, a) => a.indexOf(c) === i)
    .sort((a, b) => a - b);
  return out;
}

/**
 * The bank payload as an ArrayBuffer, whatever shape bkToObj handed us.
 *
 * A TID_BYTE bank arrives as a typed array viewing a larger buffer at an
 * arbitrary offset, so passing `.buffer` straight through would decode whatever
 * was allocated before it. Slice to the view's own window.
 */
function bankBuffer(bank) {
  if (!bank) return null;
  const a = bank.array !== undefined ? bank.array : bank;
  if (a instanceof ArrayBuffer) return a;
  if (a && a.buffer instanceof ArrayBuffer) {
    return a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength);
  }
  return null;
}

/**
 * Decode one event as bkToObj() returns it, straight from bm_receive_event.
 *
 * Returns null for an event that is not ours -- a different event id, or no
 * waveform bank. The buffer carries whatever every frontend in the experiment
 * writes, so that is a normal outcome and not an error.
 */
function fromEvent(event, opts) {
  const o = opts || {};
  if (!event || !event.bank) return null;
  if (o.eventId !== undefined && o.eventId !== null && Number(o.eventId) >= 0
      && event.event_id !== Number(o.eventId)) {
    return null;
  }
  const banks = {};
  for (const b of event.bank) {
    const buffer = bankBuffer(b);
    if (buffer) banks[b.name] = buffer;
  }
  const out = decodeEvent(banks, o);
  if (!out.haveAD) return null;
  out.serial = event.serial_number;
  out.eventId = event.event_id;
  out.timeStamp = event.time_stamp;
  out.bankNames = Object.keys(banks).sort();
  return out;
}

/** Sample times in ns for one hit, relative to its own first cell. */
function sampleTimes(hit, samplePeriodNs) {
  const dt = Number(samplePeriodNs) || 0;
  const n = hit.waveform.length;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = i * dt;
  return t;
}

/**
 * Reduce a trace to at most `columns` screen columns without losing spikes.
 *
 * NOT decimation by sampling. Taking every Nth point drops narrow features
 * entirely -- a single-sample spike between two kept samples simply vanishes,
 * and on a monitoring page that is the feature you were looking for. Instead
 * take the min and max of the samples falling in each pixel column and emit
 * both, which preserves the envelope exactly.
 *
 * At 64 samples a SAMPIC hit never needs this, and the function returns the
 * trace untouched. It is here for the day a longer waveform format arrives,
 * and because the alternative is discovering the need for it at 3am.
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

const ADBanks = { AD_BANK, AT_BANK, AC_BANK, AD_HIT_BYTES, AD_MAX_SAMPLES,
                  AT_RECORD_BYTES, AC_RECORD_BYTES, AT_TELEMETRY_FIELDS,
                  CHANNELS_PER_SAMPIC, TOT_ABSENT, HEADER_FIELDS,
                  decodeAD, decodeAT, decodeAC, decodeHit, decodeEvent, fromEvent,
                  bankBuffer, sampleTimes, minMaxDecimate };
root.ADBanks = ADBanks;
if (typeof module !== "undefined" && module.exports) module.exports = ADBanks;

})(typeof globalThis !== "undefined" ? globalThis : this);
