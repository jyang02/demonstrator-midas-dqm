//
// The JavaScript decoder must agree with the Python reference, sample for sample.
//
// dqm-wdbanks.js is a port of wdscalers/wdunpack.py, and a port that silently
// drifts from its reference is worse than no port: both sides look plausible and
// only disagree about the data. The fixture holds two real events from run00201
// -- the run's first, carrying the full 73,944-byte DRS width table, and a later
// one carrying the 192-byte header-only DRST -- with the Python decode beside
// the raw bank bytes.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WD = require(path.join(__dirname, "..", "..", "pages", "js", "dqm-wdbanks.js"));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "event-fixture.json"), "utf8"));

/** Rebuild what bkToObj() would hand us from the recorded bank bytes. */
function asEvent(rec) {
  const banks = Object.entries(rec.banks_b64).map(([name, b64]) => {
    const buf = Buffer.from(b64, "base64");
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return {
      name: name,
      size: bytes.byteLength,
      // WDEH is TID_UINT32 and arrives as a Uint32Array; the rest are TID_BYTE.
      array: name === "WDEH"
        ? new Uint32Array(bytes.slice().buffer)
        : bytes,
    };
  });
  return { event_id: rec.event_id, serial_number: rec.serial, bank: banks };
}

const FIRST = FX.events[0];
const LATER = FX.events[1];

test("the fixture is the pair it claims to be", () => {
  assert.strictEqual(Buffer.from(FIRST.banks_b64.DRST, "base64").length, 73944,
    "the first event must carry the full width table");
  assert.strictEqual(Buffer.from(LATER.banks_b64.DRST, "base64").length, 192,
    "every later event carries a header-only DRST");
});

for (const rec of FX.events) {
  test(`DRSV decodes identically to Python (${rec.note})`, () => {
    const got = WD.decodeDRSV(asEvent(rec).bank.find((b) => b.name === "DRSV").array);
    const want = rec.python;

    assert.deepStrictEqual(got.channels.map((c) => c.channel), want.channels,
      "channel set or ordering differs");

    for (const c of got.channels) {
      const key = String(c.channel);
      assert.strictEqual(c.decoded, want.decoded[key], `channel ${key} decoded flag`);
      assert.strictEqual(c.firstBin, want.first_bin[key], `channel ${key} first bin`);
      assert.strictEqual(c.volts ? c.volts.length : 0, want.n_samples[key],
        `channel ${key} sample count`);

      if (!c.decoded) continue;
      const head = want.samples_head[key];
      for (let i = 0; i < head.length; i++) {
        // Python rounds to 1e-6 for the fixture; the encoding is int16/1e4, so
        // anything looser than this would hide a real scale error.
        assert.ok(Math.abs(c.volts[i] - head[i]) < 1e-6,
          `channel ${key} sample ${i}: js ${c.volts[i]} vs py ${head[i]}`);
      }
    }
    assert.ok(Math.abs(got.temperatureC - want.temperature_c) < 1e-9, "temperature");
  });

  test(`DRST decodes identically to Python (${rec.note})`, () => {
    const got = WD.decodeDRST(asEvent(rec).bank.find((b) => b.name === "DRST").array);
    const want = rec.python;

    for (const [ch, cell] of Object.entries(want.trigger_cell)) {
      assert.strictEqual(got.triggerCell[ch], cell, `channel ${ch} trigger cell`);
    }
    // nominal_width_s is seconds in Python, picoseconds on the wire.
    assert.ok(Math.abs(got.nominalPs * 1e-12 - want.nominal_width_s) < 1e-15,
      `nominal width: js ${got.nominalPs} ps vs py ${want.nominal_width_s} s`);

    // What THIS bank carried, which is the question decodeDRST answers.
    // decode_event additionally carries a table forward from an earlier event;
    // that is `event_has_widths` and is tested separately below.
    const haveWidths = Object.keys(got.widths).length > 0;
    assert.strictEqual(haveWidths, want.bank_has_widths,
      "presence of the cell-width table in this bank must match");

    assert.deepStrictEqual(Object.keys(got.widths).map(Number).sort((a, b) => a - b),
      want.bank_width_channels, "which channels carried a table");

    for (const [ch, head] of Object.entries(want.bank_widths_head || {})) {
      assert.strictEqual(got.widths[ch].length, WD.N_CELLS);
      for (let i = 0; i < head.length; i++) {
        assert.ok(Math.abs(got.widths[ch][i] - head[i]) < 1e-12,
          `channel ${ch} cell ${i}: js ${got.widths[ch][i]} vs py ${head[i]}`);
      }
    }
  });

  test(`WDEH decodes identically to Python (${rec.note})`, () => {
    const boards = WD.decodeWDEH(asEvent(rec).bank.find((b) => b.name === "WDEH").array);
    assert.ok(boards.length >= 1);
    assert.strictEqual(boards[0].boardId, rec.python.board.board_id);
    assert.strictEqual(boards[0].eventNumber, rec.python.board.event_number);
    assert.strictEqual(boards[0].timestampTicks, rec.python.board.timestamp_ticks,
      "the 64-bit timestamp must survive the two-word join");
  });
}

