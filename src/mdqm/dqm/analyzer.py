#!/usr/bin/env python3
"""The DQM analyzer: a MIDAS client that samples events and serves histograms.

    mdqm-analyzer --experiment pim1 --plugin sampic

What it deliberately does NOT do, because a monitoring process must never be
able to affect data taking:

* **No equipment and no transition callbacks.** Registering either would put
  this client in the run-transition path, where a wedged process delays a run
  start until the watchdog reaps it. That is not hypothetical: a monitoring
  process that registers TR_START at a low sequence number delays every run
  start it is slow for. Run state is *polled* from ``/Runinfo`` instead.
* **Never ``GET_ALL``.** The event request is ``GET_NONBLOCKING``, so MIDAS
  overwrites events for this client rather than stalling the producer. One word
  is the difference between a monitor and a throttle, so it is asserted in the
  tests.
* **No unbounded work per event.** Sampling is rate-limited by a token bucket,
  and the analyzer throttles *itself* down if the DAQ starts dropping packets.

The histogram store lives outside the connection loop on purpose: a MIDAS
restart then costs a reconnect and nothing else, and whoever is watching the
page sees the same accumulated plots afterwards.
"""

from __future__ import annotations

import argparse
import contextlib
import os
import signal
import sys
import time

import midas
import midas.client

from mdqm.dqm import settings as odb_settings
from mdqm.dqm.hist import HistStore
from mdqm.dqm.sampic_plugin import SampicPlugin
from mdqm.dqm.server import Server

DEFAULT_CLIENT = "mdqm_analyzer"

#: The DAQ-stress counter this client watches so it can throttle itself. The
#: path is a placeholder: the demonstrator's equivalent is whatever its frontend
#: ends up calling its dropped-packet counter.
#: A missing counter is handled, not fatal -- check_daq_health() returns
#: quietly -- so this is safe to leave pointing at an equipment that does not
#: exist, and --dropped-path overrides it without a rebuild.
DROPPED_PATH = "/Equipment/WDWaveforms/Variables/Thread/DroppedPackets"

#: Where the plugin's history values are written, and the /History/Links event
#: they are linked into.
#:
#: Links rather than an equipment record: mlogger histories either
#: /Equipment/<eq>/Variables under a Common/Log history period, or anything
#: linked under /History/Links/<event>. The analyzer is not a frontend and has
#: no business fabricating an equipment -- an equipment record claims a
#: readout that does not exist, and /Equipment is where an operator looks to
#: find out what is actually running. The values live under our own settings
#: tree and are linked from there.
HISTORY_PATH = "/DQM/Analyzer/History"
HISTORY_EVENT = "DQM"

#: One history event per array, and one shared by the scalars.
#:
#: Not cosmetic. A /History/Links event is ONE record containing every tag in
#: it, and mlogger rewrites the whole record on every ODB write to any of them
#: -- there is no per-event minimum period the way ``Common/Log history``
#: throttles an equipment. With the scalars in the same event as the two
#: 512-channel arrays, each scalar write dragged 8 kB of arrays onto disk with
#: it: measured at 816 MB/day before this split, and ~11 MB/day after it at the
#: 60 s period.
#:
#: It also reads better in mhttpd's History tab, where picking "DQMBaseline"
#: gives the 512 channels on their own rather than mixed in with the summary.
def _history_event(name: str, value) -> str:
    return f"{HISTORY_EVENT}{name.replace(' ', '')}" if isinstance(value, list) \
        else HISTORY_EVENT

_stop = False


def _on_signal(_sig, _frm):
    global _stop
    _stop = True


class TokenBucket:
    """Process at most `rate` events per second, discarding the rest.

    The buffer is drained every cycle regardless -- that is free with
    GET_NONBLOCKING and keeps the read pointer current -- but only this many are
    *decoded*. One knob rather than three interacting ones -- a batch size, a
    period and a serialise-every-n -- which between them produce behaviour
    nobody can predict from their names.
    """

    def __init__(self, rate: float):
        self.rate = float(rate)
        self._allowance = self.rate
        self._last = time.monotonic()

    def take(self) -> bool:
        if self.rate <= 0:
            return False
        now = time.monotonic()
        self._allowance = min(self.rate, self._allowance + (now - self._last) * self.rate)
        self._last = now
        if self._allowance < 1.0:
            return False
        self._allowance -= 1.0
        return True


class Backoff:
    def __init__(self, start=1.0, cap=15.0):
        self.start, self.cap, self.current = start, cap, start

    def reset(self):
        self.current = self.start

    def next(self) -> float:
        d = self.current
        self.current = min(self.cap, self.current * 2)
        return d


