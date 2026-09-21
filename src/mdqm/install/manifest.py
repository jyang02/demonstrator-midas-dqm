"""What gets registered into ``/Custom``, and the rules a name has to satisfy.

This is the single source of truth for the page set. ``register_pages.py``
writes what is listed here; ``tests/test_manifest.py`` asserts every rule below
holds, because each one is a way mhttpd will silently serve the wrong thing (or
nothing) rather than report an error.

Why registration works the way it does
--------------------------------------
``add_custom_path()`` (midas ``progs/mhttpd.cxx:3602``) returns a value that
starts with ``/`` unchanged -- ``/Custom/Path`` is only prepended to *relative*
names. And a plain static request such as ``GET /dqm-common.js``
(``mhttpd.cxx:13146``) is resolved by looking for the ODB key
``/Custom/dqm-common.js``, then ``...&``, then ``...!``, and serving whatever
file that key names.

So every page and every asset is registered as its own ``/Custom/<name>`` key
holding an **absolute** path, and ``/Custom/Path`` is never read or written.
That is what lets these pages coexist as a guest in somebody else's experiment:
musip's ``quads_config_fe.cpp:668`` rewrites ``/Custom/Path`` on every start,
and it does not matter to us at all.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

#: Repository root, derived rather than hardcoded: the checkout lives in a
#: different place on every machine, and the ODB values written from it are
#: absolute, per-machine state.
REPO_ROOT = Path(__file__).resolve().parents[3]
PAGES_DIR = REPO_ROOT / "pages"

#: MIDAS ``NAME_LENGTH``. A longer key is truncated, not rejected.
MAX_KEY_LENGTH = 31

#: mhttpd's ``interprete()`` intercepts any request path *containing* one of
#: these as a substring, before ``/Custom`` is ever consulted. An asset named
#: after one of them is unreachable.
RESERVED_SUBSTRINGS = (
    "midas.js",
    "midas.css",
    "mhttpd.js",
    "mhttpd.css",
    "controls.js",
    "obsolete.js",
)

#: After the ``/Custom`` lookup misses, mhttpd falls back to ``send_resource()``,
#: which serves anything in ``$MIDASSYS/resources``. A key that collides with a
#: stock resource name still wins (the /Custom lookup comes first), but the
#: reverse -- expecting to override a stock resource -- does not work, and the
#: ambiguity is not worth having. Checked at test time against the live
#: resources directory when one is available.
STOCK_RESOURCE_HINT = ("mplot.js", "mhistory.js", "mihistory.js", "eqtable.js", "filesrw.js")

#: ``show_custom_page()`` reads the file into a ``char*``, truncates at the first
#: NUL, and rewrites legacy ``<odb ...>`` tags. Neither is wanted in our files.
FORBIDDEN_CONTENT = ("<odb ",)


@dataclass(frozen=True)
class Entry:
    """One ``/Custom`` key.

    ``key``      ODB key name, *without* the ``!`` suffix.
    ``path``     file to serve, relative to ``pages/``.
    ``menu``     True for a page that should appear in the mhttpd side menu.
    ``summary``  what it is, for ``--list`` output.
    """

    key: str
    path: str
    menu: bool
    summary: str

    @property
    def odb_name(self) -> str:
        """The key as written to the ODB.

        A trailing ``!`` hides the entry from the side menu -- that is the only
        thing the suffix does. (External links use a ``link:https://...``
        *value*, not this suffix; the two are widely confused.)
        """
        return self.key if self.menu else self.key + "!"

    def resolve(self, pages_dir: Path) -> Path:
        return (pages_dir / self.path).resolve()


# Pages carry no dot in their key. That is not cosmetic: a dot-less key routes
# through show_custom_page(), which sends no cache headers at all, while a
# dotted key routes through send_file() -> send_fp(), which stamps
# "Expires: <now + 24h>" with no ETag and no Last-Modified. So the HTML is
# always fresh and only the assets need ?v= busting -- which is what
# asset_token() below is for, and what stale_tokens() refuses to let rot.
#
# Keys are also space-free and free of regex metacharacters: the key is both
# "?cmd=custom&page=<key>" and the argument to mhttpd_init('<key>'), and the
# sidenav highlight does current_page.search(item) -- an *unescaped* regex.
# Only what exists and works is listed. A page added to the menu before it
# does anything is worse than no page: an operator who opens it and finds it
# broken stops trusting the whole set.
#
# One menu page now. It was six, one per mechanism -- what the panel read from --
# and it is one page with a tab per question instead. The asset list is
# unchanged apart from the two renderers whose pages went: every tab of the one
# page loads every renderer, because a tab is not a document boundary.
ENTRIES: tuple[Entry, ...] = (
    Entry("ATAR", "atar.html", True,
          "the shift screen: per-channel health, one event, trends, and what is proposed"),
    Entry("dqm-common.js", "js/dqm-common.js", False, "shared discovery and RPC helpers"),
    Entry("dqm-panels.js", "js/dqm-panels.js", False,
          "the panel catalogue, generated from the page spec"),
    Entry("dqm-page.js", "js/dqm-page.js", False,
          "the panel renderer, the tab bar, the page boot and the renderer registry"),
    Entry("dqm-adbanks.js", "js/dqm-adbanks.js", False,
          "SAMPIC AD00/AT00 bank decoding in the browser"),
    Entry("dqm-atar-geom.js", "js/dqm-atar-geom.js", False,
          "the ATAR channel map, shared by the Channels and Scope tabs"),
    Entry("dqm-scope.js", "js/dqm-scope.js", False, "the live panels on the Scope tab"),
    Entry("dqm-brpc.js", "js/dqm-brpc.js", False, "talking to an analyzer over binary RPC"),
    Entry("dqm-hists.js", "js/dqm-hists.js", False,
          "the analyzer-backed panels on the Channels and Trends tabs"),
    Entry("dqm.css", "css/dqm.css", False, "the little that midas.css does not cover"),
)

# Two pages and their renderers left here in the conversion to one tabbed page,
# and the reason is in the spec's retired group rather than only in this file:
# "Rates" (rates.html, dqm-rates.js) waited on a counting equipment nobody has
# specified, and every panel on "SlowControls" (slowcontrols.html, dqm-slow.js)
# waited on fecaen_hv or featar_sc -- and once MIDAS histories those variables,
# mhttpd trends them for free.
#
# An experiment that has the old set registered heals itself on the next
# mdqm-register-pages: register_pages.prune() runs after every successful
# registration and deletes any /Custom key that points into this checkout and is
# no longer in ENTRIES, which is exactly these eight. Nothing here has to be
# removed by hand, and another tenant's keys are never candidates.
#
# The list is kept because prune() only sees an experiment somebody re-registers.
# "Scope", "Channels", "Pulses" and "Physics" are page keys that now name tabs;
# a menu entry of one of those names on an experiment somewhere is this page set
# before the conversion, not a page anybody should still open.
RETIRED_KEYS: tuple[str, ...] = (
    "Rates", "Scope", "Channels", "Pulses", "Physics", "SlowControls",
    "dqm-rates.js", "dqm-slow.js",
)

#: Config root for the pages. One subtree per page beneath it; see
#: config_defaults.DEFAULTS.
#:
#: Deliberately *not* under /Custom -- mhttpd renders any /Custom subdirectory
#: as a sidenav submenu, unconditionally, with no way to hide it. And
#: deliberately not under /Equipment/<eq>/Settings -- the pages must be able to
#: describe equipment they do not own, and to keep working when that equipment
#: is absent entirely, which on this experiment is all of it.
#:
#: Note that /DQM/Analyzer is the analyzer's own settings tree (dqm/settings.py),
#: so a page named "Analyzer" would collide with it.
CONFIG_ROOT = "/DQM"

#: How many hex characters of the digest a ``?v=`` token carries. Eight is
#: 4 billion values over a set of nine files that change a few times a week:
#: the collision that matters is not "two files share a token" but "one file's
#: new token equals its old one", and at this rate that will not happen before
#: the experiment ends. Short enough to read in a diff and say "that moved".
TOKEN_CHARS = 8

#: The ``?v=`` in a reference, captured. Deliberately not anchored to a quote:
#: the reference scan below has already split the name off.
_TOKEN_RE = re.compile(r"[?&]v=([^&]*)$")


def asset_token(path: Path) -> str:
    """The ``?v=`` an asset should be referenced with: a hash of its bytes.

    A hash and not a counter, which is the whole point. A counter has to be
    bumped by whoever changed the file, in a second file, in the same commit --
    and the failure when they do not is silent for a day: mhttpd serves the
    page fresh, the page asks for the token the browser already has, and the
    browser answers out of its own disk without asking anyone. It happened on
    2026-09-21 to the two files a layout change had just rewritten, and what
    made it expensive is that the page looked *fine*; it was simply the old
    one. A hash cannot be forgotten, only left unregenerated, and unlike a
    counter that is a thing a test can see.

    Of the bytes, not of a parse: a comment-only edit changes the token, which
    is correct. What ships is the file, and "did this change matter" is not a
    judgement this should be making at 3am.
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()[:TOKEN_CHARS]


