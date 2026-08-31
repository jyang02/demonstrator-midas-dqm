"""The analyzer's safety properties.

A monitoring process must never be able to affect data taking, and the ways it
could are specific and few: back-pressuring the event buffer, sitting in the run
transition path, or doing unbounded work. Each gets an assertion here, because
each is a one-word edit away.
"""

from __future__ import annotations

import inspect
import time

from mdqm.dqm import analyzer as A
from mdqm.dqm.hist import HistStore


class _FakePlugin:
    name = "fake"
    event_ids = frozenset({401})

    def __init__(self, store):
        self.store = store
        self.processed = []
        self.runs = []

    def accepts(self, event):
        return event.header.event_id in self.event_ids

    def process(self, event, run_number=None):
        self.processed.append(event)
        self.runs.append(run_number)
        return True

    def status(self):
        return {"plugin": self.name, "decoded": len(self.processed)}


class _Event:
    def __init__(self, event_id=401):
        self.header = type("H", (), {"event_id": event_id})()


class _FakeClient:
    def __init__(self, odb=None, dropped_series=None):
        self.odb = odb or {"/Runinfo/State": 1, "/Runinfo/Run number": 7}
        self.events = []
        self.messages = []
        self.requests = []
        self._dropped = list(dropped_series or [])

    def odb_get(self, path):
        if path == A.DROPPED_PATH and self._dropped:
            return self._dropped.pop(0)
        return self.odb[path]

    def receive_event(self, buf, async_flag=True):
        return self.events.pop(0) if self.events else None

    def msg(self, text, is_error=False):
        self.messages.append(text)

    def register_event_request(self, buf, event_id=-1, trigger_mask=-1, sampling_type=None):
        self.requests.append(sampling_type)


def _analyzer(rate=1000.0):
    return A.Analyzer(lambda store: _FakePlugin(store), rate=rate)


# --- the three ways this could hurt the DAQ ---------------------------------

def test_the_event_request_is_non_blocking():
    """GET_ALL would let a slow monitor stall the frontend producing the data."""
    import midas

    src = inspect.getsource(A.main)
    # Check what is passed, not what is mentioned: the source says "never
    # GET_ALL" in a comment, and a bare substring test matches that too.
    assert "sampling_type=midas.GET_NONBLOCKING" in src
    assert "sampling_type=midas.GET_ALL" not in src, \
        "one word between a monitor and a throttle"
    assert "GET_RECENT" not in src.replace("# ", ""), "GET_RECENT would drop events silently"
    assert midas.GET_NONBLOCKING != midas.GET_ALL


def test_no_transition_callbacks_or_equipment_are_registered():
    """Either would put this client in the run-transition path.

    That is exactly how the retired publisher could delay a run start: it
    registered TR_START at sequence 100, so a wedged process held up every run
    until the watchdog reaped it.
    """
    src = inspect.getsource(A)
    for forbidden in ("register_transition_callback", "register_transition",
                      "EquipmentBase", "midas.frontend"):
        assert forbidden not in src, f"{forbidden} puts us in the transition path"
    # Run state is polled instead.
    assert "/Runinfo/State" in src


def test_run_state_is_polled_not_hooked():
    a = _analyzer()
    client = _FakeClient({"/Runinfo/State": 3, "/Runinfo/Run number": 42})
    a.poll_run_state(client)
    assert a.run_number == 42
    assert a.run_state == 3
    assert a.status()["run_active"] is True


# --- sampling ----------------------------------------------------------------

def test_the_buffer_is_drained_even_when_sampling_is_refused():
    """Draining is free with GET_NONBLOCKING and keeps the read pointer current."""
    a = _analyzer(rate=0.0)                 # refuse everything
    client = _FakeClient()
    client.events = [_Event() for _ in range(25)]

    drained = a.run_once(client, buf=None)

    assert drained == 25, "every event must be taken off the buffer"
    assert a.seen == 25
    assert a.processed == 0, "and none of them decoded"