class Analyzer:
    """Owns the state that must survive a MIDAS reconnect."""

    def __init__(self, plugin_factory, *, rate=20.0, buffer_name="SYSTEM"):
        self.store = HistStore()
        self.plugin = plugin_factory(self.store)
        self.buffer_name = buffer_name
        self.bucket = TokenBucket(rate)
        self.configured_rate = rate

        self.settings = None
        self._settings_shape = None
        self._settings_checked = 0.0
        self.reconfigures = 0

        self.seen = 0
        self.processed = 0
        self.run_number = None
        self.run_state = None
        self.started_at = time.time()
        #: The names last linked under /History/Links, so the links are only
        #: rewritten when the plugin's payload changes shape.
        self._history_linked: tuple = ()
        #: The /History/Links events this analyzer has created, so ones it stops
        #: publishing into can be removed rather than left for mlogger to keep
        #: writing.
        self._history_events: set = set()
        self._history_at = 0.0
        self.connected_since = None
        self.reconnects = 0
        self.throttle_events = []
        self.budget_exhausted = 0
        self._dropped_baseline = None
        self._ev_window = []

        self.server = Server(
            self.store,
            status_fn=self.status,
            defs_fn=lambda: {"plugin": self.plugin.name,
                             "histograms": self.store.names(),
                             "series": (self.plugin.series().get("names", [])
                                        if hasattr(self.plugin, "series") else [])},
            # Guarded like scope_fn: a plugin need not serve any series.
            series_fn=(lambda name: self.plugin.series(name)
                       if hasattr(self.plugin, "series") else {}),
            # The plugin owns the frame; the server only forwards it. Guarded
            # because a plugin need not offer one -- only detector-specific
            # plugins have traces to show.
            scope_fn=lambda: (self.plugin.scope_frame(self.run_state == 3)
                              if hasattr(self.plugin, "scope_frame") else None))

    # -- status --------------------------------------------------------------

    def status(self) -> dict:
        now = time.time()
        recent = [t for t in self._ev_window if now - t < 10.0]
        self._ev_window = recent
        return {
            "client": DEFAULT_CLIENT,
            "uptime_s": round(now - self.started_at, 1),
            "connected_since": self.connected_since,
            "reconnects": self.reconnects,
            "run_number": self.run_number,
            "run_active": self.run_state == 3,
            "events_seen": self.seen,
            "events_processed": self.processed,
            "processed_per_s": round(len(recent) / 10.0, 2),
            "rate_limit": self.bucket.rate,
            "configured_rate": self.configured_rate,
            "throttled": self.bucket.rate < self.configured_rate,
            "throttle_events": self.throttle_events[-5:],
            "budget_exhausted": self.budget_exhausted,
            "histograms": len(self.store),
            "reconfigures": self.reconfigures,
            "settings_root": odb_settings.ROOT,
            "binning": (self.settings or {}).get("Binning", {}),
            # Read back off the histograms themselves. The settings dict says
            # what was requested; this says what exists, and the two disagreeing
            # is exactly the failure this reports.
            "axes": self.live_axes(),
            "channel_roles": (self.settings or {}).get("Channel roles", {}),
            "server_calls": self.server.calls,
            "server_last_error": self.server.last_error,
            "plugin": self.plugin.status(),
        }

    # -- live configuration --------------------------------------------------

    def apply_settings(self, client, force: bool = False) -> bool:
        """Re-read /DQM/Analyzer and adopt any change. Returns True if it did.

        Polled rather than hotlinked. A watch callback would run on the client's
        thread while the brpc handler may be encoding a histogram from the same
        store, and the cost of reading a dozen small keys every couple of seconds
        is far below the cost of getting that locking wrong.
        """
        now = time.time()
        if not force and now - self._settings_checked < 2.0:
            return False
        self._settings_checked = now

        try:
            new = odb_settings.read(client)
        except Exception:
            return False

        shape = odb_settings.binning_fingerprint(new)
        changed_shape = shape != self._settings_shape
        first = self.settings is None
        if not first and odb_settings.fingerprint(new) == odb_settings.fingerprint(self.settings):
            return False

        self.settings = new
        self._settings_shape = shape

        rate = float(new["Sampling"].get("max events per s", self.configured_rate))
        if rate != self.configured_rate:
            self.configured_rate = rate
            # An operator raising the rate also clears a self-throttle, because
            # they have said what they want more recently than we did.
            self.bucket.rate = rate
        self.plugin.roles = new["Channel roles"]

        # `first` is included, not excluded. The plugin's constructor built its
        # histograms from code defaults because it had no ODB to read yet, so the
        # first apply is precisely when the ODB has to be pushed in. Skipping it
        # left the analyzer running on defaults while *reporting* the ODB values
        # in its status -- plots that disagreed with the configuration they
        # claimed, which is worse than plots that are merely wrong.
        # Before the rebuild branch, and outside it. A cap change must reach the
        # plugin on its own -- it is not a shape change and deliberately does
        # not appear in binning_fingerprint, so nothing else here would carry
        # it. Cheap enough to push on every apply rather than diffing it.
        if hasattr(self.plugin, "set_window"):
            self.plugin.set_window(new.get("Window", {}))

        if changed_shape and hasattr(self.plugin, "reconfigure"):
            self.plugin.reconfigure(new["Channel roles"], new["Binning"])
            self.reconfigures += 1
            if first:
                print(f"{DEFAULT_CLIENT}: applied binning from {odb_settings.ROOT}",
                      flush=True)
            # Best effort: the rebuild has already happened either way.
            with contextlib.suppress(Exception):
                client.msg(f"{DEFAULT_CLIENT}: binning changed; rebuilt "
                           f"{len(self.store)} histograms (counts reset)")
        return True

    def live_axes(self) -> dict:
        """The binning the histograms actually have, straight from the objects."""
        out = {}
        for name in self.store.names():
            hist = self.store.get(name)
            meta = getattr(hist, "metadata", None)
            if meta is None:
                continue
            out[name] = [
                {"bins": ax["bins"], "lo": ax["lo"], "hi": ax["hi"]}
                for ax in meta()["axes"]
            ]
        return out

    # -- the DAQ-safety valve -------------------------------------------------

    def check_daq_health(self, client) -> None:
        """Throttle ourselves if the DAQ starts losing packets while we run.

        We cannot prove from inside this process that we are not the cause, so
        the honest response to evidence of stress is to take less, not to
        reason about whether it was our fault. Halves the rate each time, down
        to zero; recovering it is an operator action, never automatic.
        """
        try:
            dropped = int(client.odb_get(DROPPED_PATH))
        except Exception:
            return                       # not every experiment has this counter
        if self._dropped_baseline is None:
            self._dropped_baseline = dropped
            return
        if dropped <= self._dropped_baseline:
            return

        delta = dropped - self._dropped_baseline
        self._dropped_baseline = dropped
        new_rate = self.bucket.rate / 2.0
        if new_rate < 0.5:
            new_rate = 0.0
        self.bucket.rate = new_rate
        note = {"at": time.time(), "dropped_delta": delta, "new_rate": new_rate}
        self.throttle_events.append(note)
        # Best effort: if the message cannot be sent the throttle has still
        # happened, and failing here would undo it.
        with contextlib.suppress(Exception):
            client.msg(
                f"{DEFAULT_CLIENT}: DAQ dropped {delta} packets; halving my sampling "
                f"rate to {new_rate}/s. I may not be the cause, but monitoring must "
                f"never be. Restart me to restore the configured rate.", is_error=True)

    def publish_history(self, client) -> None:
        """Write the plugin's history values and link them for mlogger.

        Off unless ``publish history`` is set: see that setting for why the
        default is not to touch another experiment's /History.

        The links are (re)made whenever the set of names changes, which is what
        a plugin swap or a channel-count change looks like. Making them every
        time would be a write per name per period for no gain; making them only
        once would leave a link pointing at a name the plugin has stopped
        publishing.
        """
        sampling = self.settings.get("Sampling", {}) if self.settings else {}
        if not sampling.get("publish history"):
            return
        history = getattr(self.plugin, "history", None)
        if history is None:
            return
        try:
            values = history()
        except Exception as exc:                       # noqa: BLE001
            # A monitoring client must never take the experiment down with it,
            # and a broken history payload is not a reason to stop analysing.
            print(f"{DEFAULT_CLIENT}: history payload failed: {exc}", flush=True)
            return

        for name, value in values.items():
            client.odb_set(f"{HISTORY_PATH}/{name}", value)

        names = tuple(sorted(values))
        if names == self._history_linked:
            return

        # Rebuild rather than add to. Creating links without removing the ones
        # that are not wanted leaves a stale event that mlogger goes on writing:
        # a link to a value nothing publishes there any more still costs a full
        # record every period, so the file grows at the rate a change was meant
        # to fix while looking as though it had been applied. Adding is not
        # enough; the set has to be made to match.
        wanted: dict = {}
        for name in names:
            wanted.setdefault(_history_event(name, values[name]), []).append(name)
        for event in self._history_events:
            if event not in wanted:
                try:
                    client.odb_delete(f"/History/Links/{event}")
                except Exception:                      # noqa: BLE001
                    pass
        for event, in_event in wanted.items():
            for name in in_event:
                link = f"/History/Links/{event}/{name}"
                try:
                    client.odb_link(link, f"{HISTORY_PATH}/{name}")
                except Exception:                      # noqa: BLE001
                    pass                               # already there
        self._history_linked = names
        self._history_events = set(wanted)

    # -- the loop ------------------------------------------------------------

    def poll_run_state(self, client) -> None:
        """Read run state rather than registering a transition callback."""
        try:
            state = int(client.odb_get("/Runinfo/State"))
            number = int(client.odb_get("/Runinfo/Run number"))
        except Exception:
            return
        if number != self.run_number:
            # A new run: clear what asked to be cleared, and reset per-run state.
            if self.run_number is not None:
                self.store.clear_for_new_run()
            self.run_number = number
        self.run_state = state

    #: Decode this many events, then yield to MIDAS before continuing.
    #:
    #: The brpc handler shares this interpreter, so it can only run when this
    #: loop gives up the GIL. Measured at 500 events/s offered: with no yield at
    #: all, wd::status stopped answering entirely -- the analyzer was decoding
    #: perfectly and the pages showed an error. Capping the *work* per cycle
    #: fixed that and cost a third of the throughput (131 ev/s at 39% of a core,
    #: nowhere near CPU-bound). Yielding periodically fixes the same problem
    #: without the cap, because the problem was never how much work there was.
    YIELD_EVERY = 25

    def run_once(self, client, buf, budget_s: float = 2.0) -> int:
        """One cycle: drain the buffer and decode what the bucket allows.

        Draining is unbounded: it is cheap, and stopping early would leave the
        read pointer behind. Decoding is limited by the token bucket, yields to
        MIDAS every `YIELD_EVERY` events so the RPC handler is serviced, and has
        a generous wall-clock backstop that should never normally be reached.
        """
        drained = 0
        deadline = time.monotonic() + budget_s
        since_yield = 0
        decoding = True
        while not _stop:
            # use_numpy is not optional at these rates. Without it a 33 kB
            # TID_BYTE bank arrives as a tuple of 33,000 Python ints and
            # converting it has to walk every one of them; the offline file
            # reader hands over the same shape. With it, the bank is an ndarray
            # and the conversion is a memcpy.
            event = client.receive_event(buf, async_flag=True, use_numpy=True)
            if event is None:
                break
            drained += 1
            self.seen += 1
            if not decoding or not self.plugin.accepts(event):
                continue
            if not self.bucket.take():
                continue                 # sampled out: draining still matters
            if self.plugin.process(event, run_number=self.run_number):
                self.processed += 1
                self._ev_window.append(time.time())

            since_yield += 1
            if since_yield >= self.YIELD_EVERY:
                since_yield = 0
                # Zero timeout: hand control to MIDAS and come straight back.
                # This is what lets a status or histogram request be answered
                # while a burst is being decoded.
                client.communicate(0)

            if time.monotonic() > deadline:
                # The backstop. Keep draining, stop decoding, resume next cycle.
                # Never break outright -- that would abandon the drain.
                decoding = False
                self.budget_exhausted += 1
        return drained

    def serve(self, client, cmd, args, max_len):
        """The brpc callback. Must stay bounded: it runs on an RPC thread."""
        blob = self.server.dispatch(cmd, args)
        if not blob:
            return midas.status_codes["SUCCESS"], b""
        if len(blob) > max_len:
            # The page reads the size from the header and retries with a bigger
            # buffer, so a truncated reply is a protocol step and not a failure.
            blob = blob[:max_len]
        import ctypes
        return midas.status_codes["SUCCESS"], ctypes.create_string_buffer(blob, len(blob))