def asset_refs(text: str) -> list[tuple[str, str | None]]:
    """Every ``src``/``href`` in a page, as ``(name, token)``.

    ``token`` is None when the reference carries no ``?v=`` at all. The name is
    whatever precedes the query, which is what the /Custom lookup sees.
    """
    out = []
    for ref in re.findall(r'(?:src|href)="([^"]+)"', text):
        if ref.startswith(("http://", "https://", "?", "#", "/")):
            continue
        name, _, query = ref.partition("?")
        m = _TOKEN_RE.search(ref) if query else None
        out.append((name, m.group(1) if m else None))
    return out


def stale_tokens(pages_dir: Path | None = None) -> list[str]:
    """Every asset reference whose ``?v=`` is not its file's current hash.

    Empty is good. This is the check that has to exist somewhere a human will
    meet it before a shifter does, so it is called from three places: the test
    suite, ``scripts/stamp-assets.py --check``, and ``register-pages``, which is
    the after-every-pull step on the box and therefore the last chance.

    Only *our* assets are considered. A page also loads midas.js and mplot.js,
    which mhttpd serves from its own resources and which are not ours to bust.
    """
    base = Path(pages_dir) if pages_dir else PAGES_DIR
    ours = {e.key: e for e in ENTRIES if not e.menu}
    problems: list[str] = []
    for entry in ENTRIES:
        if not entry.path.endswith(".html"):
            continue
        page = entry.resolve(base)
        if not page.is_file():
            continue
        for name, token in asset_refs(page.read_text()):
            asset = ours.get(name)
            if asset is None:
                continue                  # a stock MIDAS resource
            target = asset.resolve(base)
            if not target.is_file():
                continue                  # validate() reports a missing file
            want = asset_token(target)
            if token is None:
                problems.append(
                    f"{entry.path} loads {name} with no ?v= at all "
                    f"(should be ?v={want})")
            elif token != want:
                problems.append(
                    f"{entry.path} loads {name}?v={token}, but {name} hashes to "
                    f"{want} -- the file changed and the token did not")
    return problems


