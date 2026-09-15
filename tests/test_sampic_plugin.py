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
from mdqm.dqm.sampic_plugin import PREFIX, PRESAMPLES, SampicPlugin


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


def test_a_series_keeps_only_the_last_n_on_each_channel(plugin):
    depth = int(SampicPlugin.DEFAULT_BINNING["recent per channel"])
    for i in range(depth + 5):
        plugin.process(_event([_hit(channel=2, baseline=0.5 + 0.01 * i)]))

    pts = plugin.series(f"{PREFIX}/baseline_by_channel")
    on2 = [v for c, v in zip(pts["channel"], pts["value"]) if c == 2]
    assert len(on2) == depth, "the ring must not grow past its depth"
    # Oldest first, and the five earliest values are gone rather than the five
    # latest -- the failure a ring written backwards would give.
    assert on2[-1] == round(0.5 + 0.01 * (depth + 4), 4)
    assert on2[0] == round(0.5 + 0.01 * 5, 4)


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


# -- rebinning ---------------------------------------------------------------

def test_reconfigure_rebuilds_and_therefore_resets(plugin):
    plugin.process(_event([_hit()]))
    assert plugin.store.get(f"{PREFIX}/occupancy").entries == 1

    plugin.reconfigure({}, {**SampicPlugin.DEFAULT_BINNING, "channels": 64})
    occ = plugin.store.get(f"{PREFIX}/occupancy")
    assert occ.x.n == 64
    assert occ.entries == 0, "a histogram with different bins is a different histogram"
    assert len(plugin.store) == 5, "rebuilt in place, not added alongside"
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
