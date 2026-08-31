//
// The JavaScript scope-frame decoder against Python's encoder.
//
// A frame decoder that disagrees with its encoder does not fail, it *misdraws* --
// wrong channel, shifted samples, a phase attached to the wrong trace. That is
// the worst failure mode for a display people make decisions from, so the two
// halves are checked against each other rather than each against itself.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const PAGES = path.join(__dirname, "..", "..", "pages", "js");
globalThis.BRPC = require(path.join(PAGES, "dqm-brpc.js"));
const { decodeScopeFrame } = globalThis.BRPC;

const CASES = path.join(__dirname, "scopeframe-cases.json");

test("the generated cases exist", () => {
  assert.ok(fs.existsSync(CASES),
    "run the Python suite first; it generates tests/js/scopeframe-cases.json");
});

const cases = fs.existsSync(CASES)
  ? JSON.parse(fs.readFileSync(CASES, "utf8")).cases
  : [];

for (const c of cases) {
  test(`decodes Python's ${c.name}`, () => {
    const buf = Buffer.from(c.payload_b64, "base64");
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const f = decodeScopeFrame(ab);

    const m = c.meta;
    if (m.frame_seq !== undefined) assert.strictEqual(f.frameSeq, m.frame_seq);
    if (m.run_number !== undefined) assert.strictEqual(f.runNumber, m.run_number);
    if (m.event_number !== undefined) assert.strictEqual(f.eventNumber, m.event_number);
    if (m.board_id !== undefined) assert.strictEqual(f.boardId, m.board_id);
    if (m.timestamp_ticks !== undefined) {
      assert.strictEqual(f.timestampTicks, m.timestamp_ticks,
        "a 64-bit tick count must survive");
    }
    if (m.board_temp_c !== undefined) {
      assert.ok(Math.abs(f.boardTempC - m.board_temp_c) < 1e-4);
    }
    if (m.nominal_ps !== undefined) {
      assert.ok(Math.abs(f.nominalPs - m.nominal_ps) < 1e-3,
        "the uniform-ns axis depends on this");
    }
    assert.strictEqual(f.haveWidths, !!m.have_widths);
    assert.strictEqual(f.runActive, !!m.run_active);
    assert.strictEqual(f.widthsCached, !!m.widths_cached);

    assert.strictEqual(f.channels.length, c.channels.length);
    c.channels.forEach((want, i) => {
      const got = f.channels[i];
      assert.strictEqual(got.channel, want.channel, `channel ${i} id`);
      assert.strictEqual(got.firstBin, want.first_bin, `channel ${i} first bin`);
      assert.strictEqual(got.decoded, want.decoded, `channel ${i} decoded flag`);

      if (!want.decoded) {
        assert.strictEqual(got.volts, null);
        assert.strictEqual(got.encoding, want.encoding,
          "the encoding mode is why it could not be read, so it must survive");
        return;
      }
      assert.strictEqual(got.nSamples, want.n_samples, `channel ${i} sample count`);
      // The counts are what must match exactly; volts are counts * scale.
      for (let s = 0; s < want.samples.length; s++) {
        const counts = Math.round(got.volts[s] / got.scale);
        assert.strictEqual(counts, want.samples[s],
          `channel ${want.channel} sample ${s}: ${counts} vs ${want.samples[s]}`);
      }
    });

    assert.deepStrictEqual(Object.keys(f.derived).sort(),
      Object.keys(c.derived).sort(), "derived value names");
    for (const [k, v] of Object.entries(c.derived)) {
      assert.ok(Math.abs(f.derived[k] - v) < 1e-9, `derived ${k}`);
    }
  });
}

test("a frame with an unknown version is refused, not misread", () => {
  const buf = Buffer.from(cases[0].payload_b64, "base64");
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  new DataView(ab).setUint32(0, 99, true);
  assert.throws(() => decodeScopeFrame(ab), /unknown scope frame version/);
});

test("every case actually ran", () => {
  assert.ok(cases.length >= 3, `only ${cases.length} cases`);
});
