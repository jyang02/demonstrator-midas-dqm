"""Histogram accumulators.

Plain numpy, no ROOT. Counting histograms with under- and overflow bins, filled
vectorised, and encodable straight to the wire format the browser reads.

Binning follows the usual convention and the one musip's format assumes: index 0
is underflow, 1..n are the real bins, n+1 is overflow. The encoder ships all of
them; the page strips the two ends.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from mdqm.dqm import framing


def _indices(values: np.ndarray, n: int, lo: float, hi: float) -> tuple[np.ndarray, int]:
    """Bin indices in [0, n+1] for `values`, plus how many were dropped as NaN.

    NaN is dropped rather than binned. Putting it in overflow would be the
    tempting one-liner and it would quietly turn "this quantity could not be
    computed" into "this quantity was very large", which is a lie a monitoring
    plot should not tell. The count is reported instead.
    """
    v = np.asarray(values, dtype=np.float64).ravel()
    good = np.isfinite(v)
    dropped = int(v.size - np.count_nonzero(good))
    v = v[good]
    if v.size == 0:
        return np.empty(0, dtype=np.intp), dropped

    width = (hi - lo) / n
    idx = np.floor((v - lo) / width).astype(np.intp) + 1
    np.clip(idx, 0, n + 1, out=idx)
    return idx, dropped


@dataclass
class Axis:
    n: int
    lo: float
    hi: float
    title: str = ""

    def __post_init__(self):
        if self.n < 1:
            raise ValueError(f"axis needs at least one bin, got {self.n}")
        if not self.hi > self.lo:
            raise ValueError(f"axis range must be increasing, got [{self.lo}, {self.hi}]")


@dataclass
class Hist1D:
    """A 1D counting histogram."""

    name: str
    x: Axis
    title: str = ""
    #: Set by the definition; the analyzer clears these at run start.
    clear_on_run_start: bool = True
    counts: np.ndarray = field(init=False)
    entries: int = field(default=0, init=False)
    dropped: int = field(default=0, init=False)

    def __post_init__(self):
        self.counts = np.zeros(self.x.n + 2, dtype=np.uint32)

    def fill(self, values) -> None:
        idx, dropped = _indices(values, self.x.n, self.x.lo, self.x.hi)
        self.dropped += dropped
        if idx.size:
            # bincount rather than np.add.at: same result, several times faster,
            # and this is the per-sample path for persistence-style fills.
            self.counts += np.bincount(idx, minlength=self.x.n + 2).astype(np.uint32)
            self.entries += int(idx.size)

    def clear(self) -> None:
        self.counts.fill(0)
        self.entries = 0
        self.dropped = 0

    def encode(self) -> bytes:
        return framing.encode_histogram(self.counts, [(self.x.lo, self.x.hi)], self.entries)

    def metadata(self) -> dict:
        return {
            "name": self.name, "title": self.title, "dimensions": 1,
            "entries": self.entries, "dropped": self.dropped,
            "axes": [{"bins": self.x.n, "lo": self.x.lo, "hi": self.x.hi,
                      "title": self.x.title}],
        }


@dataclass
class Hist2D:
    """A 2D counting histogram. `counts` is (ny+2, nx+2), x fastest."""

    name: str
    x: Axis
    y: Axis
    title: str = ""
    clear_on_run_start: bool = True
    counts: np.ndarray = field(init=False)
    entries: int = field(default=0, init=False)
    dropped: int = field(default=0, init=False)

    def __post_init__(self):
        self.counts = np.zeros((self.y.n + 2, self.x.n + 2), dtype=np.uint32)

    def fill(self, xs, ys) -> None:
        xv = np.asarray(xs, dtype=np.float64).ravel()
        yv = np.asarray(ys, dtype=np.float64).ravel()
        if xv.size != yv.size:
            raise ValueError(f"x and y must be the same length, got {xv.size} and {yv.size}")

        good = np.isfinite(xv) & np.isfinite(yv)
        self.dropped += int(xv.size - np.count_nonzero(good))
        xv, yv = xv[good], yv[good]
        if xv.size == 0:
            return

        ix, _ = _indices(xv, self.x.n, self.x.lo, self.x.hi)
        iy, _ = _indices(yv, self.y.n, self.y.lo, self.y.hi)

        # One bincount over the flattened index: the 2D fill is the hot path
        # (persistence puts 1024 samples per channel per event through here), and
        # np.add.at on a 2D array is markedly slower for the same answer.
        nx = self.x.n + 2
        flat = iy * nx + ix
        self.counts += np.bincount(
            flat, minlength=self.counts.size
        ).astype(np.uint32).reshape(self.counts.shape)
        self.entries += int(xv.size)

    def clear(self) -> None:
        self.counts.fill(0)
        self.entries = 0
        self.dropped = 0

    def encode(self) -> bytes:
        return framing.encode_histogram(
            self.counts, [(self.x.lo, self.x.hi), (self.y.lo, self.y.hi)], self.entries)

    def metadata(self) -> dict:
        return {
            "name": self.name, "title": self.title, "dimensions": 2,
            "entries": self.entries, "dropped": self.dropped,
            "axes": [{"bins": self.x.n, "lo": self.x.lo, "hi": self.x.hi, "title": self.x.title},
                     {"bins": self.y.n, "lo": self.y.lo, "hi": self.y.hi, "title": self.y.title}],
        }


class RollingHist2D:
    """A Hist2D over roughly the last ``cap`` events, not the whole run.

    Some plots answer "what is happening" and some answer "what happened". A
    persistence plot and an amplitude spectrum are the first kind: a shifter
    looks at them to see the pulse shape the detector is producing *now*, and a
    sum over an eight-hour run answers a question nobody asked while burying
    any change under the weight of everything before it.

    Kept as two halves rather than a ring of events, which is the whole trick.
    Storing the last N events to subtract them later would mean keeping every
    sample of every hit -- megabytes, and a second copy of the decode. Instead
    one half is filled while the other is held, and they swap when the filling
    half has taken ``cap // 2`` events. What is served is the sum, so the window
    holds between ``cap // 2`` and ``cap`` events and never less.

    That is why ``cap`` is a cap and not a window length: the count in the plot
    varies by a factor of two under a fixed setting, and the one thing that can
    honestly be promised is the ceiling. ``metadata()`` reports the real count
    so the page can show it rather than implying the setting is the answer.

    The alternative -- clear everything every N events -- was rejected for one
    concrete reason: it empties the plot in front of whoever is watching it, and
    an empty plot on a monitoring page reads as a fault. This never shows fewer
    than half a window.
    """

    def __init__(self, name: str, x: Axis, y: Axis, title: str = "",
                 cap: int = 1000, clear_on_run_start: bool = True):
        self.name = name
        self.title = title
        self.clear_on_run_start = clear_on_run_start
        # Both halves share the Axis objects, which is safe because an Axis is
        # read-only once built and is never rebound -- a rebinning replaces the
        # whole RollingHist2D, the same way it replaces a Hist2D.
        self.active = Hist2D(name, x, y, title)
        self.retired = Hist2D(name, x, y, title)
        self.events = 0
        # How many events are in the half being held. Tracked rather than
        # assumed to be `half`, because set_cap() can swap early and leave a
        # short half behind, and window_events is reported to the shifter.
        self.retired_events = 0
        self.swaps = 0
        self.set_cap(cap)

    # -- the knob ------------------------------------------------------------

    def set_cap(self, cap) -> None:
        """Adopt a new cap. Never resets, and takes effect at the next swap.

        Lowering it below what the filling half already holds swaps at once, so
        a shifter who cuts the cap sees something happen rather than waiting out
        the old one. Raising it just lets the current half run on.

        The half already being held is not re-cut either way -- it would mean
        throwing away the newest data to honour a number sooner -- so for up to
        one swap after a cut the window can still be larger than the new cap.
        ``window`` in the metadata is the real count throughout, which is the
        reason the page shows that and not the setting.
        """
        self.cap = max(2, int(cap))
        self.half = max(1, self.cap // 2)
        if self.events >= self.half:
            self._swap()

    def _swap(self) -> None:
        self.active, self.retired = self.retired, self.active
        self.active.clear()
        self.retired_events = self.events
        self.events = 0
        self.swaps += 1

    # -- the Hist2D surface --------------------------------------------------

    def fill(self, xs, ys) -> None:
        self.active.fill(xs, ys)

    def note_event(self) -> None:
        """One event has been processed. Swap when this half has had its share."""
        self.events += 1
        if self.events >= self.half:
            self._swap()

    @property
    def counts(self) -> np.ndarray:
        return self.active.counts + self.retired.counts

    @property
    def entries(self) -> int:
        return self.active.entries + self.retired.entries

    @property
    def dropped(self) -> int:
        return self.active.dropped + self.retired.dropped

    @property
    def x(self) -> Axis:
        return self.active.x

    @property
    def y(self) -> Axis:
        return self.active.y

    @property
    def window_events(self) -> int:
        """Events actually in what is being served, which is what to report."""
        return self.events + self.retired_events

    def clear(self) -> None:
        self.active.clear()
        self.retired.clear()
        self.events = 0
        self.retired_events = 0

    def encode(self) -> bytes:
        return framing.encode_histogram(
            self.counts, [(self.x.lo, self.x.hi), (self.y.lo, self.y.hi)], self.entries)

    def metadata(self) -> dict:
        meta = self.active.metadata()
        meta["entries"] = self.entries
        meta["dropped"] = self.dropped
        # The page shows these beside the plot. "cap" is the setting and
        # "window" is what is really in there; showing only the first would
        # claim a number the plot does not have.
        meta["cap"] = self.cap
        meta["window"] = self.window_events
        meta["rolling"] = True
        return meta


class HistStore:
    """The analyzer's histograms, by name.

    Deliberately a plain container that lives *outside* the MIDAS connection, so
    a reconnect after a MIDAS restart does not lose what has been accumulated --
    which is what makes a bounce invisible to whoever is watching the page.
    """

    def __init__(self):
        self._by_name: dict[str, Hist1D | Hist2D] = {}

    def add(self, hist):
        self._by_name[hist.name] = hist
        return hist

    def get(self, name):
        return self._by_name.get(name)

    def names(self) -> list[str]:
        return sorted(self._by_name)

    def remove(self, name) -> None:
        self._by_name.pop(name, None)

    def clear(self, selector: str = "") -> int:
        """Clear everything, one collection, or one histogram. Returns how many.

        `selector` matches musip's semantics: empty clears all, `coll` clears
        every name under that prefix, `coll/name` clears exactly one.
        """
        cleared = 0
        for name, hist in self._by_name.items():
            if selector and name != selector and not name.startswith(selector + "/"):
                continue
            hist.clear()
            cleared += 1
        return cleared

    def clear_for_new_run(self) -> int:
        """Clear only the histograms that asked to be cleared at run start."""
        cleared = 0
        for hist in self._by_name.values():
            if hist.clear_on_run_start:
                hist.clear()
                cleared += 1
        return cleared

    def __len__(self):
        return len(self._by_name)

    def __contains__(self, name):
        return name in self._by_name
