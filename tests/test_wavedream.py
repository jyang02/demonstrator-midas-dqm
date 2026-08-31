"""The ported physics, against real events.

These algorithms and their constants existed only in the retired C++ plugin.
Porting them is the risky part of this migration: a subtly different amplitude
or phase produces plots that look entirely reasonable and mean something else.
So the tests pin the behaviour on synthetic pulses where the right answer is
known by construction, and then check the whole set runs over real events.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

from mdqm.dqm.hist import HistStore
from mdqm.plugins.wavedream import (
    MIN_RF_CROSSINGS,
    WaveDreamPlugin,
    leading_edge,
    rf_phase,
    rising_crossings,
)

REPO = Path(__file__).resolve().parents[1]
RUN_FILE = Path("/home/pioneer/josh/wavedream-scalar-readout/output/midas/run00201.mid.lz4")


# --- rising_crossings --------------------------------------------------------

def test_rising_crossings_finds_one_per_period_of_a_sine():
    n, period = 1024, 40.0
    v = np.sin(2 * np.pi * np.arange(n) / period)
    c = rising_crossings(v)
    assert len(c) == pytest.approx(n / period, abs=1)
    # Interpolated, so the spacing recovers the period closely.
    assert np.mean(np.diff(c)) == pytest.approx(period, rel=1e-3)


def test_rising_crossings_interpolates_rather_than_rounding():
    # Mean is 0, so the deviations are the values themselves. The upward
    # crossing lies between index 1 (-1) and index 2 (+3) -- a quarter of the
    # way along, not half, which is what distinguishes interpolation from
    # rounding to the nearest sample.
    v = np.array([-2.0, -1.0, 3.0, 0.0])
    assert np.mean(v) == 0.0
    c = rising_crossings(v)
    assert len(c) == 1
    assert c[0] == pytest.approx(1.25, abs=1e-9)


def test_rising_crossings_needs_a_few_samples():
    assert rising_crossings(np.array([1.0, 2.0])).size == 0


# --- leading_edge ------------------------------------------------------------

def _pulse(n=1024, start=300, width=20, amp=0.5, baseline=0.0):
    """A negative-going triangular pulse on a flat baseline."""
    v = np.full(n, baseline, dtype=np.float64)
    rise = np.linspace(0, -amp, width)
    v[start:start + width] += rise
    v[start + width:start + 2 * width] += rise[::-1]
    return v


def test_leading_edge_recovers_amplitude_and_the_half_height_time():
    v = _pulse(amp=0.4, start=300, width=20)
    p = leading_edge(v)
    assert p is not None and p.valid
    assert p.baseline == pytest.approx(0.0, abs=1e-12)
    assert p.amplitude == pytest.approx(0.4, rel=1e-6)
    # Half height on a linear ramp from 300 to 319 is halfway along it.
    assert p.time == pytest.approx(300 + 19 / 2, abs=0.6)


def test_leading_edge_follows_a_shifted_baseline():
    v = _pulse(amp=0.3, baseline=-0.15)
    p = leading_edge(v)
    assert p.baseline == pytest.approx(-0.15, abs=1e-12)
    assert p.amplitude == pytest.approx(0.3, rel=1e-6)


def test_leading_edge_searches_backwards_from_the_minimum():
    """Ringing after the pulse must not be mistaken for the edge."""
    v = _pulse(amp=0.5, start=300, width=20)
    v[400:420] -= 0.30                       # a second, smaller dip afterwards
    p = leading_edge(v)
    assert p.valid
    assert 295 < p.time < 325, f"found the edge at {p.time}, not on the real pulse"


def test_leading_edge_reports_no_time_when_the_minimum_is_first():
    v = np.linspace(-1.0, 0.0, 300)          # minimum at index 0
    p = leading_edge(v, baseline_samples=10)
    assert p is not None
    assert not p.valid, "there is no rising edge in the record to measure"


def test_leading_edge_declines_a_record_shorter_than_its_baseline():
    assert leading_edge(np.zeros(50), baseline_samples=100) is None


# --- rf_phase ----------------------------------------------------------------

def _rf(n=1024, period=40.0, phase=0.0, amp=1.0):
    return amp * np.sin(2 * np.pi * (np.arange(n) / period) + phase)


def test_rf_phase_measures_a_known_delay():
    period = 40.0
    rf = _rf(period=period)
    crossings = rising_crossings(rf)

    # Put the pulse an exact quarter period after the first RF crossing.
    edge = crossings[0] + period / 4
    s1 = _pulse(start=int(round(edge)), width=2, amp=0.5)

    r = rf_phase(s1, rf)
    assert r.valid, r.reason
    assert r.period_samples == pytest.approx(period, rel=1e-3)
    assert r.phase_deg == pytest.approx(90.0, abs=15.0)


def test_rf_phase_is_periodic_in_360():
    period = 40.0
    rf = _rf(period=period)
    c0 = rising_crossings(rf)[0]
    a = rf_phase(_pulse(start=int(c0 + period / 2), width=2), rf)
    b = rf_phase(_pulse(start=int(c0 + period / 2 + period), width=2), rf)
    assert a.valid and b.valid
    assert a.phase_deg == pytest.approx(b.phase_deg, abs=15.0)


@pytest.mark.parametrize("case,expect", [
    ("flat_rf", "peak-to-peak"),
    ("few_crossings", "crossings"),
    ("jittery", "jitter"),
    ("tiny_s1", "amplitude"),
])
def test_rf_phase_says_why_it_rejected(case, expect):
    """A silently empty plot cannot tell you whether the RF or the S1 is at fault."""
    rf = _rf()
    s1 = _pulse(amp=0.5, start=300, width=2)

    if case == "flat_rf":
        rf = np.zeros(1024)
    elif case == "few_crossings":
        rf = _rf(period=400.0)               # only ~2 crossings in the record
    elif case == "jittery":
        rf = np.concatenate([_rf(300, period=10.0), _rf(724, period=60.0)])
    elif case == "tiny_s1":
        s1 = _pulse(amp=0.001, start=300, width=2)

    r = rf_phase(s1, rf)
    assert not r.valid
    assert expect in r.reason, f"expected {expect!r} in {r.reason!r}"


def test_rf_phase_crossing_threshold_matches_the_ported_constant():
    assert MIN_RF_CROSSINGS == 5, "changing this changes which events are accepted"


# --- the plugin over real events --------------------------------------------

@pytest.mark.skipif(not RUN_FILE.exists(), reason="no run file on this machine")
def test_plugin_fills_every_plot_from_a_real_run():
    sys.path.insert(0, "/home/pioneer/josh/wavedream-scalar-readout/analysis")
    import midas.file_reader

    store = HistStore()
    plugin = WaveDreamPlugin(store, roles={"waveform channels": [0, 1, 2, 3, 4],
                                           "s1 channel": 0, "rf channel": 5})

    n = 0
    for event in midas.file_reader.MidasFile(str(RUN_FILE)):
        if not plugin.accepts(event):
            continue
        if plugin.process(event, run_number=201):
            n += 1
        if n >= 150:
            break

    assert n >= 100, f"only decoded {n} events"
    assert plugin.decoded == n
    assert plugin.widths is not None, "the run's first event carries the DRS table"

    pers = store.get("wd/persistence_ch00")
    assert pers.entries == n * 1024, "every sample of every event belongs in persistence"
    assert pers.counts.sum() > 0

    amp = store.get("wd/amplitude_ch00")
    assert amp.entries == n

    dt = store.get("wd/deltat")
    assert dt.entries == n - 1, "one gap per consecutive pair"

    # The RF plots may legitimately be empty on a given run, but the plugin must
    # be able to say why rather than leaving it a mystery.
    rf = store.get("wd/rf_phase")
    assert rf.entries > 0 or plugin.rf_rejections, \
        "an empty RF plot with no recorded reason is not a usable diagnosis"


@pytest.mark.skipif(not RUN_FILE.exists(), reason="no run file on this machine")
def test_every_histogram_encodes_and_decodes():
    from mdqm.dqm import framing

    store = HistStore()
    WaveDreamPlugin(store)
    for name in store.names():
        h = store.get(name)
        decoded = framing.decode_histogram(h.encode())
        assert decoded["counts"].shape == h.counts.shape, name


def test_a_new_run_drops_the_previous_run_s_calibration():
    """A calibration from another run is not this run's, and must not be reused."""
    store = HistStore()
    plugin = WaveDreamPlugin(store)
    plugin.widths = {0: np.ones(1024)}
    plugin.widths_from_run = 200

    class _Fake:
        class header:
            event_id = 999          # not a waveform event; process returns early
    plugin.process(_Fake(), run_number=201)

    assert plugin.widths is None
    assert plugin.widths_from_run == 201


