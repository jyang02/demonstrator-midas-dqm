//
// dqm-common.js -- discovery, ODB shape handling and small RPC wrappers.
//
// Generic: nothing in this file knows about any particular equipment, bank or
// channel. dqm-page.js and the page files build on it.
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
// This object is what runs when /DQM does not exist, which is the normal state
// of an experiment nobody has set up yet -- so every page works on first open
// and says it is using built-ins.
//
// One subtree per page, plus "Common" for what every page reads -- and there is
// one page, so tabs share its subtree. It is
// deliberately plain, strict JSON with no comments inside and no trailing
// commas: tests/test_manifest.py slices the literal out with a regex anchored
// on the closing `};` *at column 0* and json.loads() it, then asserts it agrees
// key-for-key with the Python copy in mdqm/install/config_defaults.py, which is
// what gets seeded into the ODB. Explanations for each key live in that file.
// A reformat that indents the closing brace breaks that test silently.
//
const DEFAULTS = {
  "Common": {
    "Analyzer Client": "mdqm_analyzer",
    "Refresh ms": 5000
  },
  "ATAR": {
    "Event Rate Hz": 1.0,
    "Event ID": 1,
    "Waveform Bank": "AD00",
    "Hit Time Bank": "AT00",
    "Collector Bank": "AC00",
    "Sample Period ns": 0.625,
    "Buffer": "SYSTEM",
    "Histograms": [
      "sampic/occupancy",
      "sampic/hits_per_event",
      "sampic/persistence",
      "sampic/amplitude_by_channel",
      "sampic/charge_vs_amplitude"
    ]
  }
};

const CONFIG_ROOT = "/DQM";

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
// Labels and history variables
// ---------------------------------------------------------------------------

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

/**
 * Read one ODB subtree over `want`, case-insensitively, into `cfg`.
 *
 * Returns whether the subtree was actually there. Never throws: a missing
 * config subtree is the expected state on a fresh experiment, not an error
 * worth interrupting anyone about.
 */
async function _merge(cfg, path, want) {
  try {
    const rpc = await mjsonrpc_db_get_values([path]);
    const got = rpc.result.data[0];
    if (!got || rpc.result.status[0] !== 1) return false;
    for (const key of Object.keys(want)) {
      // db_get_values lower-cases key names ("temperature path" for
      // "Temperature Path"); match case-insensitively and keep our canonical
      // spelling so the rest of the page can use one.
      for (const k of Object.keys(got)) {
        if (k.endsWith("/key")) continue;
        if (k.toLowerCase() === key.toLowerCase()) cfg[key] = got[k];
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Load one page's config, falling back to built-ins. Never throws.
 *
 * Two reads: /DQM for what every page shares, then /DQM/<page> for this page's
 * own. The page name is the canonical one from the spec, not the /Custom key --
 * with --prefix the key is "PIATAR" and the URL says page=PIATAR, but a
 * prefix is a menu-collision fix, not an experiment fork, so two prefixed
 * installations share one /DQM/ATAR and that is the right behaviour.
 */
async function loadConfig(page, rootOverride) {
  const base = rootOverride || CONFIG_ROOT;
  const common = DEFAULTS["Common"] || {};
  const own = DEFAULTS[page] || {};
  const cfg = Object.assign({}, common, own);
  cfg._page = page;
  cfg._seeded = await _merge(cfg, base, common);
  // A page that legitimately declares no config must not nag about a subtree
  // it never wanted.
  cfg._pageSeeded = Object.keys(own).length
    ? await _merge(cfg, `${base}/${page}`, own)
    : true;
  return cfg;
}


// ---------------------------------------------------------------------------
// Publish. `DQM` in a browser, module.exports under node --test.
// ---------------------------------------------------------------------------
const DQM = { CONFIG_ROOT, DEFAULTS, asArray, asUInt, asUInt64, bankLabels, getODB, historyVarString, loadConfig, lsODB, setODB };
root.DQM = DQM;
if (typeof module !== "undefined" && module.exports) module.exports = DQM;

})(typeof globalThis !== "undefined" ? globalThis : this);
