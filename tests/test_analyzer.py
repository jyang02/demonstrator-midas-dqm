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
from mdqm.dqm.hist import Axis, Hist2D, HistStore


class _FakePlugin:
    """A plugin that is only what the analyzer requires one to be.

    It builds a histogram from code defaults in its constructor and rebuilds it
    from the ODB in ``reconfigure``, because that sequence -- not any particular
    physics -- is the contract ``apply_settings`` implements and the thing the
    binning tests below are about. There is no built-in plugin on this
    experiment (``analyzer.PLUGINS`` is empty), so this stands in for the one
    somebody will eventually write.
    """

    name = "fake"
    event_ids = frozenset({401})

    #: What the constructor uses having no ODB to read yet.
    DEFAULT_BINNING = {"persistence x bins": 256, "persistence y bins": 110,
                       "persistence y min": -1.0, "persistence y max": 0.1}

    def __init__(self, store, roles=None, binning=None):
        self.store = store
        self.processed = []
        self.runs = []
        self.roles = dict(roles or {})
        self.binning = dict(binning or self.DEFAULT_BINNING)
        self._build()

    def _build(self):
        b = self.binning
        self.store.add(Hist2D(
            "fake/persistence",
            Axis(int(b["persistence x bins"]), 0.0, 1024.0, "sample"),
            Axis(int(b["persistence y bins"]), float(b["persistence y min"]),
                 float(b["persistence y max"]), "V"),
        ))

    def reconfigure(self, roles, binning):
        """A histogram with different bins is a different histogram."""
        self.roles = dict(roles or {})
        self.binning = dict(binning or {})
        self.store.remove("fake/persistence")
        self._build()

    def accepts(self, event):
        return event.header.event_id in self.event_ids

    def process(self, event, run_number=None):
        self.processed.append(event)
        self.runs.append(run_number)
        return True

    def status(self):
        return {"plugin": self.name, "decoded": len(self.processed),
                "binning": dict(self.binning)}


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

    def receive_event(self, buf, async_flag=True, use_numpy=False):
        # use_numpy is accepted because the analyzer passes it: without it a
        # 33 kB TID_BYTE bank arrives as 33,000 Python ints. A fake that did not
        # accept it would hide that call site changing.
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

    A monitoring client that registers TR_START at a low sequence number holds
    up every run start it is slow for, until the watchdog reaps it.
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
    c = _seeded_client(**{"Binning/persistence x bins": 128,
                          "Binning/persistence y bins": 20})
    a.apply_settings(c, force=True)
    assert a.settings["Binning"]["persistence x bins"] == 128


def test_changing_the_binning_rebuilds_the_histograms():
    """A histogram with different bins is a different histogram."""
    a = _analyzer(rate=20.0)
    c = _seeded_client()
    a.apply_settings(c, force=True)

    pers = a.store.get("fake/persistence")
    assert pers.x.n == 64, "the seeded default, over the plugin's own 256"
    pers.fill([1.0], [-0.5])
    assert pers.entries == 1

    before = a.reconfigures            # startup already applied the ODB once
    c.tree["/DQM/Analyzer/Binning/persistence x bins"] = 128
    a._settings_checked = 0
    assert a.apply_settings(c) is True

    rebuilt = a.store.get("fake/persistence")
    assert rebuilt.x.n == 128, "the new binning took effect"
    assert rebuilt.entries == 0, "old counts must not be carried into new bins"
    assert a.reconfigures == before + 1
    assert any("binning changed" in m for m in c.messages), \
        "a silent reset would look like data loss"


def test_a_role_change_does_not_throw_away_accumulated_plots():
    a = _analyzer(rate=20.0)
    c = _seeded_client()
    a.apply_settings(c, force=True)

    a.store.get("fake/persistence").fill([1.0], [-0.5])
    assert a.store.get("fake/persistence").entries == 1

    before = a.reconfigures
    c.tree["/DQM/Analyzer/Channel roles/rf channel"] = 9
    a._settings_checked = 0
    a.apply_settings(c)

    assert a.store.get("fake/persistence").entries == 1, \
        "moving the RF channel does not change any histogram's shape"
    assert a.reconfigures == before, "no shape changed, so nothing was rebuilt"
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
    assert a.settings["Binning"]["persistence x bins"] == 64, "on the defaults"
    assert S.read(_Broken())["Binning"]["persistence x bins"] == 64


