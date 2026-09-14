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

    # --- the analyzer pages ----------------------------------------------
    # Empty until somebody writes an analyzer and decides what it publishes.
    # The page asks it for its list and names what it did not find, rather than
    # hardcoding a histogram nobody has agreed to.
    "Channels": {"Histograms": [""]},
}