def test_delta_t_rebaselines_when_the_counter_is_zeroed():
    """ticks going backwards means a run started, not that time ran backwards."""
    store = HistStore()
    plugin = WaveDreamPlugin(store)

    class _F:
        timestamp_ticks = 0
    f = _F()

    f.timestamp_ticks = 1_000_000
    plugin._fill_deltat(f)
    f.timestamp_ticks = 1_800_000
    plugin._fill_deltat(f)
    assert store.get("wd/deltat").entries == 1

    f.timestamp_ticks = 500          # counter zeroed
    plugin._fill_deltat(f)
    assert store.get("wd/deltat").entries == 1, "no nonsense gap was filled"

    f.timestamp_ticks = 8_000_500
    plugin._fill_deltat(f)
    assert store.get("wd/deltat").entries == 2, "and it carries on from the new baseline"


# --- the scope frame ---------------------------------------------------------

@pytest.mark.skipif(not RUN_FILE.exists(), reason="no run file on this machine")
def test_the_scope_frame_carries_traces_and_their_own_derived_values():
    """One reply, so the numbers on screen belong to the traces on screen."""
    import midas.file_reader

    from mdqm.dqm import framing

    store = HistStore()
    plugin = WaveDreamPlugin(store, roles={"waveform channels": [0, 1, 2, 3, 4],
                                           "s1 channel": 0, "rf channel": 5})
    assert plugin.scope_frame() is None, "no event yet means no frame, not an empty one"

    n = 0
    for event in midas.file_reader.MidasFile(str(RUN_FILE)):
        if plugin.accepts(event) and plugin.process(event, run_number=201):
            n += 1
        if n >= 3:
            break

    blob = plugin.scope_frame(run_active=True)
    assert blob is not None
    frame = framing.decode_scope_frame(blob)

    assert frame["run_number"] == 201
    assert frame["board_id"] == 36
    assert frame["run_active"] is True
    assert frame["have_widths"] is True, "the run's first event carried the table"
    assert len(frame["channels"]) == 16
    assert frame["nominal_ps"] > 0, "needed for the uniform-ns axis"

    ch0 = frame["channels"][0]
    assert ch0["decoded"] is True
    assert len(ch0["samples"]) == 1024
    # Per-channel amplitudes ride along, so the page never re-derives them and
    # cannot disagree with the histograms.
    assert "amp_ch00" in frame["derived"]


