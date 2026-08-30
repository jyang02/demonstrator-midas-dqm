//
// dqm-common.js -- discovery, ODB shape handling and small RPC wrappers.
//
// Generic: nothing in this file knows about WaveDream, or about any particular
// equipment, bank or channel. The page-specific files build on it.
//
// Everything hangs off a single global `DQM`, the way every other MIDAS custom
// page does it -- no build step, no bundler, and the same `<script src>` loading
// the stock resources use. ES modules were the alternative and were rejected
// for one concrete reason: later stages load tab fragments through musip's
// self-deleting-iframe trick, which works precisely because fragments share the
// parent's global scope. Modules deliberately do not.
//
// The pure functions are also exported for `node --test`; the shim at the
// bottom is a no-op in a browser.
//

(function (root) {
"use strict";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
//
// This object is what runs when /DQM/Scalars does not exist, which is the
// normal state of an experiment nobody has set up yet -- so the page works on
// first open and says it is using built-ins.
//
// It is deliberately plain JSON with no comments inside: tests/test_manifest.py
// parses it and asserts it agrees key-for-key with the Python copy in
// mdqm/install/config_defaults.py, which is what gets seeded into the ODB.
// Explanations for each key live in that file.
//
const DEFAULTS = {
  "Equipment": [""],
  "Bank Pattern": "^([STXD])(\\d{3})$",
  "Role Rates": "S",
  "Role Timestamp": "T",
  "Role Temperature": "X",
  "Role Threshold": "D",
  "Trigger Scaler Names": ["ptrn_trg", "ext_trg"],
  "Clock Scaler Name": "ext_clk",
  "Ticks Per Second": 80e6,
  "Disabled Value": -1,
  "Stale Seconds": 10.0,
  "Rate Warn Hz": 0.0,
  "Rate Alarm Hz": 0.0,
  "Temp Warn C": 60.0,
  "Temp Alarm C": 70.0,
  "History Timescale": "10m",
  "Health Subtrees": ["Variables/Thread"],
  "Refresh ms": 1000
};

const CONFIG_ROOT = "/DQM/Scalars";

// ---------------------------------------------------------------------------
// ODB shape handling
// ---------------------------------------------------------------------------

/**
 * Coerce an ODB value to an array of length `n`.
 *
 * A MIDAS array of length one is indistinguishable from a scalar in the JSON
 * encoding, so `X036` arrives as a bare float and `Names X036` as a bare
 * string. `num_values` from db_ls is the authority, and it is *absent* rather
 * than 1 in that case -- hence the explicit default at every call site.
 *
 * Calling .map() or .length on a raw ODB value without going through here is a
 * latent crash that surfaces the day somebody configures a one-element bank.
 */
function asArray(v, n) {
  if (v === undefined || v === null) return [];
  const a = Array.isArray(v) ? v : [v];
  if (n && a.length < n) return a.concat(new Array(n - a.length).fill(null));
  return a;
}

/**
 * Coerce an ODB numeric to a JS number.
 *
 * TID_DWORD and TID_BOOL come back as hex *strings*: a timestamp bank reads
 * ["0x1dd3d038", "0x00000002", "0x00000000"]. Reaching for parseInt without a
 * radix would read "0x..." correctly by accident but "010" as octal in older
 * engines, so the radix is explicit.
 */
function asUInt(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (s === "") return NaN;
  return /^0[xX]/.test(s) ? parseInt(s, 16) : parseInt(s, 10);
}

/** Join the two halves of a 64-bit value split across two DWORDs. */
function asUInt64(lsb, msb) {
  const lo = asUInt(lsb), hi = asUInt(msb);
  if (Number.isNaN(lo) || Number.isNaN(hi)) return NaN;
  return hi * 4294967296 + lo;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Match one Variables key against the configured bank pattern.
 *
 * Returns {bank, role, board} or null. Capture 1 is the role letter, capture 2
 * the board id -- that pairing is the entire contract between this page and a
 * frontend's bank naming, and it lives in the ODB so another experiment is a
 * config change rather than a code change.
 */
function parseBank(name, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const m = re.exec(name);
  if (!m) return null;
  return { bank: name, role: m[1], board: m[2] };
}

/**
 * Turn a db_ls of several /Equipment/<eq>/Variables into a board model.
 *
 * `lsByEq` is {equipmentName: {key: value, "key/key": {num_values, type, ...}}},
 * i.e. exactly what mjsonrpc_db_ls returns. Boards with no rates bank are
 * dropped -- there is nothing to show for them -- but a board missing any of
 * the timestamp, temperature or threshold banks is kept, because those are
 * genuinely optional and the page degrades per-panel.
 */
function groupBoards(lsByEq, cfg) {
  const roleOf = {};
  roleOf[cfg["Role Rates"]] = "rates";
  roleOf[cfg["Role Timestamp"]] = "timestamp";
  roleOf[cfg["Role Temperature"]] = "temperature";
  roleOf[cfg["Role Threshold"]] = "threshold";

  const boards = [];
  for (const eq of Object.keys(lsByEq || {}).sort()) {
    const ls = lsByEq[eq] || {};
    const byBoard = {};
    for (const key of Object.keys(ls)) {
      if (key.endsWith("/key")) continue;
      const hit = parseBank(key, cfg["Bank Pattern"]);
      if (!hit) continue;
      const role = roleOf[hit.role];
      if (!role) continue;
      const meta = ls[key + "/key"] || {};
      (byBoard[hit.board] = byBoard[hit.board] || { equipment: eq, board: hit.board, banks: {} })
        .banks[role] = { name: key, numValues: meta.num_values || 1, type: meta.type };
    }
    for (const id of Object.keys(byBoard).sort()) {
      if (byBoard[id].banks.rates) boards.push(byBoard[id]);
    }
  }
  return boards;
}

/**
 * The `EVENT:TAG` strings MhistoryGraph wants for a bank.
 *
 * Prefer the tags mlogger actually recorded over Settings/Names: the on-disk
 * schema is what the history reader will match, and it can lag a channel
 * rename by one mlogger restart. Names is the fallback, and `bank[i]` the
 * fallback's fallback, so a graph always has *some* label.
 */
function historyVarString(event, tags, names, n) {
  let labels = (tags && tags.length) ? tags : asArray(names, n);
  if (!labels.length) {
    labels = [];
    for (let i = 0; i < (n || 0); i++) labels.push(String(i));
  }
  return labels.filter((t) => t !== null && t !== undefined && t !== "")
               .map((t) => `${event}:${t}`);
}

/**
 * Human labels for one bank, with the same three-step fallback.
 */
function bankLabels(bankName, names, n) {
  const out = [];
  const given = asArray(names, n);
  for (let i = 0; i < n; i++) {
    const v = given[i];
    out.push(v === null || v === undefined || v === "" ? `${bankName}[${i}]` : String(v));
  }
  return out;
}

// ---------------------------------------------------------------------------
// RPC wrappers
// ---------------------------------------------------------------------------
// Modelled on musip's quads.js:12-56, which is the cleanest small pair in that
// tree. Every failure goes through mjsonrpc_error_alert so a broken page says
// so rather than sitting silently stale.

async function getODB(paths) {
  if (!Array.isArray(paths)) {
    const rpc = await mjsonrpc_db_get_value(paths);
    return rpc.result.data[0];
  }
  const rpc = await mjsonrpc_db_get_values(paths);
  return rpc.result.data;
}

async function setODB(paths, values, errorText) {
  try {
    if (!Array.isArray(paths)) return await mjsonrpc_db_paste([paths], [values]);
    return await mjsonrpc_db_paste(paths, values);
  } catch (error) {
    mjsonrpc_error_alert(errorText || `Could not set ${paths}: ${error}`);
    return null;
  }
}

/**
 * db_ls several paths at once.
 *
 * Discovery uses db_ls throughout rather than db_get_values for two reasons:
 * db_get_values lower-cases key names ("names s036" for "Names S036"), and
 * db_ls is the only call that reports num_values, without which a one-element
 * array cannot be told from a scalar.
 */
async function lsODB(paths) {
  const rpc = await mjsonrpc_call("db_ls", { paths: paths });
  return rpc.result.data;
}

/** Load the page config, falling back to built-ins. Never throws. */
async function loadConfig(root) {
  const cfg = Object.assign({}, DEFAULTS);
  cfg._seeded = false;
  try {
    const rpc = await mjsonrpc_db_get_values([root || CONFIG_ROOT]);
    const got = rpc.result.data[0];
    if (got && rpc.result.status[0] === 1) {
      for (const key of Object.keys(DEFAULTS)) {
        // db_get_values lower-cases; match case-insensitively and keep our
        // canonical key so the rest of the page can use one spelling.
        for (const k of Object.keys(got)) {
          if (k.endsWith("/key")) continue;
          if (k.toLowerCase() === key.toLowerCase()) cfg[key] = got[k];
        }
      }
      cfg._seeded = true;
    }
  } catch (e) {
    // A missing config subtree is the expected state on a fresh experiment,
    // not an error worth interrupting anyone about.
  }
  return cfg;
}


// ---------------------------------------------------------------------------
// Publish. `DQM` in a browser, module.exports under node --test.
// ---------------------------------------------------------------------------
const DQM = { CONFIG_ROOT, DEFAULTS, asArray, asUInt, asUInt64, bankLabels, getODB, groupBoards, historyVarString, loadConfig, lsODB, parseBank, setODB };
root.DQM = DQM;
if (typeof module !== "undefined" && module.exports) module.exports = DQM;

})(typeof globalThis !== "undefined" ? globalThis : this);
