"""The SAMPIC plugin, against bytes built by the encoder it decodes with.

No MIDAS anywhere: the plugin duck-types the event, so these run on a machine
with no bindings installed -- which is where they run, since the box that has
MIDAS has no pytest and the box with pytest has no MIDAS.

The events here are built with ``sampic.encode_ad``, the same function
``tests/generate_adbank_cases.py`` uses to feed the browser decoder, so a layout
change breaks this and the JS test together rather than either alone.
"""

from __future__ import annotations

import numpy as np
import pytest

from mdqm.dqm import sampic
from mdqm.dqm.hist import HistStore
from mdqm.dqm.sampic_plugin import (PREFIX, PRESAMPLES, RecentByChannel,
                                    SampicPlugin)


class _Bank:
    def __init__(self, payload: bytes, numpy=True):
        self.data = np.frombuffer(payload, dtype=np.uint8) if numpy else tuple(payload)


class _Event:
    """Only what the plugin touches: a banks mapping."""

    def __init__(self, banks: dict):
        self.banks = banks


def _hit(channel=3, amplitude=-0.30, baseline=0.75, waveform=None, hit_number=1):
    if waveform is None:
        # Flat baseline with a negative-going dip, like the real thing.
        waveform = [baseline] * sampic.AD_MAX_SAMPLES
        for i in range(20, 26):
            waveform[i] = baseline + amplitude
    return {"channel": channel, "hit_number": hit_number, "amplitude": amplitude,
            "baseline": baseline, "peak": baseline + amplitude,
            "tot_value": sampic.TOT_ABSENT, "waveform": waveform}


def _event(hits, numpy=True):
    return _Event({sampic.AD_BANK: _Bank(sampic.encode_ad(hits), numpy=numpy)})


def _event_with_timing(hits, at_nhits=None, ac_total_hits=None, numpy=True):
    """An event carrying AT00 and AC00 as well, as a generated file does.

    `at_nhits` / `ac_total_hits` default to the truth; pass a different number
    to build the event a disagreeing DAQ would have produced.
    """
    n = len(hits)
    banks = {sampic.AD_BANK: _Bank(sampic.encode_ad(hits), numpy=numpy)}
    if at_nhits is not None:
        banks[sampic.AT_BANK] = _Bank(
            sampic.encode_at(1234, at_nhits, sp_total_us_sum=99), numpy=numpy)
    if ac_total_hits is not None:
        banks[sampic.AC_BANK] = _Bank(
            sampic.encode_ac(5678, 1, ac_total_hits, 2, 9, 2, 13), numpy=numpy)
    return _Event(banks), n


@pytest.fixture
def plugin():
    return SampicPlugin(HistStore())


# -- what it accepts ---------------------------------------------------------

def test_accepts_an_event_with_an_ad_bank(plugin):
    assert plugin.accepts(_event([_hit()]))


def test_rejects_an_event_without_one(plugin):
    """By bank, not by event id: the id is a frontend's choice."""
    assert not plugin.accepts(_Event({"AT00": _Bank(b"")}))
    assert not plugin.accepts(_Event({}))


# -- the histograms it publishes ---------------------------------------------

def test_publishes_exactly_its_documented_set(plugin):
    assert plugin.store.names() == sorted([
        f"{PREFIX}/amplitude", f"{PREFIX}/amplitude_by_channel",
        f"{PREFIX}/charge_vs_amplitude",
        f"{PREFIX}/hits_per_event", f"{PREFIX}/occupancy",
        f"{PREFIX}/persistence"])


def test_baseline_and_noise_are_series_and_not_histograms(plugin):
    """They answer "where is this channel now", which a run-long sum cannot.

    The split matters beyond taste: dqm::list and /DQM/<page>/Histograms are
    for histograms, so a series named there would be reported missing on a page
    where it is drawing.
    """
    for n in (f"{PREFIX}/baseline_by_channel", f"{PREFIX}/noise_by_channel"):
        assert plugin.store.get(n) is None, "must not be in the histogram store"
        assert n in plugin.recent
    assert plugin.series()["names"] == [
        f"{PREFIX}/baseline_by_channel", f"{PREFIX}/noise_by_channel"]


