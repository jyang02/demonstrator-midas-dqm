//
// Pure-function tests for dqm-common.js, run with `node --test`.
//
// Fixtures in fixtures.json were captured verbatim from a live ODB, because
// every bug this file exists to catch is a bug about the shape MIDAS actually
// returns rather than the shape one would assume.
//
// Skipped automatically where node is unavailable; see tests/test_js.py.
//

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const DQM = require(path.join(__dirname, "..", "..", "pages", "js", "dqm-common.js"));
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
const CFG = DQM.DEFAULTS;

test("asArray copes with a one-element array reading back as a scalar", () => {
  // X036 is a bare float and "Names X036" a bare string: a MIDAS array of
  // length one is indistinguishable from a scalar in the JSON encoding.
  assert.deepStrictEqual(DQM.asArray(59.4375, 1), [59.4375]);
  assert.deepStrictEqual(DQM.asArray("fpga_temp_c", 1), ["fpga_temp_c"]);
  assert.deepStrictEqual(DQM.asArray([1, 2], 2), [1, 2]);
  assert.deepStrictEqual(DQM.asArray(undefined, 2), []);
  assert.deepStrictEqual(DQM.asArray(null), []);
  // Short arrays are padded so a .map() over numValues never reads undefined.
  assert.deepStrictEqual(DQM.asArray([1], 3), [1, null, null]);
});

test("asUInt decodes the hex strings TID_DWORD arrives as", () => {
  assert.strictEqual(DQM.asUInt("0x90c1849e"), 0x90c1849e);
  assert.strictEqual(DQM.asUInt("0x00000000"), 0);
  assert.strictEqual(DQM.asUInt(31), 31);
  assert.strictEqual(DQM.asUInt("31"), 31);
  // "010" must be ten, not eight: the radix is explicit for this reason.
  assert.strictEqual(DQM.asUInt("010"), 10);
  assert.strictEqual(DQM.asUInt(true), 1);
  assert.ok(Number.isNaN(DQM.asUInt("")));
  assert.ok(Number.isNaN(DQM.asUInt({})));
});

test("asUInt64 joins the two halves of a board timestamp", () => {
  const ts = FX.variables_ls.WDScalers["T036"];
  const ticks = DQM.asUInt64(ts[0], ts[1]);
  assert.ok(Number.isFinite(ticks));
  assert.ok(ticks > 0);
  // 80 MHz ticks: a plausible uptime, i.e. the halves are the right way round.
  const seconds = ticks / CFG["Ticks Per Second"];
  assert.ok(seconds > 60 && seconds < 3e7, `implausible uptime ${seconds}s`);
  assert.ok(Number.isNaN(DQM.asUInt64("nope", "0")));
});

test("parseBank splits role letter from board id, and rejects near-misses", () => {
  const p = CFG["Bank Pattern"];
  assert.deepStrictEqual(DQM.parseBank("S036", p), { bank: "S036", role: "S", board: "036" });
  assert.deepStrictEqual(DQM.parseBank("X999", p), { bank: "X999", role: "X", board: "999" });
  assert.strictEqual(DQM.parseBank("SSFE", p), null);   // not three digits
  assert.strictEqual(DQM.parseBank("HT00", p), null);   // wrong role letter
  assert.strictEqual(DQM.parseBank("S03", p), null);    // too short
  assert.strictEqual(DQM.parseBank("S0366", p), null);  // too long
});

test("groupBoards builds the board model from a real db_ls", () => {
  const boards = DQM.groupBoards(FX.variables_ls, CFG);
  assert.strictEqual(boards.length, 1);
  const b = boards[0];
  assert.strictEqual(b.equipment, "WDScalers");
  assert.strictEqual(b.board, "036");
  assert.deepStrictEqual(Object.keys(b.banks).sort(),
    ["rates", "temperature", "threshold", "timestamp"]);
  assert.strictEqual(b.banks.rates.numValues, 19);
  assert.strictEqual(b.banks.threshold.numValues, 16);
  // The scalar case: X036/key carries no num_values at all, so the default
  // of 1 has to come from groupBoards rather than from the ODB.
  assert.strictEqual(b.banks.temperature.numValues, 1);
});

