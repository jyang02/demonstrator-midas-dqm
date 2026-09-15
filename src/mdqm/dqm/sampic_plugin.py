"""The SAMPIC analysis plugin: AD00 hits in, accumulated histograms out.

This is the first plugin in ``analyzer.PLUGINS``, and it exists because the
reason that registry was empty stopped being true. The note there said the
demonstrator "has no documented bank to decode" -- but
``docs/sampic-bank-layout.md`` specifies AD00/AT00, ``mdqm.dqm.sampic`` is
cross-tested against the browser decoder in ``pages/js/dqm-adbanks.js``, and the
Scope page decodes the same bank out of a live buffer. A bank that two decoders
agree on and a page draws is documented enough to analyse.

What it publishes, all from fields the converter actually writes:

    sampic/occupancy            hits per channel
    sampic/hits_per_event       multiplicity
    sampic/amplitude            pulse amplitude, all channels
    sampic/amplitude_by_channel channel x amplitude
    sampic/baseline_by_channel  channel x baseline
    sampic/noise_by_channel     channel x pre-pulse RMS
    sampic/persistence          sample index x volts, every sample of every hit

What it deliberately does **not** publish, because the data will not support it
and a plot that looks plausible and is wrong is worse than a panel that says it
is blocked:

* **Time over threshold.** ``tot_value`` is ``TOT_ABSENT`` (-1.0) in every hit
  of run 108 -- 7036 of 7036 measured. ``sampic.py`` says why: the standalone
  ``.bin`` format carries no TOT and the converter writes a sentinel. A TOT
  histogram here would be a single spike at -1 ns that reads as a measurement.
* **Time between hits.** ``time_instant`` is identical for every hit in an
  event (>99% of intra-event differences are exactly 0, over 4036 pairs):
  hits are coincident by construction, which is what made them one event.
  The quantity Physics wants is between *events*, and that needs a trigger.
* **Anything in energy units.** Amplitude is volts. Converting needs a
  calibration with an owner, which is the blocker those panels already name.
* **Anything per layer.** There is no channel-to-layer map -- ``Channel roles``
  carries waveform/s1/rf/nim and no geometry -- so a "by layer" axis would be
  invented here rather than read from anywhere.
* **Calorimeter, MuPix, tracks.** No bank, no equipment, nothing to decode.

AT00 and AC00 are read but not histogrammed. They carry one number each that
can be checked -- the frontend's and the collector's own hit counts -- and
per-event scalars about how the DAQ assembled the event, which is not a
measurement of the detector. The check is counted into ``status()``; the
scalars are shown beside the event on the Scope page, where an operator can
read them against the event they describe.

Channels are an *axis* here rather than one histogram per channel, so
``Channel roles/waveform channels`` does not change what exists. It is still
reported in ``status()``, and the analyzer still rebuilds on a change to it --
see ``settings.binning_fingerprint`` -- which costs a reset and nothing else.

Deliberately imports no ``midas``: the event is duck-typed, so the whole plugin
is testable on a machine with no MIDAS installed, which is where its tests run.
"""

from __future__ import annotations

import numpy as np

from mdqm.dqm import sampic
from mdqm.dqm.hist import Axis, Hist1D, Hist2D

#: How many leading samples the noise estimate uses. The pulse is well clear of
#: the start of the record in this format -- the earliest minimum measured in
#: run 108 sits around sample 14 -- so the first few samples are baseline. Short
#: enough to stay baseline, long enough for the RMS to mean something.
PRESAMPLES = 8

#: Histogram collection prefix. ``dqm::clear`` takes "sampic" to clear the lot,
#: which is musip's selector semantics and what HistStore.clear implements.
PREFIX = "sampic"