#: Plugin name -> a callable taking (store, roles, binning).
#:
#: This was empty, on the grounds that the demonstrator had no documented bank
#: to decode. It has one: docs/sampic-bank-layout.md specifies AD00/AT00,
#: mdqm.dqm.sampic and tests/js/adbank.test.js decode the same bytes on either
#: side of the boundary, and the Scope page draws them live. What the
#: mechanism-C panels on Channels, Pulses and Physics are waiting for is a
#: *renderer* as much as this registry -- probeAnalyzer() reports what is
#: published, and no panel on those pages claims a renderer yet.
PLUGINS: dict = {SampicPlugin.name: SampicPlugin}


def make_plugin_factory(name, roles=None, binning=None):
    factory = PLUGINS.get(name)
    if factory is None:
        known = ", ".join(sorted(PLUGINS)) or "none are built in yet"
        raise SystemExit(f"unknown plugin {name!r}; known: {known}")
    return lambda store: factory(store, roles=roles, binning=binning)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--experiment", default=os.environ.get("MIDAS_EXPT_NAME"))
    ap.add_argument("--client", default=DEFAULT_CLIENT)
    ap.add_argument("--plugin", default=SampicPlugin.name,
                    help="which analysis plugin to run")
    ap.add_argument("--buffer", default="SYSTEM")
    ap.add_argument("--rate", type=float, default=20.0,
                    help="events per second to decode; the buffer is drained regardless")
    ap.add_argument("--max-event-size", type=int, default=8 * 1024 * 1024)
    ap.add_argument("--cycle-ms", type=int, default=200)
    ap.add_argument("--decode-budget-s", type=float, default=2.0,
                    help="backstop on how long one decode burst may run; the "
                         "periodic yield, not this, is what keeps RPC answering")
    args = ap.parse_args(argv)

    if not args.experiment:
        print("error: no experiment; pass --experiment or set MIDAS_EXPT_NAME",
              file=sys.stderr)
        return 2

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    # Outside the reconnect loop: a MIDAS bounce must not lose what has been
    # accumulated, or the operator watching the page sees their plots reset for
    # a reason that has nothing to do with the data.
    # Built with the defaults; apply_settings() re-reads the ODB and rebuilds
    # once connected, so the ODB is the authority and --rate only seeds it.
    analyzer = Analyzer(make_plugin_factory(args.plugin),
                        rate=args.rate, buffer_name=args.buffer)
    backoff = Backoff()

    print(f"{args.client}: plugin={args.plugin} buffer={args.buffer} "
          f"rate={args.rate}/s experiment={args.experiment}", flush=True)
    print(f"{args.client}: {len(analyzer.store)} histograms: "
          f"{', '.join(analyzer.store.names())}", flush=True)

    while not _stop:
        try:
            # The context manager is not stylistic. client.py:186-196 documents
            # that cm_disconnect_experiment() alone does not free RPC *server*
            # resources; disconnect() additionally calls rpc_server_shutdown()
            # and ss_suspend_reset_server_acceptions(). Without it the second
            # register_brpc_callback after a reconnect trips over stale state.
            with midas.client.MidasClient(args.client, expt_name=args.experiment) as client:
                analyzer.connected_since = time.time()
                if analyzer.reconnects:
                    print(f"{args.client}: reconnected", flush=True)

                # Seed before anything reads it, so a fresh experiment gets a
                # settings tree an operator can find and edit.
                created = odb_settings.seed(client)
                if created:
                    print(f"{args.client}: seeded {created} settings key(s) under "
                          f"{odb_settings.ROOT}", flush=True)
                analyzer.apply_settings(client, force=True)

                client.register_brpc_callback(analyzer.serve)
                buf = client.open_event_buffer(args.buffer, None, args.max_event_size)
                client.register_event_request(
                    buf, event_id=-1, trigger_mask=-1,
                    # Never GET_ALL: this must not be able to back-pressure a frontend.
                    sampling_type=midas.GET_NONBLOCKING)

                backoff.reset()
                last_health = 0.0
                while not _stop:
                    analyzer.apply_settings(client)
                    analyzer.poll_run_state(client)
                    analyzer.run_once(client, buf, budget_s=args.decode_budget_s)
                    now = time.time()
                    if now - last_health > 10.0:
                        analyzer.check_daq_health(client)
                        last_health = now
                    period = float((analyzer.settings.get("Sampling", {}) or {})
                                   .get("history period s", 10.0) or 10.0)
                    if now - analyzer._history_at >= period:
                        analyzer.publish_history(client)
                        analyzer._history_at = now
                    client.communicate(args.cycle_ms)

        except KeyboardInterrupt:
            break
        except Exception as exc:                       # noqa: BLE001
            if _stop:
                break
            delay = backoff.next()
            analyzer.reconnects += 1
            analyzer.connected_since = None
            print(f"{args.client}: lost MIDAS ({type(exc).__name__}: {exc}); "
                  f"retrying in {delay:.0f}s", file=sys.stderr, flush=True)
            for _ in range(int(delay * 10)):
                if _stop:
                    break
                time.sleep(0.1)

    print(f"{args.client}: stopped after {analyzer.processed} events "
          f"({analyzer.reconnects} reconnects)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