def test_a_series_keeps_every_value_inside_its_window(plugin):
    """No count cap. The cut is by time, and the page makes it on the axis.

    This used to keep the last ten per channel, which is a different amount of
    history on every channel -- ten values is seconds on a busy channel and
    minutes on a quiet one -- so the two ends of one plot were showing windows
    that differed by a factor of thirty.
    """
    n = 40
    for i in range(n):
        plugin.process(_event([_hit(channel=2, baseline=0.5 + 0.001 * i)]))

    pts = plugin.series(f"{PREFIX}/baseline_by_channel")
    on2 = [v for c, v in zip(pts["channel"], pts["value"]) if c == 2]
    assert len(on2) == n, "values were dropped inside the window"
    # Oldest first, which is what lets the page draw a polyline without sorting.
    assert on2[0] == round(0.5, 4)
    assert on2[-1] == round(0.5 + 0.001 * (n - 1), 4)


def test_a_series_drops_what_has_aged_out_of_its_window():
    """The cut itself, driven on an explicit clock rather than the wall."""
    r = RecentByChannel(8, horizon_s=60.0)
    r.add([3], [0.70], now=1000.0)
    r.add([3], [0.71], now=1030.0)
    r.add([3], [0.72], now=1080.0)      # this evicts the 1000.0 point

    pts = r.points(now=1080.0)
    assert pts["value"] == [0.71, 0.72], "the window did not slide"
    assert pts["age"] == [50.0, 0.0]


def test_a_series_ages_out_on_read_as_well_as_on_write():
    """A run that stops must not leave the page drawing a stale picture.

    Evicting only on add() would have a stopped run serving the same points
    forever, ageing but never leaving -- and the page would draw a minute-old
    picture on an axis labelled "seconds ago".
    """
    r = RecentByChannel(8, horizon_s=60.0)
    r.add([3], [0.70], now=1000.0)
    assert r.points(now=1030.0)["value"] == [0.70]
    assert r.points(now=1100.0)["value"] == [], "a stale point outlived its window"
    assert r.entries == 0


def test_a_series_reports_the_window_it_is_keeping():
    """The page says "the analyzer keeps N s", so N has to be on the wire."""
    r = RecentByChannel(8, horizon_s=90.0)
    assert r.points(now=0.0)["window_s"] == 90.0


def test_a_nonsense_window_does_not_throw_every_value_away():
    """A mistyped ODB key must not present as "the analyzer is not filling"."""
    r = RecentByChannel(8, horizon_s=0.0)
    r.add([1], [0.74], now=1000.0)
    assert r.points(now=1000.0)["value"] == [0.74]


def test_a_series_omits_a_channel_nothing_has_hit(plugin):
    """An unhit channel is not a channel sitting at 0 V."""
    plugin.process(_event([_hit(channel=9)]))
    pts = plugin.series(f"{PREFIX}/baseline_by_channel")
    assert set(pts["channel"]) == {9}


def test_a_series_reports_the_age_of_each_point(plugin):
    """Channels are hit at different rates, so the points are not one moment."""
    plugin.process(_event([_hit(channel=1)]))
    pts = plugin.series(f"{PREFIX}/baseline_by_channel")
    assert len(pts["age"]) == len(pts["value"])
    assert all(a >= 0.0 for a in pts["age"])


def test_publishes_no_time_over_threshold(plugin):
    """tot_value is the TOT_ABSENT sentinel in every hit of run 108.

    A histogram of it would be a spike at -1 ns that reads as a measurement.
    """
    assert not [n for n in plugin.store.names() if "tot" in n.lower()]