def _global_channel(hit) -> float:
    """The index every per-channel axis here uses.

    ``sampic.decode_hit`` already derives it, so this only recomputes it for a
    hit built by hand. It is the same order the ODB's parallel ``Channel map
    detector`` / ``channel id`` / ``is active`` arrays use, so occupancy bin i
    and channel-map entry i are the same readout channel and a detector label
    can be read straight off a file that carries one.
    """
    if "global_channel" in hit:
        return float(hit["global_channel"])
    return float(sampic.global_channel(hit))


def _global_channels(hits) -> np.ndarray:
    return np.fromiter((_global_channel(h) for h in hits), dtype=np.float64,
                       count=len(hits))


def _payload(bank) -> bytes:
    """Bank data as bytes, whatever shape the bindings handed over.

    With ``use_numpy=True`` a TID_BYTE bank is a uint8 ndarray and this is a
    memcpy; without it the same bank is a tuple of Python ints. The analyzer
    always asks for numpy -- see ``run_once`` -- but a caller that did not
    should get the right answer slowly rather than a TypeError.
    """
    data = bank.data
    tobytes = getattr(data, "tobytes", None)
    return tobytes() if tobytes is not None else bytes(bytearray(data))


def _edge_fraction(hist) -> float:
    """Share of entries in the under/overflow bins, rounded.

    Reported per histogram because a binning is only ever right for the data it
    was chosen against. A range that does not fit produces an empty-looking plot
    and no error; this is the number that says so before somebody debugs the
    renderer instead.
    """
    counts = hist.counts
    total = int(counts.sum())
    if not total:
        return 0.0
    if counts.ndim == 1:
        edge = int(counts[0]) + int(counts[-1])
    else:
        edge = int(counts[0, :].sum() + counts[-1, :].sum()
                   + counts[1:-1, 0].sum() + counts[1:-1, -1].sum())
    return round(edge / total, 4)


