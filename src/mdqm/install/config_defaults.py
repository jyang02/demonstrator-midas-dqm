"""Defaults for the page config subtrees under ``/DQM``.

Every one of these is a *default*, not a requirement. With the subtree absent
the page uses exactly these values from its own built-in copy and says so in a
note, which is what lets it work on a bare experiment the first time anyone
opens it. Seeding them into the ODB only makes them editable without touching
a file -- which is the whole point here, because every ``/Equipment`` path
below is *proposed* rather than deployed: ``demonstrator-shifter-ui``'s
``docs/frontend_requirements.md`` says out loud that only the bank names and
the run-parameter key names are the collaboration's, and that equipment names,
paths and types want confirming against the build actually running at PSI.
Correcting one should be an ODB edit during a shift, not a patch.

One subtree per menu page, plus ``Common`` for what every page reads. A page
with an empty dict creates no subtree, which is correct: ``/DQM/Retired`` has
no configuration and should not appear.

Keep this in step with ``DEFAULTS`` in ``pages/js/dqm-common.js`` -- the JS copy
is the one that runs when the subtree is missing. ``tests/test_manifest.py``
asserts the two agree, root by root.
"""

from __future__ import annotations

# Note on types: these are written through midas.client.odb_set, which maps
# python str -> TID_STRING, int -> TID_INT, float -> TID_DOUBLE, list[str] ->
# a string array. Keep an int an int; a float default that should be editable
# as a float must be written as a float.
DEFAULTS: dict[str, dict[str, object]] = {
    # --- every page ------------------------------------------------------
    "Common": {
        # The client name the mechanism-C pages ask for accumulated
        # histograms. Nothing answers to it yet; those pages check rather
        # than assert, and say which name they tried.
        "Analyzer Client": "mdqm_analyzer",
        "Refresh ms": 1000,
    },

    # --- Rates: ODB and history, needs only a frontend -------------------
    "Rates": {
        # Empty means "every equipment". Naming some is faster and stops the
        # page describing equipment nobody wants on it.
        "Rate Equipment": [""],
        # The four keys the trigger-settings panel reads. None of them exists
        # yet: there is no fetrigger and no fesampic. The panel renders a row
        # per key either way, so a partial deployment is visible rather than
        # silently half-right.
        "Trigger Settings Path": "/Equipment/Trigger/Settings",
        "Trigger Settings Keys": ["Mode", "Prescale", "Coincidence window"],
        "Threshold Path": "/Equipment/SAMPIC/Settings/Threshold",
        # A rate divided by an unexpected prescale is the failure this page
        # exists to catch. 0 disables the check.
        "Expected Prescale": 1,
        "History Timescale": "10m",
    },

    # --- Scope: one event through mhttpd, decoded in the browser ---------
    # No renderer reads these yet -- there is no frontend putting these banks
    # into a live event buffer. But unlike every other path in this file, these
    # four are *confirmed* rather than proposed: see
    # docs/sampic-bank-verification.md, which reads them out of
    # sampic-to-midas's converter (bin_to_mid.py:31, sampic_banks.py:19-20).
    # The bank layout is documented there too, so a browser decoder for AD00 is
    # writable whenever a frontend exists to feed it.
    "Scope": {
        "Event Rate Hz": 1.0,
        "Event ID": 1,
        "Waveform Bank": "AD00",
        "Hit Time Bank": "AT00",
        # Not in the bank, and this is the one number here that is a guess. The
        # period lives in the SAMPIC .bin header (1e3 / sampling_freq_msps ns)
        # and does not survive into MIDAS, so the page has to be told it. The
        # default is 6400 MS/s, the rate run 108 was taken at. Set it to 0 and
        # the page draws in samples and says so, which is better than an axis
        # labelled ns that is wrong by a factor.
        "Sample Period ns": 0.15625,
        "Buffer": "SYSTEM",
    },

    # --- the analyzer pages ----------------------------------------------
    # Empty until somebody writes an analyzer and decides what it publishes.
    # The pages ask it for its list and name what they did not find, rather
    # than hardcoding a histogram nobody has agreed to.
    "Channels": {"Histograms": [""]},
    "Pulses": {"Histograms": [""]},
    "Physics": {"Histograms": [""]},

    # --- SlowControls: ODB and history, needs only a frontend ------------
    "SlowControls": {
        "Temperature Path": "/Equipment/ATAR_SC/Variables/Temperature",
        "Light Path": "/Equipment/ATAR_SC/Variables/Light level",
        "Leakage Path": "/Equipment/ATAR_HV/Variables/Current",
        "Measured Path": "/Equipment/ATAR_HV/Variables/Measured",
        # A Setting, not a Variable: the demand is what somebody asked for.
        # Comparing it against the readback beside it is the whole panel, and
        # nothing anywhere currently does that comparison.
        "Demand Path": "/Equipment/ATAR_HV/Settings/Demand",
        "Position Path": "/Equipment/Motion/Variables/Position",
        "Motion Settings": "/Equipment/Motion/Settings",
        # These three are the thresholds frontend_requirements.md names for
        # MIDAS alarms. The panels use the same numbers deliberately: the
        # screen and the alarm system must not disagree about what "high"
        # means.
        "Bias Tolerance V": 5.0,
        "Leakage Warn uA": 2.0,
        "Temp Warn C": 30.0,
        "History Timescale": "1h",
    },

    # Retired has no configuration and declares none, so no subtree is created
    # for it. A /DQM key nobody reads is a key somebody will eventually edit
    # expecting something to happen.
}
