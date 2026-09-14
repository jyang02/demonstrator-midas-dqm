"""The manifest rules are all ways mhttpd fails silently, so they get a test.

Nothing here needs MIDAS running.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest

from mdqm.install.config_defaults import DEFAULTS
from mdqm.install.manifest import (
    ENTRIES,
    FORBIDDEN_CONTENT,
    MAX_KEY_LENGTH,
    RESERVED_SUBSTRINGS,
    check_entry,
    check_key,
)

REPO = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_entry_name_is_legal(entry):
    assert check_entry(entry) == []


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_entry_file_exists_and_is_readable(entry):
    path = entry.resolve(REPO / "pages")
    assert path.is_file(), f"{entry.key} names a file that does not exist: {path}"
    assert os.access(path, os.R_OK)


@pytest.mark.parametrize("entry", ENTRIES, ids=lambda e: e.key)
def test_no_forbidden_content(entry):
    """show_custom_page() rewrites legacy <odb ...> tags and truncates at NUL."""
    text = entry.resolve(REPO / "pages").read_bytes()
    assert b"\x00" not in text, f"{entry.key} contains a NUL; mhttpd truncates there"
    for token in FORBIDDEN_CONTENT:
        assert token.encode() not in text, (
            f"{entry.key} contains {token!r}, which show_custom_page() will rewrite. "
            f"Split the string if it is genuinely needed."
        )


def test_menu_keys_have_no_dot():
    """A dotted key is served by send_fp(), which sets Expires: +24h.

    Menu pages must stay dot-less so an edit is visible on reload.
    """
    for entry in ENTRIES:
        if entry.menu:
            assert "." not in entry.key


def test_asset_keys_are_hidden_from_the_menu():
    for entry in ENTRIES:
        if not entry.menu:
            assert entry.odb_name.endswith("!")


def test_keys_are_unique():
    names = [e.odb_name for e in ENTRIES]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("reserved", RESERVED_SUBSTRINGS)
def test_reserved_substrings_are_rejected(reserved):
    """mhttpd's interprete() grabs these before /Custom is consulted."""
    assert check_key(f"my-{reserved}") != []


def test_long_and_spacey_keys_are_rejected():
    assert check_key("x" * (MAX_KEY_LENGTH + 1)) != []
    assert check_key("WD Scalers") != []
    assert check_key("Scalers") == []


def test_html_references_only_registered_assets():
    """Every local <script src>/<link href> must be something we register.

    An unregistered name falls through to send_resource() and either 404s or,
    worse, silently serves a stock MIDAS file of the same name.
    """
    import re

    registered = {e.key for e in ENTRIES}
    stock = {
        "midas.js", "midas.css", "mhttpd.js", "mhttpd.css", "controls.js",
        "mplot.js", "mhistory.js", "mihistory.js", "eqtable.js", "filesrw.js",
    }
    ref = re.compile(r'(?:src|href)="([^"]+)"')
    for entry in ENTRIES:
        if not entry.path.endswith(".html"):
            continue
        text = entry.resolve(REPO / "pages").read_text()
        for target in ref.findall(text):
            if target.startswith(("http://", "https://", "?", "#", "/")):
                continue
            name = target.split("?")[0]          # strip the ?v= cache buster
            assert name in registered or name in stock, (
                f"{entry.key} references {name!r}, which is neither registered "
                f"in the manifest nor a stock MIDAS resource"
            )


def _js_defaults():
    """The DEFAULTS literal out of dqm-common.js, parsed as strict JSON.

    The regex is anchored on a closing ``};`` at column 0, which only the outer
    object has -- the per-page objects inside close as ``  },``. A reformat that
    indents that brace breaks this silently, which is why the JS file says so in
    a comment above the literal.
    """
    text = (REPO / "pages" / "js" / "dqm-common.js").read_text()
    m = re.search(r"\nconst DEFAULTS = (\{.*?\n\});\n", text, re.S)
    assert m, "could not find `const DEFAULTS = {...};` in dqm-common.js"
    return json.loads(m.group(1))


def test_the_js_defaults_literal_is_strict_json():
    """No comments, no trailing commas. The assertion is that this does not raise."""
    _js_defaults()


@pytest.mark.parametrize("entry", [e for e in ENTRIES if e.menu], ids=lambda e: e.key)
def test_every_page_boots_its_own_name(entry):
    """The inline boot call is invisible to the src/href scan above.

    A page that boots under another page's name is the worst kind of wrong: it
    renders perfectly, from the wrong catalogue entry, and nothing says so.
    """
    text = entry.resolve(REPO / "pages").read_text()
    want = f'DQMPage.boot("{entry.key}")'
    assert want in text, f"{entry.path} does not contain {want}"


@pytest.mark.parametrize("entry", [e for e in ENTRIES if e.menu], ids=lambda e: e.key)
def test_every_asset_reference_carries_a_cache_buster(entry):
    """mhttpd stamps Expires:+24h on assets; a reference with no ?v= is a day stale."""
    text = entry.resolve(REPO / "pages").read_text()
    ours = {e.key for e in ENTRIES if not e.menu}
    for ref in re.findall(r'(?:src|href)="([^"]+)"', text):
        name = ref.split("?")[0]
        if name not in ours:
            continue                      # a stock MIDAS resource; not ours to bust
        assert "?v=" in ref, f"{entry.path} loads {name} with no ?v= cache buster"


def test_js_and_python_defaults_cover_the_same_roots():
    js = _js_defaults()
    assert set(js) == set(DEFAULTS), (
        f"only in JS: {set(js) - set(DEFAULTS)}; only in Python: {set(DEFAULTS) - set(js)}"
    )


@pytest.mark.parametrize("root", sorted(DEFAULTS))
def test_js_defaults_match_python_defaults(root):
    """The JS copy is what runs when /DQM is absent, so it must agree key for key."""
    js, py = _js_defaults()[root], DEFAULTS[root]
    assert set(js) == set(py), (
        f"{root}: only in JS {set(js) - set(py)}; only in Python {set(py) - set(js)}"
    )
    for key, want in py.items():
        got = js[key]
        if isinstance(want, float):
            assert float(got) == pytest.approx(want), f"{root}/{key}"
        else:
            assert got == want, f"{root}/{key}"


def test_every_config_root_is_a_registered_page():
    """A /DQM subtree nobody's page reads is a subtree nobody edits correctly."""
    menu = {e.key for e in ENTRIES if e.menu}
    orphans = set(DEFAULTS) - {"Common"} - menu
    assert not orphans, f"config subtrees with no page: {sorted(orphans)}"
