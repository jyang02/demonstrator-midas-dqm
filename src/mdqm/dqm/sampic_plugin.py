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
    sampic/persistence          sample index x volts, every sample of every hit

and two *series*, which are not histograms and are served over ``dqm::series``
rather than ``dqm::histogram``:

    sampic/baseline_by_channel  each channel's baselines over the last N seconds
    sampic/noise_by_channel     each channel's pre-pulse RMS over the last N seconds

Those two are recent values rather than an accumulation on purpose, and
``RecentByChannel`` gives the argument: what the tile is asked is where a
channel is sitting *now*, which a sum over the whole run cannot answer and can
actively hide. It is also what makes them cheap enough to draw.

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

import collections
import time

import numpy as np

from mdqm.dqm import sampic
from mdqm.dqm.hist import Axis, Hist1D, Hist2D, RollingHist2D

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


class RecentByChannel:
    """Every value seen on each channel in the last N seconds, with its age.

    A baseline or a noise figure is not a distribution anybody wants summed
    over a run: what a shifter is asking is "where is this channel sitting
    *now*, and is it where its neighbours are". Accumulating that since the
    start of the run answers a question nobody asked, and hides the very thing
    the tile exists to catch -- a channel that has walked -- inside a column
    that still carries every value it ever had.

    So this keeps a recent window per channel instead. It is also what makes
    the tile cheap to draw: a few thousand points rather than a colormap of
    26316 rectangles repainted on every arrival, which is what made the
    Channels page unusable.

    **Cut by time, not by count.** This kept the last ten values per channel,
    which is a different amount of history on every channel: channels are hit
    at very different rates, so ten values is eight seconds on a busy channel
    and four minutes on a quiet one. The page draws these against time, so a
    count-based ring meant the two ends of one plot were showing windows that
    differed by a factor of thirty, and the number ten was doing a job the x
    axis does better and says out loud. One cut, on the axis the reader can
    see.

    The cost now scales with the *event rate* rather than with the channel
    count, which is worth stating because it is the one way this can get
    expensive. At the demonstrator's ~1 Hz a channel is hit every few seconds,
    so a two-minute horizon is a few tens of values per channel and the series
    is about twice the size the ring of ten was. At 100 Hz it would be a
    hundred times that, and this class would need a decimation rather than a
    longer list. There is deliberately no count cap standing by to save it: a
    cap that binds only under load is a cap that silently changes what the plot
    means exactly when somebody is looking at it hardest.

    Timestamps are kept per value, and that is not decoration. A channel that
    has not been hit inside the horizon has nothing here at all, and the page
    counts those and says so rather than letting them go missing.
    """

    __slots__ = ("nch", "horizon", "points_by_channel", "title", "unit")

    def __init__(self, nch: int, horizon_s: float, title: str = "", unit: str = ""):
        self.nch = int(nch)
        #: Seconds of history to keep per channel. Floored rather than trusted:
        #: a zero or negative horizon from a mistyped ODB key would throw every
        #: value away on arrival and present as "the analyzer is not filling".
        self.horizon = max(1.0, float(horizon_s))
        self.title = title
        self.unit = unit
        #: (when, value) per channel, oldest first. A deque because eviction is
        #: always from the old end and events arrive in time order, so the
        #: sequence stays sorted without ever being sorted.
        self.points_by_channel = [collections.deque() for _ in range(self.nch)]

    def _evict(self, i: int, cutoff: float) -> None:
        q = self.points_by_channel[i]
        while q and q[0][0] < cutoff:
            q.popleft()

    def add(self, channels, values, now: float) -> None:
        """Record one event's worth. Out-of-range channels are dropped."""
        cutoff = now - self.horizon
        for ch, v in zip(channels, values):
            i = int(ch)
            if i < 0 or i >= self.nch:
                continue
            self.points_by_channel[i].append((now, float(v)))
            self._evict(i, cutoff)

    def clear(self) -> None:
        for q in self.points_by_channel:
            q.clear()

    @property
    def entries(self) -> int:
        return sum(len(q) for q in self.points_by_channel)

    def points(self, now: float | None = None) -> dict:
        """Parallel arrays for the page: channel, value, and age in seconds.

        Parallel arrays rather than a list of triples because this crosses the
        wire as JSON and the punctuation of 2560 little objects costs more than
        the numbers in them. Rounded for the same reason -- a baseline to four
        decimals is 0.1 mV, well past what the tile can show.

        Channels with nothing in them are omitted rather than sent as an empty
        column: a channel nobody has hit is not a channel sitting at zero, and
        the distinction is the whole point of an occupancy plot next door.

        Evicts on the way out as well as on the way in. A run that stops leaves
        every ring full of values that go on ageing, and a series that kept
        serving them would have the page drawing a minute-old picture labelled
        as now.
        """
        now = time.time() if now is None else now
        cutoff = now - self.horizon
        chans: list[int] = []
        vals: list[float] = []
        ages: list[float] = []
        for i in range(self.nch):
            self._evict(i, cutoff)
            # Oldest first, so the page can draw a polyline without sorting.
            for when, value in self.points_by_channel[i]:
                chans.append(i)
                vals.append(round(value, 4))
                ages.append(round(max(0.0, now - when), 1))
        return {
            "title": self.title,
            "unit": self.unit,
            "window_s": self.horizon,
            "channels": self.nch,
            "entries": len(chans),
            "channel": chans,
            "value": vals,
            "age": ages,
        }


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
        # 100, not 200, for the three histograms that are per-channel: with
        # 256 channels on the other axis they are 2D, and 200 y-bins into a
        # 330px-tall tile is about six times finer than anything visible. At 32
        # channels the total was small enough not to matter; at 256 it is
        # 51200 bins a tile, which is what made the Channels page lag.
        "amplitude bins": 100,
        "amplitude min": -0.8,
        "amplitude max": 0.2,
        "baseline bins": 100,
        "baseline min": 0.0,
        "baseline max": 1.0,
        "noise bins": 100,
        "noise max V": 0.05,
        # Charge is the waveform's integral, baseline-subtracted: see the fill
        # in process(). Signed, and symmetric on purpose -- the sign is the
        # pulse polarity and it is not the same in every file we have. A
        # demonstrator recording integrates almost entirely positive (median
        # +1.08 V*samples over 40002 hits of demo20010) and run 108 almost
        # entirely negative (median -0.82 over 30004), so an axis fitted to
        # either one puts the other in the underflow.
        #
        # -6..+6 leaves 0.00% of demonstrator hits and 0.13% of run 108's
        # outside, measured rather than guessed. The remaining 0.13% is run
        # 108's long negative tail, which reaches -14.8; widening to -16 would
        # catch it and spend two thirds of the axis on a thousandth of the
        # data. edge_fraction() reports what falls off either end, which is the
        # number to look at before changing these.
        "charge bins": 120,
        "charge min": -6.0,
        "charge max": 6.0,
        # 4 FE boards x 64 board-local channels. The axis is the GLOBAL index
        # fe_board_index * CHANNELS_PER_BOARD + channel (see _global_channels),
        # so it must span every board, not one board's worth.
        "channels": 256,
        # Demonstrator events reach 35 hits; 16 sent the rest to the overflow.
        "max hits per event": 40,
        # How many seconds of history the baseline and noise series keep per
        # channel. A time cut, not a count: see RecentByChannel. The page draws
        # these against time and makes its own cut on that axis, so the only
        # job left for this number is to cover the widest window any page asks
        # for, with enough headroom that a slow fetch does not arrive to find
        # the left-hand end already evicted.
        #
        # 120 against the page's 60 is that headroom, doubled rather than
        # shaved: the page refetches every ten seconds and nobody should have
        # to reason about the race. Widening the page's window up to two
        # minutes then needs no analyzer change at all.
        #
        # This is the whole cost of those two tiles, and it now scales with the
        # event rate rather than the channel count -- at ~1 Hz about twice what
        # the ring of ten cost, and proportionally more if the rate rises.
        "recent seconds per channel": 120.0,
    }

    #: Event caps for the two rolling plots. Overridden from /DQM/Analyzer/Window
    #: as soon as the analyzer is connected. Keyed by setting name; the histogram
    #: each one drives is in _WINDOW_OF.
    DEFAULT_WINDOW: dict[str, int] = {
        "persistence events": 1000,
        "amplitude by channel events": 1000,
    }

    #: setting name -> the histogram it caps. One place, so set_window() and
    #: _build() cannot drift apart about which plots roll.
    _WINDOW_OF: dict[str, str] = {
        "persistence events": f"{PREFIX}/persistence",
        "amplitude by channel events": f"{PREFIX}/amplitude_by_channel",
    }

    @property
    def _rolling_names(self) -> list[str]:
        return list(self._WINDOW_OF.values())

    def __init__(self, store, roles=None, binning=None, window=None):
        self.store = store
        self.roles = dict(roles or {})
        self.binning = {**self.DEFAULT_BINNING, **(binning or {})}
        self.window = {**self.DEFAULT_WINDOW, **(window or {})}
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
                 "charge_vs_amplitude", "persistence")]

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
        self.store.add(RollingHist2D(
            f"{PREFIX}/amplitude_by_channel", chan(),
            Axis(int(b["amplitude bins"]), float(b["amplitude min"]),
                 float(b["amplitude max"]), "amplitude (V)"),
            "Amplitude by channel",
            cap=int(self.window["amplitude by channel events"])))
        # Charge against amplitude, both per hit. The question is whether the
        # response holds its shape across the range: a straight band says the
        # two measures of the same pulse agree, and a band that bends or forks
        # says they stop agreeing somewhere, which is where to look.
        #
        # Charge and not energy, which is the honest name. This is the integral
        # of a voltage over time -- a charge up to the input impedance, and a
        # deposited energy only after a per-channel calibration that does not
        # exist and has no owner. The panel that asked for energy keeps its id
        # and gets this instead; an axis labelled MeV that nothing calibrated
        # is the kind of plot that is believed for a month.
        #
        # Amplitude on x, sharing the axis the two amplitude tiles already use,
        # so the three are read against one scale.
        self.store.add(Hist2D(
            f"{PREFIX}/charge_vs_amplitude",
            Axis(int(b["amplitude bins"]), float(b["amplitude min"]),
                 float(b["amplitude max"]), "amplitude (V)"),
            Axis(int(b["charge bins"]), float(b["charge min"]),
                 float(b["charge max"]), "charge (V*samples)"),
            "Charge against amplitude"))
        self.store.add(RollingHist2D(
            f"{PREFIX}/persistence",
            Axis(int(b["persistence x bins"]), 0.0, float(sampic.AD_MAX_SAMPLES), "sample"),
            Axis(int(b["persistence y bins"]), float(b["persistence y min"]),
                 float(b["persistence y max"]), "V"),
            "All waveforms, overlaid",
            cap=int(self.window["persistence events"])))

        # Not histograms. See RecentByChannel: what these two tiles are asked
        # is where a channel is sitting now, which a sum over the run cannot
        # answer. The baseline and noise *bins* settings are left in the
        # binning dict and unused rather than deleted, because an operator who
        # has set them in the ODB should not have them silently disappear; the
        # axis is now whatever the data spans.
        horizon = float(b["recent seconds per channel"])
        self.recent = {
            f"{PREFIX}/baseline_by_channel": RecentByChannel(
                nch, horizon, "Baseline by channel, most recent", "baseline (V)"),
            f"{PREFIX}/noise_by_channel": RecentByChannel(
                nch, horizon, f"Noise by channel, most recent "
                f"(RMS of the first {PRESAMPLES} samples)", "RMS (V)"),
        }

    def reconfigure(self, roles, binning) -> None:
        """A histogram with different bins is a different histogram.

        Dropped and rebuilt rather than re-binned, which is the contract
        ``Analyzer.apply_settings`` implements: keeping the old contents under a
        new axis would mix two binnings in one plot and never say so.
        """
        self.roles = dict(roles or {})
        self.binning = {**self.DEFAULT_BINNING, **(binning or {})}
        # self.window is deliberately left alone. It is not part of a
        # histogram's shape, it arrives by its own path (set_window, which
        # apply_settings calls on every apply and before this), and taking it
        # as an argument here would both clobber that and add a third
        # positional to a protocol every plugin has to implement.
        for name in self._names():
            self.store.remove(name)
        # The windows go the same way and for the same reason: a window of a
        # different width is a different window, and keeping the old values
        # under a new one would mix two settings in one plot without saying so.
        self.recent = {}
        self._build()

    def set_window(self, window) -> None:
        """Adopt new event caps in place.

        Deliberately not a reconfigure. A cap says how far back a plot looks,
        not what shape it is, so changing it must not throw away what is in
        there -- which is exactly what rebuilding would do, and what a shifter
        nudging a number on a page would least expect.
        """
        self.window = {**self.DEFAULT_WINDOW, **(window or {})}
        for key, name in self._WINDOW_OF.items():
            hist = self.store.get(name)
            if hist is not None and hasattr(hist, "set_cap"):
                hist.set_cap(int(self.window[key]))

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
            self._advance_window()
            return True

        channels = _global_channels(hits)
        amplitudes = np.fromiter((h["amplitude"] for h in hits), dtype=np.float64,
                                 count=len(hits))
        baselines = np.fromiter((h["baseline"] for h in hits), dtype=np.float64,
                                count=len(hits))

        self.store.get(f"{PREFIX}/occupancy").fill(channels)
        self.store.get(f"{PREFIX}/amplitude").fill(amplitudes)
        self.store.get(f"{PREFIX}/amplitude_by_channel").fill(channels, amplitudes)
        now = time.time()
        self.recent[f"{PREFIX}/baseline_by_channel"].add(channels, baselines, now)

        noise_ch, noise = [], []
        charge_a, charge_q = [], []
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
            # The same integral the Scope tab's charge display takes, and
            # deliberately the same one: baseline-subtracted so the baseline's
            # own area does not dominate, over the whole record because there
            # is no integration window defined anywhere and picking one here
            # would be inventing a calibration constant inside a histogram.
            # decode_hit has already truncated to data_size, so this is the
            # real record and never the zero padding.
            charge_a.append(float(hit["amplitude"]))
            charge_q.append(float(np.sum(float(hit["baseline"]) - wave)))
            if wave.size >= PRESAMPLES:
                noise_ch.append(_global_channel(hit))
                noise.append(float(np.std(wave[:PRESAMPLES])))

        if persist_x:
            self.store.get(f"{PREFIX}/persistence").fill(
                np.concatenate(persist_x), np.concatenate(persist_y))
        if charge_q:
            self.store.get(f"{PREFIX}/charge_vs_amplitude").fill(charge_a, charge_q)
        if noise:
            self.recent[f"{PREFIX}/noise_by_channel"].add(noise_ch, noise, now)
        self._advance_window()
        return True

    # -- what the page shows about the analyzer ------------------------------

    def _advance_window(self) -> None:
        """Tell the rolling plots one event has been through.

        After the fills, not before, and that ordering is the whole of it: a
        swap between the two would put this event's data in the fresh half
        while its count went to the half just retired, and the window count and
        the entry count would disagree by one for the rest of the run. Caught by
        test_a_rolling_plot_forgets_events_past_its_cap, which asserts they
        agree.

        Per event rather than per hit, and called on the empty-bank path too: an
        event with no hits is still an event the window has seen, and a window
        that only advanced on busy events would quietly reach further back the
        quieter the run got -- exactly when a shifter is looking to see whether
        anything has changed.
        """
        for name in self._rolling_names:
            hist = self.store.get(name)
            if hist is not None and hasattr(hist, "note_event"):
                hist.note_event()

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

    def series(self, name: str = "") -> dict:
        """The recent-value series, for ``dqm::series``.

        With a name, that one series; without, every name it serves. The
        no-name form is what a page uses to find out what is on offer, the same
        shape ``dqm::list`` plays for histograms.
        """
        if name:
            r = self.recent.get(name)
            return r.points() if r is not None else {}
        return {"names": list(self.recent)}

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