_KEY_OK = re.compile(r"^[A-Za-z0-9_.-]+$")


def check_key(name: str) -> list[str]:
    """Return the reasons ``name`` is unusable as a ``/Custom`` key. Empty is good."""
    problems: list[str] = []
    if len(name) > MAX_KEY_LENGTH:
        problems.append(f"longer than MIDAS NAME_LENGTH ({len(name)} > {MAX_KEY_LENGTH})")
    if not _KEY_OK.match(name):
        problems.append("contains a space or a regex metacharacter")
    for reserved in RESERVED_SUBSTRINGS:
        if reserved in name:
            problems.append(f"contains {reserved!r}, which mhttpd intercepts before /Custom")
    return problems


def check_entry(entry: Entry) -> list[str]:
    problems = check_key(entry.key)
    if entry.menu and "." in entry.key:
        problems.append("menu page keys must contain no dot, or mhttpd caches them for 24 h")
    if not entry.menu and "." not in entry.key:
        problems.append("asset keys should keep their extension so get_content_type() works")
    return problems


def pages(pages_dir: Path | None = None) -> list[tuple[str, Path, Entry]]:
    """The manifest as ``(odb_name, absolute_path, entry)``."""
    base = Path(pages_dir) if pages_dir else PAGES_DIR
    return [(e.odb_name, e.resolve(base), e) for e in ENTRIES]
