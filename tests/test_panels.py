"""The panel catalogue, and the two ways it can rot.

``pages/js/dqm-panels.js`` is generated from a spec that lives in another
repository. Two failure modes follow, and each gets a test here:

* the spec changes and this copy does not -- caught by regenerating and
  comparing, when that checkout is present. It is optional, mirroring the rule
  that repo uses for its own extracted vocabulary: a sibling checkout may not
  exist, and its absence must not fail a suite;
* a field is carried into the shipped asset that nothing reads -- caught
  hermetically by ``test_no_carried_field_is_unread``. An unread field is
  precisely the rot the generator exists to prevent.

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
#: sibling checkout. It counts what the catalogue ships, not what the spec
#: holds: the spec's 48 include the three-element generic group, which has not
#: been rendered since the Retired page was removed.
EXPECTED_ELEMENTS = 45

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
    """A dropped panel has no blocked_by and no data -- the note is all it has.

    Vacuous while the spec keeps every dropped panel in the generic group, which
    has had no page since the Retired page was removed. It guards the field a
    dropped panel on a kept page would depend on.
    """
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


@pytest.mark.parametrize("field", sorted(
    {k for p in _catalogue() for e in p["elements"] for k in e}))
def test_no_carried_field_is_unread(field):
    """Every field in the shipped catalogue is read by the renderer or a page.

    A field carried "in case it is useful" is the rot the generator exists to
    prevent: nothing validates it, nothing renders it, and it drifts silently.
    """
    js = "".join(f.read_text() for f in sorted((REPO / "pages" / "js").glob("*.js"))
                 if f.name != "dqm-panels.js")
    # Word-bounded: a bare `.odb` must not be satisfied by `.odbPath`, which is
    # a different thing entirely and would let an unread field pass.
    read = re.search(rf"\.{re.escape(field)}\b", js) or f'["{field}"]' in js
    assert read, (
        f"nothing in pages/js reads the {field!r} field; either use it or stop "
        f"carrying it in scripts/gen-panels.py's PANEL_FIELDS")


def test_the_sketch_vocabulary_is_known():
    """A sketch the renderer has no sentence for renders an empty empty-state."""
    seen = {e["sketch"] for e in _elements("panel") if e.get("sketch")}
    assert seen <= SKETCHES, f"unknown sketch kinds: {sorted(seen - SKETCHES)}"


# ---------------------------------------------------------------------------
# The renderers on Channels and Pulses
# ---------------------------------------------------------------------------

def _panel_histograms() -> dict[str, str]:
    """The PANELS mapping out of dqm-hists.js: panel id -> histogram name.

    Bare identifiers as keys, so this is not JSON and is read with a regex. The
    literal is anchored on a closing ``};`` at column 0, the same convention the
    DEFAULTS literal in dqm-common.js uses and for the same reason.
    """
    text = (REPO / "pages" / "js" / "dqm-hists.js").read_text()
    m = re.search(r"\nconst PANELS = \{(.*?)\n\};\n", text, re.S)
    assert m, "could not find `const PANELS = {...};` in dqm-hists.js"
    return dict(re.findall(r'(\w+):\s*"([^"]+)"', m.group(1)))


def test_every_rendered_panel_is_a_panel_that_exists():
    """A renderer claiming an id nothing publishes would never run, silently."""
    ids = {e["id"] for e in _elements()}
    unknown = sorted(set(_panel_histograms()) - ids)
    assert not unknown, f"dqm-hists.js renders ids not in the catalogue: {unknown}"


def test_the_pages_ask_for_exactly_the_histograms_they_render():
    """PANELS and /DQM/<page>/Histograms are one decision written twice.

    The renderer decides which plot goes in which tile; the config list is what
    probeAnalyzer checks against what the analyzer publishes. If they drift, a
    panel draws a histogram the page never asked for, or the page reports a
    histogram missing that no tile would have shown.
    """
    from mdqm.install.config_defaults import DEFAULTS

    asked = set()
    for page in ("Channels", "Pulses", "Physics"):
        asked |= {h for h in DEFAULTS[page]["Histograms"] if h}
    assert asked == set(_panel_histograms().values())