def test_the_token_bucket_limits_the_decode_rate():
    bucket = A.TokenBucket(rate=5.0)
    taken = sum(1 for _ in range(100) if bucket.take())
    assert taken <= 6, f"took {taken} in one instant from a 5/s bucket"


def test_the_token_bucket_refills_over_time():
    bucket = A.TokenBucket(rate=50.0)
    while bucket.take():
        pass
    time.sleep(0.1)
    assert bucket.take(), "should have refilled after 100 ms at 50/s"


def test_events_from_other_equipment_are_ignored_cheaply():
    a = _analyzer()
    client = _FakeClient()
    client.events = [_Event(event_id=410) for _ in range(10)]
    a.run_once(client, buf=None)
    assert a.seen == 10
    assert a.processed == 0


# --- the self-throttle -------------------------------------------------------

def test_dropped_packets_halve_the_rate_and_say_so():
    a = _analyzer(rate=20.0)
    client = _FakeClient(dropped_series=[0, 5])

    a.check_daq_health(client)              # establishes the baseline
    assert a.bucket.rate == 20.0
    a.check_daq_health(client)              # 5 packets lost since

    assert a.bucket.rate == 10.0
    assert a.status()["throttled"] is True
    assert client.messages, "a silent throttle is not a diagnosis"
    assert "dropped 5 packets" in client.messages[0]


def test_the_throttle_bottoms_out_at_zero_rather_than_oscillating():
    a = _analyzer(rate=2.0)
    client = _FakeClient(dropped_series=[0, 1, 2, 3, 4, 5])
    for _ in range(6):
        a.check_daq_health(client)
    assert a.bucket.rate == 0.0
    # Still drains, still serves; it just stops decoding.
    client.events = [_Event() for _ in range(3)]
    assert a.run_once(client, buf=None) == 3
    assert a.processed == 0


def test_the_rate_is_never_restored_automatically():
    """Recovering throughput is an operator decision, not the monitor's."""
    a = _analyzer(rate=20.0)
    client = _FakeClient(dropped_series=[0, 1, 1, 1, 1])
    for _ in range(5):
        a.check_daq_health(client)
    assert a.bucket.rate == 10.0, "no further drops, but no automatic recovery either"


def test_a_missing_dropped_counter_is_not_an_error():
    """Not every experiment has this equipment; absence must not break us."""
    a = _analyzer()
    class _NoCounter(_FakeClient):
        def odb_get(self, path):
            if path == A.DROPPED_PATH:
                raise KeyError(path)
            return super().odb_get(path)
    a.check_daq_health(_NoCounter())
    assert a.bucket.rate == a.configured_rate


# --- surviving a MIDAS restart ----------------------------------------------

def test_the_histogram_store_is_created_outside_the_connection_loop():
    """A reconnect must not reset the plots someone is watching."""
    src = inspect.getsource(A.main)
    store_line = src.index("Analyzer(make_plugin_factory")
    loop_line = src.index("while not _stop:")
    assert store_line < loop_line, "the analyzer must outlive any one connection"


def test_the_client_is_used_as_a_context_manager():
    """client.py:186-196: disconnect() frees RPC *server* state that
    cm_disconnect_experiment() alone does not, and without it the second
    register_brpc_callback after a reconnect trips over what is left."""
    src = inspect.getsource(A.main)
    assert "with midas.client.MidasClient(" in src


def test_state_that_should_survive_a_reconnect_does():
    a = _analyzer()
    client = _FakeClient()
    client.events = [_Event() for _ in range(4)]
    a.run_once(client, buf=None)
    before = a.processed

    a.reconnects += 1                       # as the loop would on a failure
    client.events = [_Event() for _ in range(3)]
    a.run_once(client, buf=None)

    assert a.processed == before + 3, "counters and histograms carry across"
    # The plugin keeps filling the same store object rather than a fresh one,
    # which is what makes a MIDAS bounce invisible on the page.
    assert a.plugin.store is a.store
    assert isinstance(a.store, HistStore)


