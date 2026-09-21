"""Command dispatch for the browser, over MIDAS's binary RPC.

The page calls ``mjsonrpc_call("brpc", {client_name, cmd, args, max_reply_length},
"arraybuffer")``; mhttpd forwards that to whichever MIDAS client registered
``RPC_BRPC``, and the reply comes back as an ArrayBuffer. No extra port, no
CORS, no proxy, and it goes through mhttpd's own authentication.

Everything uses brpc, JSON included, rather than splitting small replies onto
``jrpc``. ``jrpc`` runs its reply through ``ss_repair_utf8()``
(``mjsonrpc.cxx:3455``), which silently mangles any non-UTF-8 byte -- a landmine
for whoever later adds a binary path to it. One transport, one client function.

The ``dqm::`` commands are musip-compatible; ``wd::`` are ours. An unrecognised
namespace returns an empty reply rather than an error, so another RPC handler in
the same client can take it -- which is how musip's own dispatcher behaves.
"""

from __future__ import annotations

import json
import time

from mdqm.dqm import framing


class Server:
    """Turns a (cmd, args) pair into framed bytes. No MIDAS in here at all.

    Kept free of the MIDAS client so it can be tested directly, which is most of
    why the command set is easy to trust.
    """

    def __init__(self, store, status_fn=None, defs_fn=None, scope_fn=None,
                 series_fn=None):
        self.store = store
        self._status_fn = status_fn or (lambda: {})
        self._defs_fn = defs_fn or (lambda: {})
        self._scope_fn = scope_fn or (lambda: None)
        # Injected like the others, and for the same reason: a series is a
        # plugin's own state rather than something in the histogram store, and
        # the server has no business knowing which plugin is loaded.
        self._series_fn = series_fn or (lambda name: {})
        self.calls = 0
        self.last_error: str | None = None

    # -- entry point ---------------------------------------------------------

    def dispatch(self, cmd: str, args: str) -> bytes:
        """Handle one command. Never raises: a broken reply is still a reply."""
        self.calls += 1
        try:
            return self._dispatch(cmd or "", args or "")
        except Exception as exc:                     # noqa: BLE001 - see below
            # A raise here would surface to the operator as a silent timeout,
            # because the browser cannot see a Python traceback. Report it in
            # the payload instead, where the page can show it.
            self.last_error = f"{type(exc).__name__}: {exc}"
            return framing.envelope(framing.TAG_ERROR, self.last_error.encode())

    def _dispatch(self, cmd: str, args: str) -> bytes:
        if cmd == "dqm::list":
            return self._list()
        if cmd == "dqm::histogram":
            return self._histogram(args)
        if cmd == "dqm::metadata":
            return self._metadata(args)
        if cmd == "dqm::series":
            return self._series(args)
        if cmd == "dqm::clear":
            return self._clear(args)
        if cmd == "wd::scope":
            return self._scope()
        if cmd == "wd::status":
            return self._json(self._status_fn())
        if cmd == "wd::defs":
            return self._json(self._defs_fn())
        # Not ours. Empty, not an error: another handler may want it.
        return b""

    # -- commands ------------------------------------------------------------

    def _list(self) -> bytes:
        """Newline-separated names, musip's format."""
        return framing.envelope(framing.TAG_LIST, "\n".join(self.store.names()).encode())

    def _name_from(self, args: str) -> str:
        """Accept musip's JSON args and a bare name alike."""
        args = (args or "").strip()
        if not args:
            return ""
        if args.startswith("{"):
            try:
                return str(json.loads(args).get("name", ""))
            except json.JSONDecodeError:
                return ""
        return args

    def _histogram(self, args: str) -> bytes:
        name = self._name_from(args)
        hist = self.store.get(name)
        if hist is None:
            return framing.envelope(
                framing.TAG_ERROR, f"no such histogram: {name!r}".encode())
        return framing.envelope(framing.TAG_HIST, hist.encode())

    def _metadata(self, args: str) -> bytes:
        name = self._name_from(args)
        hist = self.store.get(name)
        if hist is None:
            return framing.envelope(
                framing.TAG_ERROR, f"no such histogram: {name!r}".encode())
        return framing.envelope(framing.TAG_META, json.dumps(hist.metadata()).encode())

    def _series(self, args: str) -> bytes:
        """A recent-value series as JSON, or the list of names when unnamed.

        JSON rather than the binary histogram framing, which is a real
        trade and worth stating. The framing wins on size for anything binned;
        this is scattered points, so it would need its own tag, its own decoder
        in the browser and its own tests, to save bytes on a payload whose
        whole point is that it is small enough not to matter. The cost these
        tiles were ever in danger of is not the wire -- it is 26316 rectangles a
        repaint, which is why they are not colormaps.
        """
        name = self._name_from(args)
        got = self._series_fn(name)
        if name and not got:
            return framing.envelope(
                framing.TAG_ERROR, f"no such series: {name!r}".encode())
        return self._json(got)

    def _clear(self, args: str) -> bytes:
        selector = self._name_from(args)
        cleared = self.store.clear(selector)
        return self._json({"cleared": cleared, "selector": selector,
                           "at": time.time()})

    def _scope(self) -> bytes:
        blob = self._scope_fn()
        if blob is None:
            # Not an error: with no run there are simply no waveform events, and
            # the page has to be able to say so rather than show a stale trace.
            return framing.envelope(framing.TAG_JSON, b'{"no_frame": true}')
        return framing.envelope(framing.TAG_SCOPE, blob)

    def _json(self, obj) -> bytes:
        return framing.envelope(framing.TAG_JSON, json.dumps(obj, default=str).encode())