test("groupBoards drops a board with no rates bank but keeps partial ones", () => {
  const onlyTemp = { Eq: { "X036": 20.0, "X036/key": { type: 9 } } };
  assert.deepStrictEqual(DQM.groupBoards(onlyTemp, CFG), []);

  const ratesOnly = { Eq: { "S007": [1, 2], "S007/key": { type: 7, num_values: 2 } } };
  const got = DQM.groupBoards(ratesOnly, CFG);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(Object.keys(got[0].banks), ["rates"]);
});

test("groupBoards handles several boards and several equipment", () => {
  const many = {
    B: { "S002": [0], "S002/key": { num_values: 1 } },
    A: { "S001": [0], "S001/key": { num_values: 1 },
         "S003": [0], "S003/key": { num_values: 1 } },
  };
  const got = DQM.groupBoards(many, CFG);
  assert.deepStrictEqual(got.map((b) => `${b.equipment}/${b.board}`),
    ["A/001", "A/003", "B/002"]);   // sorted, so panel order is stable
});

test("groupBoards ignores keys that are not banks", () => {
  const noisy = {
    Eq: {
      "S036": [0], "S036/key": { num_values: 19 },
      "Thread": {}, "Trigger Rate": 1.0, "Config busy": 0,
    },
  };
  const got = DQM.groupBoards(noisy, CFG);
  assert.strictEqual(got.length, 1);
  assert.deepStrictEqual(Object.keys(got[0].banks), ["rates"]);
});

test("bankLabels prefers Names, and never leaves a channel unlabelled", () => {
  const names = FX.settings_ls.WDScalers["Names S036"];
  const labels = DQM.bankLabels("S036", names, 19);
  assert.strictEqual(labels.length, 19);
  assert.strictEqual(labels[0], "ch00");
  assert.ok(labels.every((l) => l && l.length));

  // Missing, short and empty all fall back to bank[i] rather than to "".
  assert.deepStrictEqual(DQM.bankLabels("S036", null, 2), ["S036[0]", "S036[1]"]);
  assert.deepStrictEqual(DQM.bankLabels("S036", ["a"], 2), ["a", "S036[1]"]);
  assert.deepStrictEqual(DQM.bankLabels("S036", ["a", ""], 2), ["a", "S036[1]"]);
});

test("historyVarString prefers mlogger's tags over Settings/Names", () => {
  const tags = FX.hs_tags[0].tags.map((t) => t.name);
  const names = FX.settings_ls.WDScalers["Names S036"];
  const vars = DQM.historyVarString("WDScalers/S036", tags, names, 19);

  assert.strictEqual(vars[0], "WDScalers/S036:ch00");
  assert.strictEqual(vars.length, tags.length);
  assert.ok(vars.every((v) => v.startsWith("WDScalers/S036:")));
});

test("historyVarString falls back to Names, then to indices", () => {
  assert.deepStrictEqual(
    DQM.historyVarString("E/S036", null, ["a", "b"], 2), ["E/S036:a", "E/S036:b"]);
  assert.deepStrictEqual(
    DQM.historyVarString("E/S036", [], null, 2), ["E/S036:0", "E/S036:1"]);
  // A blank label would produce "EVT:" and make MhistoryGraph ask for a tag
  // that cannot exist, so blanks are dropped rather than passed through.
  assert.deepStrictEqual(
    DQM.historyVarString("E/S036", ["a", "", null], null, 3), ["E/S036:a"]);
});

test("the history events in the fixture match the discovered banks", () => {
  const boards = DQM.groupBoards(FX.variables_ls, CFG);
  const wanted = Object.keys(boards[0].banks)
    .map((role) => `${boards[0].equipment}/${boards[0].banks[role].name}`);
  for (const name of wanted) {
    assert.ok(FX.hs_events.includes(name), `${name} is recorded but was not matched`);
  }
});