# --- the brpc callback -------------------------------------------------------

def test_serve_returns_bytes_the_page_can_read():
    a = _analyzer()
    status, buf = a.serve(None, "dqm::list", "", 65536)
    assert status == 1
    assert bytes(buf)[:8], "an 8-byte envelope at minimum"


def test_serve_truncates_rather_than_failing_when_the_buffer_is_small():
    """The page reads the true size from the header and retries bigger."""
    a = _analyzer()
    _status, buf = a.serve(None, "dqm::list", "", 4)
    assert len(bytes(buf)) <= 4


def test_serve_never_raises_into_the_rpc_thread():
    a = _analyzer()
    status, buf = a.serve(None, "dqm::histogram", "does-not-exist", 65536)
    assert status == 1
    assert b"no such histogram" in bytes(buf)


def test_an_unknown_namespace_is_left_for_another_handler():
    a = _analyzer()
    _status, buf = a.serve(None, "someoneelse::cmd", "", 65536)
    assert bytes(buf) == b""


# --- run transitions ---------------------------------------------------------

def test_a_new_run_clears_what_asked_to_be_cleared():
    from mdqm.dqm.hist import Axis, Hist1D

    a = _analyzer()
    keep = a.store.add(Hist1D("keep", Axis(4, 0, 1)))
    keep.clear_on_run_start = False
    drop = a.store.add(Hist1D("drop", Axis(4, 0, 1)))
    keep.fill([0.5])
    drop.fill([0.5])

    client = _FakeClient({"/Runinfo/State": 1, "/Runinfo/Run number": 7})
    a.poll_run_state(client)                       # first sight: no clear
    assert drop.entries == 1

    client.odb["/Runinfo/Run number"] = 8
    a.poll_run_state(client)

    assert drop.entries == 0, "run-start histograms reset"
    assert keep.entries == 1, "persistent ones do not"


def test_the_first_run_number_seen_does_not_clear():
    """Starting the analyzer mid-run must not wipe a page someone is reading."""
    from mdqm.dqm.hist import Axis, Hist1D

    a = _analyzer()
    h = a.store.add(Hist1D("h", Axis(4, 0, 1)))
    h.fill([0.5])
    a.poll_run_state(_FakeClient({"/Runinfo/State": 3, "/Runinfo/Run number": 99}))
    assert h.entries == 1


# --- live configuration ------------------------------------------------------

class _SettingsClient(_FakeClient):
    """A fake ODB that supports the settings tree."""

    def __init__(self, values=None):
        super().__init__()
        self.tree = dict(values or {})
        self.messages = []

    def odb_exists(self, path):
        return path in self.tree

    def odb_get(self, path):
        if path in self.tree:
            return self.tree[path]
        return super().odb_get(path)

    def odb_set(self, path, value):
        self.tree[path] = value


def _seeded_client(**overrides):
    from mdqm.dqm import settings as S

    c = _SettingsClient()
    S.seed(c)
    for k, v in overrides.items():
        c.tree[f"{S.ROOT}/{k}"] = v
    return c


def test_settings_are_seeded_once_and_not_overwritten():
    from mdqm.dqm import settings as S

    c = _SettingsClient()
    created = S.seed(c)
    assert created > 0
    c.tree[f"{S.ROOT}/Binning/persistence x bins"] = 999      # operator edit

    assert S.seed(c) == 0, "a second seed must create nothing"
    assert c.tree[f"{S.ROOT}/Binning/persistence x bins"] == 999, \
        "seeding must never overwrite what an operator changed"


def test_the_odb_is_the_authority_for_binning():
    a = _analyzer(rate=20.0)
    c = _seeded_client(**{"Binning/persistence x bins": 64,
                          "Binning/persistence y bins": 20})
    a.apply_settings(c, force=True)
    assert a.settings["Binning"]["persistence x bins"] == 64


