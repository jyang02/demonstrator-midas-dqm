"""The panel catalogue, and the two ways it can rot.

``pages/js/dqm-panels.js`` is generated from a spec that lives in another
repository. Two failure modes follow, and each gets a test here:

* the spec changes and this copy does not -- caught by regenerating and
  comparing, when that checkout is present. It is optional, mirroring the rule
  that repo uses for its own extracted vocabulary: a sibling checkout may not
  exist, and its absence must not fail a suite;
* a field is carried into the shipped asset that nothing reads -- caught
  hermetically by ``test_no_carried_field_is_unread``, which arrives with the
  renderer that does the reading. An unread field is precisely the rot the
  generator exists to prevent.

Everything except the first two tests runs with no sibling checkout at all.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

import pytest

from mdqm.install.manifest import ENTRIES

REPO = Path(__file__).resolve().parents[1]
CATALOGUE = REPO / "pages" / "js" / "dqm-panels.js"

SPEC = Path(os.environ.get(
    "SHIFTER_UI_SPEC", Path.home() / "demonstrator-shifter-ui" / "spec" / "dqm_shifter.json"))
needs_spec = pytest.mark.skipif(
    not SPEC.exists(), reason=f"{SPEC} is not checked out; drift cannot be checked")

#: What the spec said when this catalogue was generated. A structural test, not
#: a guess: if a panel is added or dropped upstream the drift test says so, and
#: this number is what makes the change visible in a suite run without the
#: sibling checkout.
EXPECTED_ELEMENTS = 48

#: Every ``sketch`` the renderer must have a sentence for. From the spec's own
#: vocabulary; dqm-page.js's SHAPE map has to cover it.
SKETCHES = {"hist1d", "hist2d", "trend", "table", "status", "scalar", "event", "none"}


def _gen():
    sys.path.insert(0, str(REPO / "scripts"))
    import importlib.util
    spec = importlib.util.spec_from_file_location("gen_panels", REPO / "scripts" / "gen-panels.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _catalogue() -> list[dict]:
    """The PAGES literal, parsed as strict JSON.

    The regex anchors on a closing ``];`` at column 0, which only the outer
    array has. The generator puts it there deliberately.
    """
    m = re.search(r"\nconst PAGES = (\[.*?\n\]);\n", CATALOGUE.read_text(), re.S)
    assert m, "could not find `const PAGES = [...];` in dqm-panels.js"
    return json.loads(m.group(1))


def _elements(kind: str | None = None):
    return [e for p in _catalogue() for e in p["elements"]
            if kind is None or e["kind"] == kind]


# --- drift, when the spec is reachable --------------------------------------

@needs_spec
def test_the_generated_catalogue_matches_the_spec():
    want = _gen().render(SPEC.read_text(encoding="utf-8"))
    assert CATALOGUE.read_text(encoding="utf-8") == want, (
        "pages/js/dqm-panels.js is stale. Re-run scripts/gen-panels.py, bump the "
        "?v= on every page that loads it, and read the diff -- a blocked_by that "
        "changed is a sentence a shifter reads at 3am.")


@needs_spec
def test_the_recorded_sha_is_the_spec_it_was_generated_from():
    import hashlib
    want = hashlib.sha256(SPEC.read_bytes()).hexdigest()
    assert f'const SPEC_SHA256 = "{want}";' in CATALOGUE.read_text()


# --- hermetic: these hold with no sibling checkout --------------------------

def test_the_catalogue_literal_is_strict_json():
    """No comments, no trailing commas, no JS. The assertion is that this parses."""
    _catalogue()


def test_the_catalogue_is_safe_for_show_custom_page():
    text = CATALOGUE.read_text()
    assert "<odb " not in text, "show_custom_page() rewrites legacy <odb> tags"
    assert "\x00" not in text, "show_custom_page() truncates at the first NUL"
    assert "</script" not in text, "a panel's prose must not be able to close the tag"
    assert text.isascii(), "ASCII only, so the charset mhttpd serves a .js with cannot matter"


def test_every_menu_page_has_a_catalogue_entry():
    """A registered page with no catalogue entry renders nothing at all."""
    menu = {e.key for e in ENTRIES if e.menu}
    pages = {p["page"] for p in _catalogue()}
    assert menu <= pages, f"registered with no catalogue entry: {sorted(menu - pages)}"


def test_every_blocked_element_gives_a_reason():
    """The source repo's R2, carried across the boundary.

    This is the whole product: a panel that is empty and does not say why is
    worse than no panel.
    """
    silent = [e["id"] for e in _elements()
              if e["status"] == "blocked" and len(e.get("blocked_by", "").split()) < 4]
    assert not silent, f"blocked with no usable reason: {silent}"


def test_every_dropped_element_carries_its_note():
    """The Retired page has nothing else to show: no blocked_by, no data."""
    silent = [e["id"] for e in _elements() if e["status"] == "dropped" and not e.get("note")]
    assert not silent, f"dropped with no note: {silent}"


def test_every_panel_has_a_question():
    """A panel that cannot name the question it answers is decoration."""
    silent = [e["id"] for e in _elements("panel") if not e.get("question")]
    assert not silent, f"panels with no question: {silent}"


def test_every_note_has_a_body():
    silent = [e["id"] for e in _elements("note") if not e.get("body")]
    assert not silent, f"notes with no body: {silent}"


def test_the_element_count_is_what_the_spec_said():
    assert len(_elements()) == EXPECTED_ELEMENTS


def test_the_sketch_vocabulary_is_known():
    """A sketch the renderer has no sentence for renders an empty empty-state."""
    seen = {e["sketch"] for e in _elements("panel") if e.get("sketch")}
    assert seen <= SKETCHES, f"unknown sketch kinds: {sorted(seen - SKETCHES)}"