test("channelIndex inverts the frontend's packing, clock channels included", () => {
  // chip*8 + chanOnChip for the sixteen inputs...
  assert.strictEqual(WD.channelIndex(0x00), 0);
  assert.strictEqual(WD.channelIndex(0x07), 7);
  assert.strictEqual(WD.channelIndex(0x10), 8);
  assert.strictEqual(WD.channelIndex(0x17), 15);
  // ...and chan-on-chip 8 means one of the two DRS clock channels.
  assert.strictEqual(WD.channelIndex(0x08), 16);
  assert.strictEqual(WD.channelIndex(0x18), 17);
});

test("decodeEvent carries the width table forward from the run's first event", () => {
  const first = WD.decodeEvent(asEvent(FIRST), null);
  assert.ok(first.widths && Object.keys(first.widths).length > 0);
  assert.strictEqual(first.widthsAreCached, false);

  // A page that attaches mid-run has no table and must say so rather than
  // silently drawing a wrong time axis.
  const cold = WD.decodeEvent(asEvent(LATER), null);
  assert.strictEqual(cold.widths, null);
  assert.strictEqual(cold.widthsAreCached, false);

  // Given the run's table, a later event uses it -- and is flagged as cached.
  const warm = WD.decodeEvent(asEvent(LATER), first.widths);
  assert.strictEqual(warm.widths, first.widths);
  assert.strictEqual(warm.widthsAreCached, true);
});

test("decodeEvent ignores events that are not waveforms", () => {
  const ev = asEvent(LATER);
  ev.event_id = 410;                       // scalers
  assert.strictEqual(WD.decodeEvent(ev, null), null);
});

test("sample times: three modes, and uniform works without a table", () => {
  const warm = WD.decodeEvent(asEvent(FIRST), null);
  const n = 1024;

  const bins = WD.sampleTimes(warm, 0, "bin", n);
  assert.strictEqual(bins[1] - bins[0], 1, "bin mode counts samples");

  const uni = WD.sampleTimes(warm, 0, "uniform", n);
  const step = (warm.nominalPs / 1000);
  assert.ok(Math.abs((uni[1] - uni[0]) - step) < 1e-9, "uniform uses the nominal width");
  assert.ok(uni[n - 1] > uni[0], "monotonic");

  const cal = WD.sampleTimes(warm, 0, "calibrated", n);
  assert.ok(cal[n - 1] > cal[0], "monotonic");
  for (let i = 1; i < n; i++) assert.ok(cal[i] > cal[i - 1], `not monotonic at ${i}`);

  // Uniform must still work with no width table at all -- nominalPs is on every
  // event, which is the whole reason it is the default.
  const cold = WD.decodeEvent(asEvent(LATER), null);
  const coldUni = WD.sampleTimes(cold, 0, "uniform", n);
  assert.ok(coldUni[n - 1] > 0);
  // ...and calibrated must fall back rather than throw or produce zeros.
  const coldCal = WD.sampleTimes(cold, 0, "calibrated", n);
  assert.deepStrictEqual(Array.from(coldCal), Array.from(coldUni));
});

test("min/max decimation keeps a one-sample spike that sampling would drop", () => {
  const n = 4096;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = i; ys[i] = 0; }
  ys[1234] = -0.9;                          // a single-sample pulse

  const out = WD.minMaxDecimate(xs, ys, 200);
  assert.ok(out.y.length <= 400);
  assert.ok(Math.min(...out.y) <= -0.9 + 1e-9,
    "the spike is the feature you were looking for; decimation must not lose it");

  // What plain sampling would have done, for contrast.
  const sampled = [];
  for (let i = 0; i < n; i += Math.floor(n / 200)) sampled.push(ys[i]);
  assert.ok(Math.min(...sampled) > -0.9, "sanity: sampling really does drop it");
});

test("decimation preserves the envelope and stays in sample order", () => {
  const n = 3000;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = i * 0.2; ys[i] = Math.sin(i / 40); }
  const out = WD.minMaxDecimate(xs, ys, 150);

  assert.ok(Math.abs(Math.max(...out.y) - 1) < 0.01, "peak preserved");
  assert.ok(Math.abs(Math.min(...out.y) + 1) < 0.01, "trough preserved");
  for (let i = 1; i < out.x.length; i++) {
    assert.ok(out.x[i] >= out.x[i - 1], `x went backwards at ${i}`);
  }
});

test("a short trace is passed through untouched", () => {
  const xs = [0, 1, 2, 3], ys = [0, 1, 0, -1];
  const out = WD.minMaxDecimate(xs, ys, 100);
  assert.deepStrictEqual(out.y, ys);
});
