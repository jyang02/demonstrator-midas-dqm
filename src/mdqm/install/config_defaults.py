"""Defaults for the page config subtrees under ``/DQM``.

Every one of these is a *default*, not a requirement. With the subtree absent
the page uses exactly these values from its own built-in copy and says so in a
note, which is what lets it work on a bare experiment the first time anyone
opens it. Seeding them into the ODB only makes them editable without touching
a file -- which is the whole point here, because every ``/Equipment`` path
below is *proposed* rather than deployed: the frontend requirements that
accompany the page spec say out loud that only the bank names and the
run-parameter key names are the collaboration's, and that equipment names,
paths and types want confirming against the build actually running at PSI.
Correcting one should be an ODB edit during a shift, not a patch.

One subtree per menu page, plus ``Common`` for what every page reads. A page
with an empty dict creates no subtree, which is correct: a page with nothing to
configure should not appear under /DQM at all. Every page has something today,
so nothing exercises that rule but ``seed_config`` itself.

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
        # histograms. mdqm-analyzer registers under exactly this name; the
        # pages still check rather than assert, and say which name they tried.
        "Analyzer Client": "mdqm_analyzer",
        # mhttpd's own poll, not ours: mhttpd_set_refresh_interval() in
        # dqm-page.js, which is what keeps the header, the alarm banner and the
        # run state current. Five seconds rather than one because it is a round
        # trip per tile-less second for a banner that changes a few times a
        # run, and because anyone reading these pages over an ssh tunnel pays
        # that latency on every one of them. The histogram tiles keep their own
        # cadence, in REFRESH_MS in dqm-hists.js, and are unaffected by this.
        "Refresh ms": 5000,
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
    # four are *specified* rather than proposed: docs/sampic-bank-layout.md
    # writes the bank layout down, which is what makes a browser decoder for
    # AD00 writable whenever a frontend exists to feed it.
    "Scope": {
        "Event Rate Hz": 1.0,
        "Event ID": 1,
        "Waveform Bank": "AD00",
        "Hit Time Bank": "AT00",
        "Collector Bank": "AC00",
        # Not in the bank. The period lives in the SAMPIC .bin header
        # (1e3 / sampling_freq_msps ns) and does not survive into MIDAS, so the
        # page has to be told it. The default is the demonstrator's 1.6 GSPS.
        # It was 0.15625 (6400 MS/s, the rate run 108 was taken at), which is
        # wrong by 4x for demonstrator data; a file that carries the truth puts
        # it at /Equipment/SAMPIC/Settings/Sample period ns. Set this to 0 and
        # the page draws in samples and says so, which is better than an axis
        # labelled ns that is wrong by a factor.
        "Sample Period ns": 0.625,
        "Buffer": "SYSTEM",
    },

    # --- the analyzer pages ----------------------------------------------
    # What these pages ask the analyzer for. Kept in step with PANELS in
    # pages/js/dqm-hists.js, which decides which plot goes in which tile;
    # tests/test_panels.py asserts the two agree, so the duplication is a
    # checked invariant rather than two places to forget.
    #
    # A page still asks for its list and names what it did not find rather than
    # assuming: these are the histograms the SAMPIC plugin publishes today, not
    # a contract any analyzer has to satisfy.
    "Channels": {"Histograms": ["sampic/occupancy",
                                "sampic/hits_per_event",
                                "sampic/baseline_by_channel",
                                "sampic/noise_by_channel"]},
    "Pulses": {"Histograms": ["sampic/persistence",
                              "sampic/amplitude_by_channel"]},
    # Empty on purpose: nothing the SAMPIC plugin can publish answers a question
    # on Physics. Every panel there needs track finding or an energy scale.
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
        # These three are the thresholds the frontend requirements name for
        # MIDAS alarms. The panels use the same numbers deliberately: the
        # screen and the alarm system must not disagree about what "high"
        # means.
        "Bias Tolerance V": 5.0,
        "Leakage Warn uA": 2.0,
        "Temp Warn C": 30.0,
        "History Timescale": "1h",
    },

    # A page that declares nothing here gets no subtree at all. A /DQM key
    # nobody reads is a key somebody will eventually edit expecting something
    # to happen.
}