class SampicPlugin:
    """Accumulates AD00 hits. One instance per analyzer, rebuilt on rebinning."""

    name = "sampic"

    #: Used by the constructor, which has no ODB to read yet. The analyzer calls
    #: reconfigure() with the real settings as soon as it is connected, so these
    #: only decide what the first fraction of a second looks like.
    DEFAULT_BINNING: dict[str, object] = {
        "persistence x bins": sampic.AD_MAX_SAMPLES,
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
        # 4 FE boards x 64 board-local channels. The axis is the GLOBAL index
        # fe_board_index * CHANNELS_PER_BOARD + channel (see _global_channels),
        # so it must span every board, not one board's worth.
        "channels": 256,
        # Demonstrator events reach 35 hits; 16 sent the rest to the overflow.
        "max hits per event": 40,
    }

    def __init__(self, store, roles=None, binning=None):
        self.store = store
        self.roles = dict(roles or {})
        self.binning = {**self.DEFAULT_BINNING, **(binning or {})}
        self.events = 0
        self.hits = 0
        self.bad_banks = 0
        # Events where AT00 or AC00 disagreed with the AD00 hit count, and how
        # many of each bank were there to check at all. A count of zero means
        # nothing rather than "all agreed" unless the seen counter is non-zero.
        self.timing_seen = 0
        self.timing_mismatches = 0
        self.collector_seen = 0
        self.collector_mismatches = 0
        self.last_mismatch = ""
        self.last_error: str | None = None
        self._build()

    # -- histograms ----------------------------------------------------------

    def _names(self) -> list[str]:
        return [f"{PREFIX}/{n}" for n in
                ("occupancy", "hits_per_event", "amplitude", "amplitude_by_channel",
                 "baseline_by_channel", "noise_by_channel", "persistence")]

    def _build(self) -> None:
        b = self.binning
        nch = int(b["channels"])

        def chan() -> Axis:
            """One bin per channel exactly.

            With lo=0 and hi=nch, bin i is channel i, so the occupancy plot can
            be read off without arithmetic. A fresh Axis per histogram because
            Hist1D/Hist2D keep a reference to the one they are given.
            """
            return Axis(nch, 0.0, float(nch), "channel")

        self.store.add(Hist1D(
            f"{PREFIX}/occupancy", chan(), "Hits per channel"))
        self.store.add(Hist1D(
            f"{PREFIX}/hits_per_event",
            Axis(int(b["max hits per event"]), 0.0, float(b["max hits per event"]), "hits"),
            "Hits per event"))
        self.store.add(Hist1D(
            f"{PREFIX}/amplitude",
            Axis(int(b["amplitude bins"]), float(b["amplitude min"]),
                 float(b["amplitude max"]), "amplitude (V)"),
            "Pulse amplitude"))
        self.store.add(Hist2D(
            f"{PREFIX}/amplitude_by_channel", chan(),
            Axis(int(b["amplitude bins"]), float(b["amplitude min"]),
                 float(b["amplitude max"]), "amplitude (V)"),
            "Amplitude by channel"))
        self.store.add(Hist2D(
            f"{PREFIX}/baseline_by_channel", chan(),
            Axis(int(b["baseline bins"]), float(b["baseline min"]),
                 float(b["baseline max"]), "baseline (V)"),
            "Baseline by channel"))
        self.store.add(Hist2D(
            f"{PREFIX}/noise_by_channel", chan(),
            Axis(int(b["noise bins"]), 0.0, float(b["noise max V"]), "RMS (V)"),
            f"Noise: RMS of the first {PRESAMPLES} samples"))
        self.store.add(Hist2D(
            f"{PREFIX}/persistence",
            Axis(int(b["persistence x bins"]), 0.0, float(sampic.AD_MAX_SAMPLES), "sample"),
            Axis(int(b["persistence y bins"]), float(b["persistence y min"]),
                 float(b["persistence y max"]), "V"),
            "All waveforms, overlaid"))

    def reconfigure(self, roles, binning) -> None:
        """A histogram with different bins is a different histogram.

        Dropped and rebuilt rather than re-binned, which is the contract
        ``Analyzer.apply_settings`` implements: keeping the old contents under a
        new axis would mix two binnings in one plot and never say so.
        """
        self.roles = dict(roles or {})
        self.binning = {**self.DEFAULT_BINNING, **(binning or {})}
        for name in self._names():
            self.store.remove(name)
        self._build()

    # -- the event path ------------------------------------------------------

    def accepts(self, event) -> bool:
        """Any event carrying an AD00 bank.

        By bank rather than by event id on purpose. The id is a frontend's
        choice -- it is 1 in run 108 and ``/DQM/Scope/Event ID`` exists because
        it is configurable -- while the bank is the thing this plugin can
        actually read. Cheap enough for the drain path: one dict lookup.
        """
        banks = getattr(event, "banks", None)
        return bool(banks) and sampic.AD_BANK in banks

    def process(self, event, run_number=None) -> bool:
        """Decode one event into the histograms. Returns whether it counted.

        A bank this decoder disagrees with is counted and reported rather than
        raised: one malformed event must not take down a monitor that is the
        only thing telling a shifter what is happening. A layout change shows up
        as ``bad_banks`` climbing, with the message kept in ``status()``.
        """
        try:
            hits = sampic.decode_ad(_payload(event.banks[sampic.AD_BANK]))
        except (ValueError, KeyError, TypeError) as exc:
            self.bad_banks += 1
            self.last_error = f"{type(exc).__name__}: {exc}"
            return False

        self.events += 1
        self.hits += len(hits)
        self._check_counts(event, len(hits))
        self.store.get(f"{PREFIX}/hits_per_event").fill([len(hits)])
        if not hits:
            return True

        channels = _global_channels(hits)
        amplitudes = np.fromiter((h["amplitude"] for h in hits), dtype=np.float64,
                                 count=len(hits))
        baselines = np.fromiter((h["baseline"] for h in hits), dtype=np.float64,
                                count=len(hits))

        self.store.get(f"{PREFIX}/occupancy").fill(channels)
        self.store.get(f"{PREFIX}/amplitude").fill(amplitudes)
        self.store.get(f"{PREFIX}/amplitude_by_channel").fill(channels, amplitudes)
        self.store.get(f"{PREFIX}/baseline_by_channel").fill(channels, baselines)

        noise_ch, noise = [], []
        persist_x, persist_y = [], []
        for hit in hits:
            # decode_hit truncates to data_size, so this is the real record and
            # never the zero padding -- plotting that tail would draw a cliff to
            # 0 V that looks like an edge.
            wave = np.asarray(hit["waveform"], dtype=np.float64)
            if wave.size == 0:
                continue
            persist_x.append(np.arange(wave.size, dtype=np.float64))
            persist_y.append(wave)
            if wave.size >= PRESAMPLES:
                noise_ch.append(_global_channel(hit))
                noise.append(float(np.std(wave[:PRESAMPLES])))

        if persist_x:
            self.store.get(f"{PREFIX}/persistence").fill(
                np.concatenate(persist_x), np.concatenate(persist_y))
        if noise:
            self.store.get(f"{PREFIX}/noise_by_channel").fill(noise_ch, noise)
        return True

    # -- what the page shows about the analyzer ------------------------------

    def _check_counts(self, event, nhits: int) -> None:
        """Three statements of one number, from three levels of the DAQ.

        AD00's hit count is what arrived, AT00's ``nhits`` is what the frontend
        clustered, and AC00's ``total_hits`` is what the event builder believes
        it assembled the event from. They disagreeing means the event was built
        from parts that did not belong together -- a fault no per-hit histogram
        here could show, because every histogram would look entirely normal.

        Counted rather than rejected: the hits are still real and still worth
        filling, and an analyzer that silently dropped events would hide the
        very thing this is for. The count is what a shifter reads in status().

        A bank that is not there is not a disagreement. Only generated files
        carry AC00 at all, and a repackaged recording legitimately has none.
        """
        banks = getattr(event, "banks", None) or {}
        for name, field, seen, bad in (
                (sampic.AT_BANK, "nhits", "timing_seen", "timing_mismatches"),
                (sampic.AC_BANK, "total_hits", "collector_seen", "collector_mismatches")):
            if name not in banks:
                continue
            try:
                decoded = (sampic.decode_at if name == sampic.AT_BANK
                           else sampic.decode_ac)(_payload(banks[name]))
            except (ValueError, KeyError, TypeError) as exc:
                # A malformed timing bank is a layout fault like any other, and
                # is counted where a shifter already looks for one.
                self.bad_banks += 1
                self.last_error = f"{name}: {type(exc).__name__}: {exc}"
                continue
            setattr(self, seen, getattr(self, seen) + 1)
            claimed = int(decoded[field])
            if claimed != nhits:
                setattr(self, bad, getattr(self, bad) + 1)
                self.last_mismatch = (f"{name} says {claimed} hits, "
                                      f"{sampic.AD_BANK} carries {nhits}")

    def status(self) -> dict:
        return {
            "plugin": self.name,
            "events": self.events,
            "hits": self.hits,
            "hits_per_event": round(self.hits / self.events, 2) if self.events else 0.0,
            "bad_banks": self.bad_banks,
            "last_error": self.last_error,
            # Denominators included on purpose: 0 mismatches out of 0 events
            # carrying the bank is not agreement, and a shifter reading only
            # the numerator could not tell the two apart.
            "timing_seen": self.timing_seen,
            "timing_mismatches": self.timing_mismatches,
            "collector_seen": self.collector_seen,
            "collector_mismatches": self.collector_mismatches,
            "last_mismatch": self.last_mismatch,
            "binning": dict(self.binning),
            "channel_roles": dict(self.roles),
            # Per histogram, so a range that does not fit the data is visible
            # here rather than inferred from an empty-looking plot.
            "edge_fraction": {name: _edge_fraction(h)
                              for name in self._names()
                              if (h := self.store.get(name)) is not None},
        }