def test_publishes_no_time_between_hits(plugin):
    """time_instant is identical for hits in one event: they are coincident."""
    assert not [n for n in plugin.store.names() if "deltat" in n or "between" in n]


# -- filling -----------------------------------------------------------------

def test_one_event_fills_every_histogram(plugin):
    assert plugin.process(_event([_hit(channel=3), _hit(channel=7)]))

    occ = plugin.store.get(f"{PREFIX}/occupancy")
    assert occ.entries == 2
    # lo=0, hi=nch, one bin per channel: bin i+1 is channel i (0 is underflow).
    assert occ.counts[3 + 1] == 1 and occ.counts[7 + 1] == 1

    assert plugin.store.get(f"{PREFIX}/hits_per_event").entries == 1
    assert plugin.store.get(f"{PREFIX}/amplitude").entries == 2
    assert plugin.store.get(f"{PREFIX}/amplitude_by_channel").entries == 2
    assert plugin.recent[f"{PREFIX}/baseline_by_channel"].entries == 2
    assert plugin.recent[f"{PREFIX}/noise_by_channel"].entries == 2
    # Every sample of every hit.
    assert plugin.store.get(f"{PREFIX}/persistence").entries == 2 * sampic.AD_MAX_SAMPLES


def test_the_default_ranges_hold_real_looking_data(plugin):
    """The regression the corrected binning defaults exist for.

    With a range chosen for a differently shaped pulse every entry landed in
    under/overflow and the plot read as empty, so this asserts the edges stay
    clear, not merely that something was filled.
    """
    for ch in range(0, 12):
        plugin.process(_event([_hit(channel=ch, amplitude=-0.3 - 0.01 * ch)]))

    edges = plugin.status()["edge_fraction"]
    for name, fraction in edges.items():
        assert fraction == 0.0, f"{name} put {fraction:.2%} of its entries off-axis"


def test_hits_are_truncated_to_data_size_not_padded(plugin):
    """A short record must not contribute the zero tail to persistence."""
    plugin.process(_event([_hit(waveform=[0.75] * 20)]))
    assert plugin.store.get(f"{PREFIX}/persistence").entries == 20


def test_a_hit_too_short_to_measure_noise_is_skipped_not_guessed(plugin):
    plugin.process(_event([_hit(waveform=[0.75] * (PRESAMPLES - 1))]))
    assert plugin.recent[f"{PREFIX}/noise_by_channel"].entries == 0
    # ...but it still counts everywhere it can be counted.
    assert plugin.store.get(f"{PREFIX}/occupancy").entries == 1


def test_an_empty_bank_counts_the_event_and_fills_nothing(plugin):
    assert plugin.process(_event([]))
    assert plugin.store.get(f"{PREFIX}/hits_per_event").counts[0 + 1] == 1
    assert plugin.store.get(f"{PREFIX}/occupancy").entries == 0


def test_bank_data_as_a_plain_sequence_decodes_the_same(plugin):
    """use_numpy=True is what the analyzer asks for; not requiring it is free."""
    plugin.process(_event([_hit(channel=5)], numpy=False))
    assert plugin.store.get(f"{PREFIX}/occupancy").counts[5 + 1] == 1


# -- failure is reported, not raised -----------------------------------------

def test_a_bank_the_decoder_disagrees_with_is_counted_not_raised(plugin):
    """One malformed event must not take down the only live monitor."""
    bad = _Event({sampic.AD_BANK: _Bank(b"\x00" * (sampic.AD_HIT_BYTES + 1))})
    assert plugin.process(bad) is False
    assert plugin.bad_banks == 1
    assert "not a multiple" in plugin.status()["last_error"]
    # Still usable afterwards.
    assert plugin.process(_event([_hit()]))
    assert plugin.status()["events"] == 1


# -- the channel axis is global, not board-local -----------------------------

