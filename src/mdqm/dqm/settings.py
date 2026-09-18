"""The analyzer's live configuration, in the ODB.

Under ``/DQM/Analyzer``, deliberately, and **not** under ``/Equipment/...``:
the analyzer registers no equipment on purpose, because equipment would put it
in the run-transition path where a wedged monitoring process can delay a run
start. A settings tree under ``/Equipment/<something>`` would imply equipment
that does not exist. ``/DQM/Analyzer`` sits beside the pages' own subtrees under
``/DQM``.

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

#: Which channels are what. Read by the analyzer and by the event display from
#: one place, so the two cannot disagree: split across a config file and a
#: browser copy, this is exactly the thing that drifts.
CHANNEL_ROLES: dict[str, object] = {
    "waveform channels": [0, 1, 2, 3, 4],
    "s1 channel": 0,
    "rf channel": 5,
    "nim channels": [7, 8, 9, 10, 11, 12, 13, 14, 15],
    "nim threshold V": 0.1,
    #: Per-channel names, 18 entries. Empty means "use ch NN".
    "labels": [""] * 18,
}

#: Histogram binning.
#:
#: A default here is only meaningful for the detector it was chosen against.
#: These are chosen against SAMPIC data: an earlier set described a 1024-sample
#: record with negative-going pulses about zero, which the demonstrator's data
#: is not. Measured over 3000 events of run 108 (7036 hits, 450304 samples):
#:
#:     samples     -0.107 .. 0.996 V   (median 0.763)  -- not -1.0 .. 0.1
#:     amplitude   -0.685 .. 0.179 V   (median -0.068) -- not 0.0 .. 1.0
#:     record      64 samples, always                  -- not 1024
#:
#: A range chosen for a different shape does not clip these distributions, it
#: misses them: every entry lands in under- or overflow and the plot reads as
#: empty. So they are set from the measurements above rather than left for each
#: operator to rediscover, and the plugin reports an ``edge_fraction`` per
#: histogram so a range that stops fitting says so instead of going quiet.
BINNING: dict[str, object] = {
    "persistence x bins": 64,
    "persistence y bins": 110,
    "persistence y min": -0.2,
    "persistence y max": 1.0,
    "amplitude bins": 200,
    "amplitude min": -0.8,
    "amplitude max": 0.2,
    "baseline bins": 200,
    "baseline min": 0.0,
    "baseline max": 1.0,
    "noise bins": 200,
    "noise max V": 0.05,
    #: The waveform's integral, baseline-subtracted, per hit. Signed and
    #: symmetric: the sign is the pulse polarity, and it is not the same in
    #: every file -- a demonstrator recording integrates almost entirely
    #: positive and run 108 almost entirely negative, so an axis fitted to
    #: either puts the other in the underflow. -6..+6 leaves 0.00% of
    #: demonstrator hits and 0.13% of run 108's outside, measured.
    "charge bins": 120,
    "charge min": -6.0,
    "charge max": 6.0,
    #: 0..31 in run 108; two SAMPIC chips at 16 channels each.
    "channels": 32,
    "max hits per event": 16,
    #: Not read by the SAMPIC plugin -- it publishes neither a delta-t nor a
    #: phase, and the module docstring says why. Left for the plugin that does.
    "deltat bins": 200,
    "deltat max s": 0.1,
    "phase bins": 72,
}

#: How many events the rolling plots keep. The shifter's knob, and the reason
#: it is its own section rather than another entry under Binning: changing a bin
#: count has to throw away what has been accumulated, and changing how far back
#: a plot looks must not. Only the histograms named here roll; everything else
#: accumulates for the whole run.
WINDOW: dict[str, object] = {
    "persistence events": 1000,
    "amplitude by channel events": 1000,
}

#: How hard the analyzer works. One knob rather than three interacting ones.
SAMPLING: dict[str, object] = {
    "max events per s": 20.0,
    #: Whether to write the plugin's history values into the ODB for mlogger to
    #: trend. Off by default, and deliberately: it writes to a tree outside our
    #: own on every period and creates links under /History, which is not
    #: something a monitoring client should do to an experiment that did not
    #: ask for it. An experiment that wants the trends turns it on.
    "publish history": False,
    #: Seconds between writes, and the whole of what this costs on disk.
    #:
    #: mlogger writes a history record on EVERY ODB write to a linked value,
    #: with no minimum period of its own -- ``Common/Log history`` throttles an
    #: equipment, and there is no equivalent for /History/Links. So the file
    #: grows by one record per published value per period, and the period is
    #: the only knob.
    #:
    #: 60 s measured at ~11 MB/day for 512 channels of baseline and noise. 10 s
    #: is six times that. A baseline walks over minutes, so a finer period buys
    #: resolution nothing is asking for and fills a disk to get it.
    "history period s": 60.0,
}

SECTIONS = {
    "Channel roles": CHANNEL_ROLES,
    "Binning": BINNING,
    "Window": WINDOW,
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