def test_status_reports_the_live_binning():
    a = _analyzer()
    c = _seeded_client(**{"Binning/amplitude max": 2.5})
    a.apply_settings(c, force=True)
    st = a.status()
    assert st["settings_root"] == "/DQM/Analyzer"
    assert st["binning"]["amplitude max"] == 2.5


# --- yielding to MIDAS while decoding ---------------------------------------

def test_decoding_yields_to_midas_periodically():
    """The brpc handler shares the interpreter and only runs when we let go.

    Measured at 500 ev/s offered: with no yield, wd::status stopped answering
    while the analyzer decoded perfectly -- so the pages reported an error about
    a healthy analyzer. Capping the work per cycle fixed that and cost a third of
    the throughput; yielding fixes it without the cap.
    """
    a = _analyzer(rate=100000.0)

    class _Counting(_FakeClient):
        def __init__(self):
            super().__init__()
            self.yields = 0

        def communicate(self, timeout_ms):
            self.yields += 1

    client = _Counting()
    client.events = [_Event() for _ in range(100)]
    a.run_once(client, buf=None)

    assert a.processed == 100
    expected = 100 // A.Analyzer.YIELD_EVERY
    assert client.yields >= expected - 1, \
        f"yielded {client.yields} times decoding 100 events"


def test_the_backstop_stops_decoding_but_never_the_drain():
    a = _analyzer(rate=100000.0)
    client = _FakeClient()
    client.events = [_Event() for _ in range(50)]
    client.communicate = lambda ms: None

    # A budget already spent: nothing should be decoded, everything drained.
    drained = a.run_once(client, buf=None, budget_s=-1.0)

    assert drained == 50, "the buffer must still be emptied"
    assert a.processed <= 1, "and decoding must stop almost immediately"
    assert a.budget_exhausted >= 1


def test_a_generous_backstop_is_not_normally_reached():
    a = _analyzer(rate=100000.0)
    client = _FakeClient()
    client.events = [_Event() for _ in range(200)]
    client.communicate = lambda ms: None

    a.run_once(client, buf=None, budget_s=2.0)
    assert a.budget_exhausted == 0, "the fake plugin is fast; nothing should trip"
    assert a.processed == 200


def test_the_odb_binning_is_applied_at_startup_not_only_on_change():
    """The bug: the first apply skipped the rebuild.

    The plugin's constructor builds its histograms from code defaults, having no
    ODB to read yet, so the first apply is exactly when the ODB has to be pushed
    in. Skipping it left the analyzer running on defaults while reporting the ODB
    values in its status -- caught on real cosmic data, where the persistence
    plot stayed at the default 110 bins over [-1.0, 0.1] after the ODB had been
    set to 180 over [-1.6, 0.2], and the status claimed the new numbers.
    """
    a = _analyzer(rate=20.0)
    assert a.store.get("fake/persistence").y.n == 110, "the code default"

    c = _seeded_client(**{"Binning/persistence y bins": 180,
                          "Binning/persistence y min": -1.6,
                          "Binning/persistence y max": 0.2})
    a.apply_settings(c, force=True)

    pers = a.store.get("fake/persistence")
    assert pers.y.n == 180, "the ODB must win at startup, not just on a later edit"
    assert pers.y.lo == -1.6
    assert pers.y.hi == 0.2


def test_status_reports_the_binning_the_histograms_actually_have():
    """So a disagreement between config and reality is visible, not hidden."""
    a = _analyzer(rate=20.0)
    c = _seeded_client(**{"Binning/persistence y bins": 44})
    a.apply_settings(c, force=True)

    axes = a.status()["axes"]
    assert "fake/persistence" in axes
    y = axes["fake/persistence"][1]
    assert y["bins"] == 44, "read off the histogram, not off the request"


def test_startup_with_an_unseeded_odb_keeps_the_code_defaults():
    a = _analyzer()
    a.apply_settings(_SettingsClient(), force=True)     # nothing seeded
    assert a.settings["Binning"]["persistence y bins"] == 110