def test_channel_axis_separates_boards(plugin):
    """`channel` is board-local, so it is not unique across FE boards.

    Two hits that both report channel 5 on different boards are different
    readout channels and must not share an occupancy bin.
    """
    plugin.process(_event([_hit(channel=5), _hit(channel=5)]))
    occ = plugin.store.get(f"{PREFIX}/occupancy")
    assert occ.entries == 2

    plugin.reconfigure({}, {})          # reset
    b0 = {**_hit(channel=5), "fe_board_index": 0}
    b3 = {**_hit(channel=5), "fe_board_index": 3}
    plugin.process(_event([b0, b3]))
    counts = plugin.store.get(f"{PREFIX}/occupancy").counts
    populated = [i for i, c in enumerate(counts) if c]
    assert len(populated) == 2, "board 0 ch 5 and board 3 ch 5 shared a bin"


def test_decoded_hits_carry_the_global_channel(plugin):
    """The decoder derives it, so a consumer does not have to know the rule."""
    raw = sampic.encode_ad([{**_hit(channel=5), "fe_board_index": 3}])
    got = sampic.decode_ad(raw)[0]
    assert got["channel"] == 5, "the hardware number is unchanged"
    assert got["global_channel"] == 3 * sampic.CHANNELS_PER_BOARD + 5


def test_channel_axis_is_board_local_index_when_there_is_one_board():
    """A single-board recording is unchanged: board 0 means index == channel."""
    from mdqm.dqm.sampic_plugin import _global_channel
    assert _global_channel({"channel": 5}) == 5.0
    assert _global_channel({"fe_board_index": 0, "channel": 5}) == 5.0
    assert _global_channel({"fe_board_index": 3, "channel": 5}) == 197.0


# -- charge against amplitude ------------------------------------------------

def _only_cell(h):
    """(x value, y value) at the centre of the one filled cell.

    counts is (ny + 2, nx + 2) with the under- and overflow cells at the ends,
    so a bin index i on an axis is column/row i, and its centre sits half a bin
    above the low edge of that bin.
    """
    filled = np.argwhere(h.counts)
    assert len(filled) == 1, f"expected one filled cell, got {len(filled)}"
    iy, ix = (int(v) for v in filled[0])

    def centre(axis, i):
        return axis.lo + (i - 0.5) * (axis.hi - axis.lo) / axis.n
    return centre(h.x, ix), centre(h.y, iy)


def test_charge_is_the_integral_the_scope_tab_takes(plugin):
    """The same number, by the same rule, as pages/js/dqm-scope.js chargeOf().

    Two tiles showing "charge" from one definition held in two languages is a
    thing that drifts silently, and the failure is a Trends plot that disagrees
    with the event in front of you. So the arithmetic is pinned here rather
    than left to agree by inspection: baseline minus sample, summed over the
    whole record, no window and no sample period applied.
    """
    baseline, amplitude = 0.75, -0.30
    hit = _hit(amplitude=amplitude, baseline=baseline)
    plugin.process(_event([hit]))

    h = plugin.store.get(f"{PREFIX}/charge_vs_amplitude")
    assert h.entries == 1
    # Six samples of the dip, each `amplitude` below the baseline; the rest sit
    # exactly on it and contribute nothing.
    expected = sum(baseline - v for v in hit["waveform"])
    assert expected == pytest.approx(-6 * amplitude)

    x, y = _only_cell(h)
    xw = (h.x.hi - h.x.lo) / h.x.n
    yw = (h.y.hi - h.y.lo) / h.y.n
    # Amplitude on x and charge on y, which is also the assertion that catches
    # the axes being handed to fill() the wrong way round -- they are far
    # enough apart here that a swap cannot land inside a bin.
    assert x == pytest.approx(amplitude, abs=xw)
    assert y == pytest.approx(expected, abs=yw)


