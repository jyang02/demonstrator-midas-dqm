#!/usr/bin/env python3
"""The DQM analyzer: a MIDAS client that samples events and serves histograms.

    mdqm-analyzer --experiment WDSCALERS --plugin wavedream

What it deliberately does NOT do, because a monitoring process must never be
able to affect data taking:

* **No equipment and no transition callbacks.** Registering either would put
  this client in the run-transition path, where a wedged process delays a run
  start until the watchdog reaps it. That is not hypothetical -- it is exactly
  what the retired DQM publisher did, registering TR_START at sequence 100
  (``docs/REGISTRY.md``). Run state is *polled* from ``/Runinfo`` instead.
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

from mdqm.dqm.hist import HistStore
from mdqm.dqm.server import Server

DEFAULT_CLIENT = "wd_analyzer"
DROPPED_PATH = "/Equipment/WDWaveforms/Variables/Thread/DroppedPackets"

_stop = False


def _on_signal(_sig, _frm):
    global _stop
    _stop = True


class TokenBucket:
    """Process at most `rate` events per second, discarding the rest.

    The buffer is drained every cycle regardless -- that is free with
    GET_NONBLOCKING and keeps the read pointer current -- but only this many are
    *decoded*. One knob, replacing the three the retired stack had
    (num-events-per-retrieval, period-ms, serialize-every-n-events), which
    interacted in ways nobody could predict from their names.
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

        self.seen = 0
        self.processed = 0
        self.run_number = None
        self.run_state = None
        self.started_at = time.time()
        self.connected_since = None
        self.reconnects = 0
        self.throttle_events = []
        self._dropped_baseline = None
        self._ev_window = []

        self.server = Server(
            self.store,
            status_fn=self.status,
            defs_fn=lambda: {"plugin": self.plugin.name,
                             "histograms": self.store.names()},
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
            "histograms": len(self.store),
            "server_calls": self.server.calls,
            "server_last_error": self.server.last_error,
            "plugin": self.plugin.status(),
        }

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

    def run_once(self, client, buf) -> int:
        """One cycle: drain the buffer, process what the bucket allows."""
        drained = 0
        while not _stop:
            event = client.receive_event(buf, async_flag=True)
            if event is None:
                break
            drained += 1
            self.seen += 1
            if not self.plugin.accepts(event):
                continue
            if not self.bucket.take():
                continue                 # sampled out: draining still matters
            if self.plugin.process(event, run_number=self.run_number):
                self.processed += 1
                self._ev_window.append(time.time())
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


def make_plugin_factory(name, roles=None, binning=None):
    if name == "wavedream":
        from mdqm.plugins.wavedream import WaveDreamPlugin
        return lambda store: WaveDreamPlugin(store, roles=roles, binning=binning)
    raise SystemExit(f"unknown plugin {name!r}; known: wavedream")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--experiment", default=os.environ.get("MIDAS_EXPT_NAME"))
    ap.add_argument("--client", default=DEFAULT_CLIENT)
    ap.add_argument("--plugin", default="wavedream")
    ap.add_argument("--buffer", default="SYSTEM")
    ap.add_argument("--rate", type=float, default=20.0,
                    help="events per second to decode; the buffer is drained regardless")
    ap.add_argument("--max-event-size", type=int, default=8 * 1024 * 1024)
    ap.add_argument("--cycle-ms", type=int, default=200)
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

                client.register_brpc_callback(analyzer.serve)
                buf = client.open_event_buffer(args.buffer, None, args.max_event_size)
                client.register_event_request(
                    buf, event_id=-1, trigger_mask=-1,
                    # Never GET_ALL: this must not be able to back-pressure a frontend.
                    sampling_type=midas.GET_NONBLOCKING)

                backoff.reset()
                last_health = 0.0
                while not _stop:
                    analyzer.poll_run_state(client)
                    analyzer.run_once(client, buf)
                    now = time.time()
                    if now - last_health > 10.0:
                        analyzer.check_daq_health(client)
                        last_health = now
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
