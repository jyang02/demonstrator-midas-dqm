"""The analyzer's live configuration, in the ODB.

Under ``/DQM/Analyzer``, deliberately, and **not** under ``/Equipment/...``:
the analyzer registers no equipment on purpose, because equipment would put it
in the run-transition path where a wedged monitoring process can delay a run
start. A settings tree under ``/Equipment/WDAnalyzer`` would imply equipment
that does not exist. ``/DQM/Analyzer`` sits beside ``/DQM/Scalars``, which the
scaler page already uses.

Everything here is seeded when absent and never overwritten, so an operator's
edits survive a restart. Changing a value takes effect within a couple of
seconds without restarting anything -- which for binning means the affected
histograms are rebuilt and therefore reset, because a histogram with different
bins is a different histogram and pretending otherwise would silently mix two
binnings in one plot.
"""

from __future__ import annotations

import json

ROOT = "/DQM/Analyzer"

#: Which channels are what. Read by the analyzer and by the event display, from
#: one place -- the retired stack kept this in a JSON file that the C++ stages
#: and the browser loaded independently and could disagree about.
CHANNEL_ROLES: dict[str, object] = {
    "waveform channels": [0, 1, 2, 3, 4],
    "s1 channel": 0,
    "rf channel": 5,
    "nim channels": [7, 8, 9, 10, 11, 12, 13, 14, 15],
    "nim threshold V": 0.1,
    #: Per-channel names, 18 entries. Empty means "use ch NN".
    "labels": [""] * 18,
}

#: Histogram binning. Defaults are the values the retired C++ stages used, which
#: are the record of what operators found useful -- not arbitrary starting points.
BINNING: dict[str, object] = {
    "persistence x bins": 256,
    "persistence y bins": 110,
    "persistence y min": -1.0,
    "persistence y max": 0.1,
    "amplitude bins": 200,
    "amplitude min": 0.0,
    "amplitude max": 1.0,
    "deltat bins": 200,
    "deltat max s": 0.1,
    "phase bins": 72,
}

#: How hard the analyzer works. One knob, replacing the retired stack's three.
SAMPLING: dict[str, object] = {
    "max events per s": 20.0,
    "publish history": False,
}

SECTIONS = {
    "Channel roles": CHANNEL_ROLES,
    "Binning": BINNING,
    "Sampling": SAMPLING,
}


def seed(client) -> int:
    """Create any missing key, without disturbing one that exists.

    Written key by key rather than as a subtree dict: ``odb_set`` defaults to
    ``remove_unspecified_keys=True``, so handing it a whole section would delete
    anything an operator had added under it.
    """
    created = 0
    for section, defaults in SECTIONS.items():
        for key, value in defaults.items():
            path = f"{ROOT}/{section}/{key}"
            if client.odb_exists(path):
                continue
            client.odb_set(path, value)
            created += 1
    return created


def _as_list(value):
    """MIDAS collapses a one-element array to a scalar on the way out."""
    if value is None:
        return []
    return list(value) if isinstance(value, list | tuple) else [value]


def read(client) -> dict[str, dict]:
    """The current settings, with built-in defaults for anything missing.

    Never raises: the analyzer must keep running with an ODB that somebody has
    half-edited, and falling back to a known default is better than stopping.
    """
    out: dict[str, dict] = {}
    for section, defaults in SECTIONS.items():
        values = dict(defaults)
        for key, default in defaults.items():
            try:
                got = client.odb_get(f"{ROOT}/{section}/{key}")
            except Exception:
                continue
            if got is None:
                continue
            values[key] = _as_list(got) if isinstance(default, list) else got
        out[section] = values
    return out


def fingerprint(settings: dict) -> str:
    """A stable digest, for spotting a change without diffing by hand."""
    return json.dumps(settings, sort_keys=True, default=str)


def binning_fingerprint(settings: dict) -> str:
    """Only the parts that change the *shape* of a histogram.

    Separate from the whole-settings digest on purpose: moving a channel role
    should not throw away accumulated plots, while changing a bin count has to.
    """
    return json.dumps({
        "Binning": settings.get("Binning", {}),
        # The channel list decides which persistence and amplitude histograms
        # exist at all, so it belongs here too.
        "waveform channels": settings.get("Channel roles", {}).get("waveform channels"),
    }, sort_keys=True, default=str)