def test_charge_is_signed_because_polarity_is_not_ours_to_choose(plugin):
    """A positive-going pulse integrates negative, and must still be counted.

    Not hypothetical: run 108 integrates negative on 99.5% of its hits and a
    demonstrator recording positive on nearly all of its, which is why the axis
    is symmetric rather than fitted to whichever file was open at the time.
    """
    # +0.15 and not +0.30: the amplitude axis stops at +0.2, and a hit off the
    # end of it would prove the overflow works rather than anything about sign.
    hit = _hit(amplitude=+0.15, baseline=0.40)
    plugin.process(_event([hit]))

    h = plugin.store.get(f"{PREFIX}/charge_vs_amplitude")
    assert h.entries == 1
    assert plugin.status()["edge_fraction"][f"{PREFIX}/charge_vs_amplitude"] == 0.0, \
        "a positive-going pulse fell off the axis"
    _, y = _only_cell(h)
    assert y < 0, "a pulse the other way round was not counted below zero"


def test_a_hit_with_no_waveform_has_no_charge(plugin):
    """Nothing to integrate is not a charge of zero, which is a real value."""
    plugin.process(_event([_hit(waveform=[])]))
    assert plugin.store.get(f"{PREFIX}/charge_vs_amplitude").entries == 0


# -- rebinning ---------------------------------------------------------------

def test_reconfigure_rebuilds_and_therefore_resets(plugin):
    plugin.process(_event([_hit()]))
    assert plugin.store.get(f"{PREFIX}/occupancy").entries == 1

    plugin.reconfigure({}, {**SampicPlugin.DEFAULT_BINNING, "channels": 64})
    occ = plugin.store.get(f"{PREFIX}/occupancy")
    assert occ.x.n == 64
    assert occ.entries == 0, "a histogram with different bins is a different histogram"
    assert len(plugin.store) == 6, "rebuilt in place, not added alongside"
    assert plugin.recent[f"{PREFIX}/baseline_by_channel"].nch == 64
    assert plugin.recent[f"{PREFIX}/baseline_by_channel"].entries == 0, \
        "a ring of a different width is a different ring"


def test_reconfigure_falls_back_for_a_key_an_operator_deleted(plugin):
    """settings.read never raises; neither may this."""
    plugin.reconfigure({}, {"channels": 8})
    assert plugin.store.get(f"{PREFIX}/occupancy").x.n == 8
    assert plugin.store.get(f"{PREFIX}/amplitude").x.n == \
        SampicPlugin.DEFAULT_BINNING["amplitude bins"]


def test_status_reports_what_it_decoded(plugin):
    plugin.process(_event([_hit(), _hit(channel=9)]))
    plugin.process(_event([_hit()]))
    status = plugin.status()
    assert status["plugin"] == "sampic"
    assert (status["events"], status["hits"]) == (2, 3)
    assert status["hits_per_event"] == 1.5


# -- three statements of one number ------------------------------------------

def test_timing_banks_agreeing_are_counted_as_seen(plugin):
    ev, n = _event_with_timing([_hit(), _hit(channel=9)], at_nhits=2, ac_total_hits=2)
    assert plugin.process(ev)
    st = plugin.status()
    assert st["timing_seen"] == 1 and st["timing_mismatches"] == 0
    assert st["collector_seen"] == 1 and st["collector_mismatches"] == 0
    assert st["last_mismatch"] == ""


def test_a_collector_disagreeing_with_the_banks_is_counted(plugin):
    """AC00 says one thing, AD00 carries another: the event was built wrong."""
    ev, n = _event_with_timing([_hit(), _hit(channel=9)], ac_total_hits=99)
    assert plugin.process(ev), "the hits are still real and still get filled"
    st = plugin.status()
    assert st["collector_seen"] == 1
    assert st["collector_mismatches"] == 1
    assert "99" in st["last_mismatch"] and "AC00" in st["last_mismatch"]
    # Counted, not dropped: an analyzer hiding the event would hide the fault.
    assert st["events"] == 1 and st["hits"] == 2
    assert plugin.store.get(f"{PREFIX}/occupancy").entries == 2


