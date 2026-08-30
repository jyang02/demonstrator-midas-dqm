"""Defaults for the page config subtree at ``/DQM/Scalars``.

Every one of these is a *default*, not a requirement. With the subtree absent
the page uses exactly these values from its own built-in copy and says so in a
note, which is what lets it work on a bare experiment the first time anyone
opens it. Seeding them into the ODB only makes them editable without touching
a file.

Keep this in step with ``DEFAULTS`` in ``pages/js/dqm-common.js`` -- the JS copy
is the one that runs when the subtree is missing. ``tests/test_manifest.py``
asserts the two agree.
"""

from __future__ import annotations

# Note on types: these are written through midas.client.odb_set, which maps
# python str -> TID_STRING, int -> TID_INT, float -> TID_DOUBLE, list[str] ->
# a string array. Keep an int an int; a float default that should be editable
# as a float must be written as a float.
DEFAULTS: dict[str, object] = {
    # --- discovery -------------------------------------------------------
    # Empty means "scan every equipment". Naming some is faster and stops the
    # page describing equipment nobody wants on it.
    "Equipment": [""],
    # Capture 1 is the role letter, capture 2 the board id. This is the whole
    # contract between the page and the frontend's bank naming, and it lives
    # here rather than in code so another experiment is a config change.
    # Must stay in step with wdscalers/banks.py's scaler_bank_name() et al.
    "Bank Pattern": r"^([STXD])(\d{3})$",
    "Role Rates": "S",
    "Role Timestamp": "T",
    "Role Temperature": "X",
    "Role Threshold": "D",

    # --- interpretation --------------------------------------------------
    # Selected by *name*, not by index: a board with a different channel count
    # still works, where "index >= 16" would quietly mislabel it.
    "Trigger Scaler Names": ["ptrn_trg", "ext_trg"],
    "Clock Scaler Name": "ext_clk",
    "Ticks Per Second": 80e6,
    # The frontend writes -1 for a scaler that is masked out of the record.
    # Signed on purpose so it reads differently from a genuine 0 Hz.
    "Disabled Value": -1,

    # --- health ----------------------------------------------------------
    # How long the board timestamp may stand still before the page stops
    # claiming the numbers below it are current. Two poll periods plus slack.
    "Stale Seconds": 10.0,
    # 0 disables the colouring entirely, which is the right default: a warn
    # threshold invented by the page rather than by the operator is noise.
    "Rate Warn Hz": 0.0,
    "Rate Alarm Hz": 0.0,
    "Temp Warn C": 60.0,
    "Temp Alarm C": 70.0,

    # --- display ---------------------------------------------------------
    "History Timescale": "10m",
    # Extra per-equipment counter trees for the health panel. Every numeric
    # leaf under each of these is rendered.
    "Health Subtrees": ["Variables/Thread"],
    "Refresh ms": 1000,
}
