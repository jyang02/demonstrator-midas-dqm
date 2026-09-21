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

One subtree per menu page, plus ``Common`` for what every page reads. There is
one menu page, so there is one page subtree; tabs share it, because a tab is not
a configuration boundary. A page with an empty dict creates no subtree, which is
correct: a page with nothing to configure should not appear under /DQM at all.

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

    # --- ATAR: the one page, and everything its four tabs read ------------
    #
    # One subtree, because there is one page and loadConfig() is keyed on the
    # page. It was five -- Rates, Scope, Channels, Pulses and SlowControls --
    # and merging them is not just tidying: a tab is not a configuration
    # boundary, and a shifter correcting a bank name at 3am should not have to
    # know which of five subtrees the tab they are looking at reads from.
    #
    # The Rates and SlowControls keys are gone rather than merged. Every one of
    # them named an /Equipment path that no frontend writes -- Trigger,
    # ATAR_SC, ATAR_HV, Motion -- for panels that left the screen with those
    # pages. Keeping them would be keeping editable keys nobody reads, which is
    # the rot the last paragraph of this file warns about.
    "ATAR": {
        # -- the Scope tab: one event through mhttpd, decoded in the browser --
        # Unlike every other path this file has ever carried, these are
        # *specified* rather than proposed: docs/sampic-bank-layout.md writes
        # the bank layout down, which is what makes a browser decoder for AD00
        # writable whenever a frontend exists to feed it.
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

        # -- the windows the two map tiles average over ------------------------
        # Noise and baseline are the same renderer: each draws its quantity
        # twice, over a long window and a short one, and subtracts them. Both
        # cuts are made by the page over the series the analyzer already sent,
        # so changing either costs no analyzer work and loses no history --
        # which is exactly why they are knobs and not constants. What the right
        # numbers are depends on the beam rate and on what a shift is chasing,
        # and nobody can settle that from here.
        #
        # A pair per tile rather than one pair for both: a baseline walk and a
        # noise excursion happen on different timescales, and narrowing one
        # window to chase something must not silently move the other.
        #
        # The long one is the standing state. 120 s is the analyzer's own
        # horizon (/DQM/Analyzer/Binning/recent seconds per channel), so the
        # default averages everything it is sent; the page clamps to that
        # horizon and says so rather than claiming a window it has no data for.
        "Noise Window Seconds": 120.0,
        # The short one is "where it is now". 30 s at the demonstrator's rate
        # is a handful of hits on a live channel -- enough to average the
        # single-hit scatter down to something that does not jump between
        # refreshes, and short enough that it still answers "now".
        # Must be under the long window or the difference map has nothing to
        # subtract; the page clamps and says so.
        "Noise Recent Seconds": 30.0,
        # The same pair for the baseline maps, and the same defaults -- which is
        # a starting point rather than a claim that the two quantities want the
        # same windows. A baseline walks over minutes where a noise excursion
        # arrives in seconds, so if either pair moves first it is likely this
        # one, and that is exactly what having two pairs is for.
        "Baseline Window Seconds": 120.0,
        "Baseline Recent Seconds": 30.0,

        # -- what the analyzer-backed tabs ask for -----------------------------
        # Kept in step with PANELS in pages/js/dqm-hists.js, which decides which
        # plot goes in which tile; tests/test_panels.py asserts the two agree,
        # so the duplication is a checked invariant rather than two places to
        # forget.
        #
        # The page still asks for its list and names what it did not find rather
        # than assuming: these are the histograms the SAMPIC plugin publishes
        # today, not a contract any analyzer has to satisfy.
        #
        # Histograms only. Baseline and noise by channel are recent-value
        # *series*, fetched over dqm::series and not in dqm::list, so naming
        # them here would have probeAnalyzer report them missing on a tab where
        # they are drawing perfectly well. Each series tile reports its own
        # arrival.
        "Histograms": ["sampic/occupancy",
                       "sampic/hits_per_event",
                       "sampic/persistence",
                       "sampic/amplitude_by_channel",
                       "sampic/charge_vs_amplitude"],
    },

    # A page that declares nothing here gets no subtree at all. A /DQM key
    # nobody reads is a key somebody will eventually edit expecting something
    # to happen.
}