def test_a_frontend_disagreeing_with_the_banks_is_counted(plugin):
    ev, n = _event_with_timing([_hit()], at_nhits=7)
    assert plugin.process(ev)
    st = plugin.status()
    assert st["timing_mismatches"] == 1 and st["collector_seen"] == 0
    assert "AT00" in st["last_mismatch"]


def test_an_absent_collector_bank_is_not_a_disagreement(plugin):
    """Only generated files carry AC00; a repackaged recording has none."""
    plugin.process(_event([_hit()]))
    st = plugin.status()
    assert st["collector_seen"] == 0, "a bank that is not there was counted as checked"
    assert st["collector_mismatches"] == 0
    assert st["bad_banks"] == 0


def test_a_malformed_timing_bank_counts_as_a_bad_bank(plugin):
    ev = _Event({sampic.AD_BANK: _Bank(sampic.encode_ad([_hit()])),
                 sampic.AC_BANK: _Bank(b"\x00" * 12)})
    assert plugin.process(ev), "a broken AC00 must not lose the hits"
    st = plugin.status()
    assert st["bad_banks"] == 1
    assert "AC00" in st["last_error"]
    assert st["collector_seen"] == 0
    assert st["hits"] == 1


# ---------------------------------------------------------------------------
# The rolling window on persistence and amplitude by channel
# ---------------------------------------------------------------------------

def test_the_rolling_plots_are_capped_and_the_rest_are_not(plugin):
    """Only the two plots a shifter reads as "now" roll."""
    rolling = [n for n in plugin.store.names()
               if hasattr(plugin.store.get(n), "set_cap")]
    assert rolling == [f"{PREFIX}/amplitude_by_channel", f"{PREFIX}/persistence"]


def test_a_rolling_plot_forgets_events_past_its_cap(plugin):
    """The point of the cap: an old event must stop counting."""
    plugin.set_window({"amplitude by channel events": 10})
    amp = plugin.store.get(f"{PREFIX}/amplitude_by_channel")

    for _ in range(200):
        plugin.process(_event([_hit(channel=3)]))

    # One hit an event, so entries would be 200 if it accumulated for the run.
    assert amp.entries <= 10, "the cap is a ceiling, not a suggestion"
    assert amp.entries >= 5, "and it must never fall below half a window"
    assert amp.window_events == amp.entries


def test_an_empty_event_still_advances_the_window(plugin):
    """Otherwise a quiet run silently looks further back than a busy one."""
    plugin.set_window({"persistence events": 10})
    pers = plugin.store.get(f"{PREFIX}/persistence")
    before = pers.swaps
    for _ in range(20):
        plugin.process(_event([]))
    assert pers.swaps > before


def test_changing_the_cap_does_not_reset_the_plot(plugin):
    """A cap says how far back to look, not what shape to be.

    Rebuilding on a cap change would empty the plot under whoever was reading
    it, which is the thing a shifter nudging a number would least expect.
    """
    plugin.set_window({"amplitude by channel events": 1000})
    for _ in range(20):
        plugin.process(_event([_hit(channel=3)]))
    amp = plugin.store.get(f"{PREFIX}/amplitude_by_channel")
    assert amp.entries == 20

    plugin.set_window({"amplitude by channel events": 900})
    assert plugin.store.get(f"{PREFIX}/amplitude_by_channel") is amp, "not rebuilt"
    assert amp.entries == 20, "and not cleared"
    assert amp.cap == 900


def test_the_metadata_reports_the_real_count_and_the_cap(plugin):
    """They differ by up to a factor of two, so the page is told both."""
    plugin.set_window({"persistence events": 100})
    for _ in range(10):
        plugin.process(_event([_hit()]))
    meta = plugin.store.get(f"{PREFIX}/persistence").metadata()
    assert meta["rolling"] is True
    assert meta["cap"] == 100
    assert meta["window"] == 10