def test_changing_the_binning_rebuilds_the_histograms():
    """A histogram with different bins is a different histogram."""
    from mdqm.plugins.wavedream import WaveDreamPlugin

    a = A.Analyzer(lambda s: WaveDreamPlugin(s), rate=20.0)
    c = _seeded_client()
    a.apply_settings(c, force=True)

    pers = a.store.get("wd/persistence_ch00")
    assert pers.x.n == 256, "the seeded default"
    pers.fill([1.0], [-0.5])
    assert pers.entries == 1

    c.tree["/DQM/Analyzer/Binning/persistence x bins"] = 64
    a._settings_checked = 0
    assert a.apply_settings(c) is True

    rebuilt = a.store.get("wd/persistence_ch00")
    assert rebuilt.x.n == 64, "the new binning took effect"
    assert rebuilt.entries == 0, "old counts must not be carried into new bins"
    assert a.reconfigures == 1
    assert any("binning changed" in m for m in c.messages), \
        "a silent reset would look like data loss"


def test_a_role_change_does_not_throw_away_accumulated_plots():
    from mdqm.plugins.wavedream import WaveDreamPlugin

    a = A.Analyzer(lambda s: WaveDreamPlugin(s), rate=20.0)
    c = _seeded_client()
    a.apply_settings(c, force=True)

    a.store.get("wd/persistence_ch00").fill([1.0], [-0.5])
    assert a.store.get("wd/persistence_ch00").entries == 1

    c.tree["/DQM/Analyzer/Channel roles/rf channel"] = 9
    a._settings_checked = 0
    a.apply_settings(c)

    assert a.store.get("wd/persistence_ch00").entries == 1, \
        "moving the RF channel does not change any histogram's shape"
    assert a.reconfigures == 0
    assert a.plugin.roles["rf channel"] == 9, "but the plugin must see it"


def test_the_sampling_rate_can_be_changed_live():
    a = _analyzer(rate=20.0)
    c = _seeded_client(**{"Sampling/max events per s": 250.0})
    a.apply_settings(c, force=True)
    assert a.bucket.rate == 250.0
    assert a.configured_rate == 250.0


def test_raising_the_rate_clears_a_self_throttle():
    """The operator has said what they want more recently than we did."""
    a = _analyzer(rate=20.0)
    c = _seeded_client()
    a.apply_settings(c, force=True)

    a.bucket.rate = 5.0                     # as the throttle would leave it
    c.tree["/DQM/Analyzer/Sampling/max events per s"] = 40.0
    a._settings_checked = 0
    a.apply_settings(c)
    assert a.bucket.rate == 40.0


def test_settings_are_not_re_read_on_every_cycle():
    a = _analyzer()
    c = _seeded_client()
    a.apply_settings(c, force=True)
    assert a.apply_settings(c) is False, "a 2 s floor keeps this off the hot path"


def test_a_broken_settings_tree_does_not_stop_the_analyzer():
    """An ODB nobody can read must leave a working analyzer on defaults.

    read() deliberately swallows a per-key failure and substitutes the default,
    so apply_settings *succeeds* here rather than failing -- it has adopted a
    known-good configuration, which is the outcome that matters. What must not
    happen is an exception reaching the run loop.
    """
    from mdqm.dqm import settings as S

    class _Broken(_SettingsClient):
        def odb_get(self, path):
            raise RuntimeError("ODB unhappy")

    a = _analyzer()
    a.apply_settings(_Broken(), force=True)          # must not raise

    assert a.settings is not None, "it must end up configured, not unconfigured"
    assert a.settings["Binning"]["persistence x bins"] == 256, "on the defaults"
    assert S.read(_Broken())["Binning"]["persistence x bins"] == 256


def test_status_reports_the_live_binning():
    a = _analyzer()
    c = _seeded_client(**{"Binning/amplitude max": 2.5})
    a.apply_settings(c, force=True)
    st = a.status()
    assert st["settings_root"] == "/DQM/Analyzer"
    assert st["binning"]["amplitude max"] == 2.5
