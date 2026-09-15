//
// The AD00/AT00/AC00 browser decoder, against bytes it did not write.
//
// Two sources, deliberately:
//   adbank-cases.json     encoded by mdqm.dqm.sampic, regenerated every Python
//                         run, so the two implementations cannot drift;
//   ad-event-fixture.json real events out of run 108, so "the layout is right"
//                         is not a claim this repo checks only against itself;
//   demonstrator-event-fixture.json
//                         real events out of a demonstrator file: four FE
//                         boards, AC00 present, AT00 telemetry filled. Run 108
//                         is single-board with neither, so it cannot reach any
//                         of that.
//
// The failure this file exists to catch is the one the spec's own blocker names:
// "a silent field-order change gives a plot that draws and is wrong". Every
// assertion here is about a specific field landing at a specific offset.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const AD = require(path.join(__dirname, "..", "..", "pages", "js", "dqm-adbanks.js"));

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "adbank-cases.json"), "utf8"));
const REAL = JSON.parse(fs.readFileSync(path.join(__dirname, "ad-event-fixture.json"), "utf8"));
const DEMO = JSON.parse(
  fs.readFileSync(path.join(__dirname, "demonstrator-event-fixture.json"), "utf8"));

function buf(b64) {
  const bytes = Buffer.from(b64, "base64");
  // Copy into a fresh ArrayBuffer: Buffer views a shared pool at an arbitrary
  // offset, and passing its .buffer straight through would decode whatever
  // happened to be allocated before it.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const close = (a, b, eps = 1e-5) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b} (within ${eps})`);

// --- the constants both sides agree on --------------------------------------

test("the record sizes match the Python layout", () => {
  assert.strictEqual(AD.AD_HIT_BYTES, CASES.ad_hit_bytes);
  assert.strictEqual(AD.AD_MAX_SAMPLES, CASES.ad_max_samples);
  assert.strictEqual(AD.AT_RECORD_BYTES, CASES.at_record_bytes);
  assert.strictEqual(AD.TOT_ABSENT, CASES.tot_absent);
});

// --- the generated cases ----------------------------------------------------

for (const c of CASES.cases) {
  test(`decodes: ${c.name}`, () => {
    const hits = AD.decodeAD(buf(c.payload_b64));
    assert.strictEqual(hits.length, c.hits.length);

    hits.forEach(function (got, i) {
      const want = c.hits[i];
      for (const field of AD.HEADER_FIELDS) {
        assert.strictEqual(got[field], want[field], `${c.name}: ${field}`);
      }
      close(got.baseline, want.baseline);
      close(got.amplitude, want.amplitude);
      close(got.peak, want.peak);
      close(got.tot_value, want.tot_value);
      close(got.time_index, want.time_index);
      close(got.time_amplitude, want.time_amplitude);
      // f64, so it survives full precision where the f32 fields do not.
      close(got.first_cell_timestamp, want.first_cell_timestamp, 1e-9);
      close(got.time_instant, want.time_instant, 1e-9);
      assert.strictEqual(got.raw_tot_value, want.raw_tot_value);

      // The waveform is truncated to data_size, never the full 64: the tail is
      // zero padding and a plot including it shows a cliff to 0 V that reads as
      // a real edge.
      assert.strictEqual(got.waveform.length, want.waveform.length);
      assert.strictEqual(got.waveform.length, got.data_size);
      want.waveform.forEach((v, j) => close(got.waveform[j], v));
    });
  });
}

test("the AT00 record decodes, including a timestamp past 2^32", () => {
  CASES.timing.forEach(function (t) {
    const got = AD.decodeAT(buf(t.payload_b64));
    assert.strictEqual(got.timestamp_ns, t.decoded.timestamp_ns);
    assert.strictEqual(got.nhits, t.decoded.nhits);
    assert.strictEqual(got.nparents, t.decoded.nparents);
  });
  // The case that matters: a u64 read as two u32s the wrong way round is off by
  // 10^12 ns and still plots.
  const big = CASES.timing.find((t) => t.decoded.timestamp_ns > 4294967295);
  assert.ok(big, "no case exercises the high word");
});

test("the AT00 telemetry decodes field by field, in order", () => {
  const fields = CASES.at_telemetry_fields;
  assert.deepStrictEqual(fields, AD.AT_TELEMETRY_FIELDS,
    "the telemetry field order disagrees between Python and JavaScript");
  CASES.timing.forEach(function (t) {
    const got = AD.decodeAT(buf(t.payload_b64));
    fields.forEach(function (name) {
      assert.strictEqual(got[name], t.decoded[name], name);
    });
  });
  // Distinct values in one record: a decoder reading them in the wrong order
  // would still match a record of all zeros.
  const filled = CASES.timing.find((t) => t.decoded.sp_prepare_us_sum !== 0);
  assert.ok(filled, "no case fills the telemetry");
  // And one at 2^32-1: read as int32 that is -1.
  const wide = CASES.timing.find((t) => t.decoded.sp_total_us_sum === 4294967295);
  assert.ok(wide, "no case exercises the top of the u32 range");
  assert.strictEqual(AD.decodeAT(buf(wide.payload_b64)).sp_total_us_sum, 4294967295);
});

test("global_channel separates boards that share a board-local channel", () => {
  const c = CASES.cases.find((x) => x.name === "two boards, same board-local channel");
  assert.ok(c, "no multi-board case in the fixture");

  const hits = AD.decodeAD(buf(c.payload_b64));
  hits.forEach(function (got, i) {
    assert.strictEqual(got.global_channel, c.hits[i].global_channel,
      "Python and JavaScript disagree about the global index");
  });
  // Both hits say channel 5; only the global index tells them apart.
  assert.strictEqual(hits[0].channel, hits[1].channel);
  assert.notStrictEqual(hits[0].global_channel, hits[1].global_channel);

  // And the event's channel list keeps them separate, which is what decides
  // how many panels the Scope page draws.
  const ev = AD.decodeEvent({ [AD.AD_BANK]: buf(c.payload_b64) }, {});
  assert.deepStrictEqual(ev.channels, [5, 197]);
});

test("global_channel is the channel number on a single-board recording", () => {
  for (const ev of REAL.events) {
    const banks = {};
    for (const [name, b64] of Object.entries(ev.banks_b64)) banks[name] = buf(b64);
    AD.decodeEvent(banks, {}).hits.forEach(function (h) {
      assert.strictEqual(h.fe_board_index, 0, "the fixture is single-board");
      assert.strictEqual(h.global_channel, h.channel);
    });
  }
});

test("the AC00 collector record decodes", () => {
  assert.strictEqual(AD.AC_RECORD_BYTES, CASES.ac_record_bytes);
  CASES.collector.forEach(function (c) {
    const got = AD.decodeAC(buf(c.payload_b64));
    Object.keys(c.decoded).forEach(function (name) {
      assert.strictEqual(got[name], c.decoded[name], name);
    });
  });
  const big = CASES.collector.find((c) => c.decoded.collector_timestamp_ns > 4294967295);
  assert.ok(big, "no case exercises the high word");
});

// --- the layout disagreement, refused rather than half-read -----------------

test("a payload that is not a whole number of hits throws", () => {
  const short = new ArrayBuffer(AD.AD_HIT_BYTES + 17);
  assert.throws(() => AD.decodeAD(short), /disagree about the bank layout/);
});

test("a truncated AT00 throws rather than reading zeros", () => {
  assert.throws(() => AD.decodeAT(new ArrayBuffer(12)), /expected 56/);
});

test("an AC00 of the wrong size throws rather than reading a prefix", () => {
  assert.throws(() => AD.decodeAC(new ArrayBuffer(12)), /expected 32/);
  // Exact, not "at least": 40 bytes is a different record, not a long one.
  assert.throws(() => AD.decodeAC(new ArrayBuffer(40)), /expected 32/);
});

// --- real bytes -------------------------------------------------------------

for (const ev of REAL.events) {
  test(`real event ${ev.serial}: ${ev.decoded.nhits} hits on channels ${ev.decoded.channels}`, () => {
    const banks = {};
    for (const [name, b64] of Object.entries(ev.banks_b64)) banks[name] = buf(b64);

    const out = AD.decodeEvent(banks, {});
    assert.ok(out.haveAD && out.haveAT);
    assert.strictEqual(out.hits.length, ev.decoded.nhits);
    assert.deepStrictEqual(out.channels, ev.decoded.channels);

    // AT00 says how many hits the frontend clustered; AD00 is how many it
    // wrote. They disagreeing is a real fault, and the page reports it.
    assert.strictEqual(out.timing.nhits, ev.decoded.timing.nhits);
    assert.strictEqual(out.timing.timestamp_ns, ev.decoded.timing.timestamp_ns);

    out.hits.forEach(function (got, i) {
      const want = ev.decoded.hits[i];
      assert.strictEqual(got.channel, want.channel);
      assert.strictEqual(got.sampic_index, want.sampic_index);
      assert.strictEqual(got.channel_index, want.channel_index);
      assert.strictEqual(got.data_size, want.data_size);
      assert.strictEqual(got.waveform.length, want.waveform_len);
      close(got.baseline, want.baseline);
      close(got.amplitude, want.amplitude);
      close(got.peak, want.peak);
      close(got.first_cell_timestamp, want.first_cell_timestamp, 1e-9);
      want.waveform_head.forEach((v, j) => close(got.waveform[j], v));
    });
  });
}

test("the real pulses are negative-going, and the samples are already volts", () => {
  const ev = REAL.events[0];
  const banks = {};
  for (const [name, b64] of Object.entries(ev.banks_b64)) banks[name] = buf(b64);
  const hits = AD.decodeEvent(banks, {}).hits;

  for (const h of hits) {
    // If anything scaled these by 1e4 the plot would still look like a pulse,
    // four orders of magnitude out. A SAMPIC baseline sits near 0.74 V.
    assert.ok(h.baseline > 0.1 && h.baseline < 2.0, `baseline ${h.baseline} is not volts`);
    for (const v of h.waveform) assert.ok(Math.abs(v) < 5.0, `sample ${v} is not volts`);
    assert.ok(h.amplitude < 0, "this detector's pulses go down");
    close(h.peak, h.baseline + h.amplitude, 1e-3);
    // tot_value is the -1 sentinel in this converter's output, not a duration.
    assert.strictEqual(h.haveTot, false);
  }
});

// --- the helpers a page needs ------------------------------------------------

test("sample times come from the configured period, not from the bank", () => {
  const ev = REAL.events[0];
  const banks = { AD00: buf(ev.banks_b64.AD00) };
  const hit = AD.decodeEvent(banks, {}).hits[0];

  const t = AD.sampleTimes(hit, 0.15625);          // 6400 MS/s
  assert.strictEqual(t.length, hit.waveform.length);
  close(t[0], 0);
  close(t[1], 0.15625);
  close(t[63], 63 * 0.15625);
  // Nothing in the bank carries the period, so an unconfigured page gets a flat
  // axis rather than a wrong one.
  assert.deepStrictEqual(Array.from(AD.sampleTimes(hit, 0)).slice(0, 3), [0, 0, 0]);
});

test("minMaxDecimate leaves a 64-sample hit alone but keeps a spike in a long one", () => {
  const xs = Array.from({ length: 64 }, (_, i) => i);
  const ys = xs.map(() => 0.74);
  const same = AD.minMaxDecimate(xs, ys, 100);
  assert.strictEqual(same.y.length, 64, "a SAMPIC hit never needs reducing");

  const longX = Array.from({ length: 4000 }, (_, i) => i);
  const longY = longX.map(() => 0.0);
  longY[1234] = -0.9;                              // one-sample spike
  const cut = AD.minMaxDecimate(longX, longY, 100);
  assert.ok(cut.y.length <= 200);
  assert.ok(cut.y.some((v) => v === -0.9), "decimation dropped the spike");
});

test("an event from another frontend is not an error", () => {
  // The buffer carries whatever every frontend in the experiment writes, so the
  // page has to be able to say "that was somebody else's event".
  const out = AD.decodeEvent({ WDEH: new ArrayBuffer(8) }, {});
  assert.strictEqual(out.haveAD, false);
  assert.strictEqual(out.haveAT, false);
  assert.deepStrictEqual(out.hits, []);
  assert.deepStrictEqual(out.channels, []);
});

test("the bank names are configurable, since only the default is confirmed", () => {
  const ev = REAL.events[0];
  const out = AD.decodeEvent({ XX00: buf(ev.banks_b64.AD00) }, { waveformBank: "XX00" });
  assert.strictEqual(out.haveAD, true);
  assert.strictEqual(out.hits.length, ev.decoded.nhits);
});


// --- real demonstrator bytes: four boards, AC00, filled telemetry ------------

for (const ev of DEMO.events) {
  const d = ev.decoded;
  test(`demonstrator event ${ev.serial}: ${d.nhits} hits across boards ${d.boards}`, () => {
    const banks = {};
    for (const [name, b64] of Object.entries(ev.banks_b64)) banks[name] = buf(b64);

    const out = AD.decodeEvent(banks, {});
    assert.ok(out.haveAD && out.haveAT && out.haveAC, "a bank did not decode");
    assert.strictEqual(out.hits.length, d.nhits);

    // The whole point of this fixture: more than one board in one event, which
    // `channel` alone cannot represent.
    assert.ok(d.boards.length > 1, "fixture event does not span boards");
    assert.deepStrictEqual(out.channels, d.channels);
    assert.deepStrictEqual(
      Array.from(new Set(out.hits.map((h) => h.fe_board_index))).sort((a, b) => a - b),
      d.boards);
    out.hits.forEach(function (h, i) {
      assert.strictEqual(h.global_channel, d.hits[i].global_channel);
    });

    // The invariant a mismatched event would break.
    assert.strictEqual(out.collector.total_hits, out.hits.length);
    assert.strictEqual(out.timing.nhits, out.hits.length);
    assert.strictEqual(out.collector.total_us,
      out.collector.wait_us + out.collector.group_build_us + out.collector.finalize_us);

    // Telemetry is filled here, where run 108 has it all zero.
    assert.ok(out.timing.sp_total_us_sum > 0, "telemetry is zero in a generated file");
    assert.strictEqual(out.timing.sp_total_us_sum, d.timing.sp_total_us_sum);
    assert.ok(out.timing.sp_total_us_max <= out.timing.sp_total_us_sum);

    // And the waveforms are still volts, negative-going, 64 slots.
    out.hits.forEach(function (h) {
      assert.strictEqual(h.waveform.length, 64);
      assert.ok(h.amplitude < 0, "demonstrator pulses are negative-going");
      assert.strictEqual(h.tot_value, AD.TOT_ABSENT);
      h.waveform.forEach((v) => assert.ok(v > -0.2 && v < 1.1, `${v} is not volts`));
    });
  });
}