@pytest.mark.skipif(not RUN_FILE.exists(), reason="no run file on this machine")
def test_the_adc_counts_survive_the_round_trip_exactly():
    """decode_drsv divides by 1e4; the frame multiplies back and rounds.

    The claim being tested is about the *integers*: an int16 is exactly
    representable in float32, so the division is the only rounding and rounding
    back undoes it. If that failed, the display would disagree with the analysis
    by a least-significant ADC count, silently.

    The volts themselves cannot agree exactly and are not expected to: the
    originals are float32 and the scale is a float32 of 1e-4
    (9.99999974e-05), so the reconstruction differs by a few times 1e-8 V --
    about 0.0003 of one ADC count. Asserting equality there would be asserting
    something untrue about floating point.
    """
    import midas.file_reader

    from mdqm.dqm import framing

    store = HistStore()
    plugin = WaveDreamPlugin(store)
    for event in midas.file_reader.MidasFile(str(RUN_FILE)):
        if plugin.accepts(event) and plugin.process(event, run_number=201):
            break

    frame = framing.decode_scope_frame(plugin.scope_frame())
    checked = 0
    for ch in frame["channels"]:
        if not ch["decoded"]:
            continue
        original = np.asarray(plugin.frame.waveforms[ch["channel"]], dtype=np.float64)
        # What the integers should have been, straight from the original volts.
        expected_counts = np.rint(original / 1e-4).astype(np.int64)
        assert np.array_equal(ch["samples"].astype(np.int64), expected_counts), \
            f"channel {ch['channel']}: ADC counts changed"
        # And the volts agree to well within one count.
        recovered = ch["samples"].astype(np.float64) * ch["scale"]
        assert np.max(np.abs(recovered - original)) < 1e-6, \
            f"channel {ch['channel']}: volts drifted by more than 1% of a count"
        checked += 1
    assert checked == 16


def test_an_undecodable_channel_is_carried_through_not_dropped():
    """Silently omitting it would make the panel vanish with no explanation."""
    from mdqm.dqm import framing

    blob = framing.encode_scope_frame([
        {"channel": 0, "first_bin": 0, "samples": np.zeros(8, dtype=np.int16)},
        {"channel": 1, "first_bin": 3, "samples": None, "encoding": 11},
    ])
    frame = framing.decode_scope_frame(blob)
    assert len(frame["channels"]) == 2
    assert frame["channels"][1]["decoded"] is False
    assert frame["channels"][1]["encoding"] == 11
    assert frame["channels"][1]["first_bin"] == 3, "metadata survives even with no samples"
