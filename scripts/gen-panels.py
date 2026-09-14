#!/usr/bin/env python3
"""Generate ``pages/js/dqm-panels.js`` from demonstrator-shifter-ui's spec.

Why this is generated rather than typed
---------------------------------------
Forty-four panels each carry a label, a shift question, a reason they exist, a
reason they are blocked and a two-part alarm sentence -- about 39 kB of prose.
Those ``blocked_by`` strings *are* the product of this page set: they are what a
shifter reads at 3am when a panel is empty, and they are the strings most likely
to be edited upstream as the DAQ gets built. Copying them into seven page files
by hand guarantees drift, with nothing to detect it.

So they are generated into one asset, and ``--check`` (which is what
``tests/test_panels.py`` calls) makes drift a test failure.

Why a ``<script src>`` rather than a JSON file the page fetches
--------------------------------------------------------------
mhttpd would serve a registered ``.json`` key perfectly well, but it stamps
``Expires: <now + 24 h>`` on it with no ETag and no Last-Modified, so the
catalogue would be a day stale after every edit unless the fetch URL carried a
``?v=`` maintained by hand -- strictly worse than a script tag, where the token
sits next to the file it busts. And a fetch puts a network round trip *before*
first paint: the page could not render a single panel until it landed, which is
the blank-page-at-3am failure this whole design exists to avoid.

Stdlib only, and it reads the spec as plain JSON rather than importing
``render.model``, so it works against a bare copy of the file and that checkout
is never a build dependency of this one.

    scripts/gen-panels.py --spec ~/demonstrator-shifter-ui/spec/dqm_shifter.json
    scripts/gen-panels.py --spec ... --check        # exit 1 if the file is stale
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "pages" / "js" / "dqm-panels.js"

#: The group with no ``page`` of its own lands here. The spec's own renderer
#: calls it "Custom", which as a /Custom key would read as /Custom/Custom -- so
#: it is renamed on the way in. Passing ``--generic-page`` keeps that a flag
#: rather than a fact, for the day the spec declares a name itself.
DEFAULT_GENERIC_PAGE = "Retired"

#: Carried into the catalogue; everything else in the spec is dropped.
#:
#: The rule is that every field here has a reader in the page JS, and
#: tests/test_panels.py asserts it. A shipped field nobody reads is the rot this
#: generator exists to prevent -- which is why ``proposed_figure``, ``evidence``,
#: ``badge`` and ``cites`` do not come across: they name types in a figure
#: registry that the MIDAS conversion retired, so nothing here could validate
#: them and nothing here could use them.
PANEL_FIELDS = ("id", "kind", "label", "question", "why", "status", "size",
                "sketch", "blocked_by", "alarm", "body")


def elements_of(group: dict, generic_page: str) -> list[dict]:
    out = []
    for el in group["elements"]:
        item = {k: el[k] for k in PANEL_FIELDS if el.get(k) not in (None, "", {})}
        # A dropped panel has no blocked_by -- it is not waiting for anything,
        # it was decided against. Its _note is the only thing it can say, and
        # the Retired page is nothing but those three.
        if el.get("status") == "dropped" and el.get("_note"):
            item["note"] = el["_note"]
        odb = (el.get("targets") or {}).get("odb")
        if odb:
            item["odb"] = {k: odb[k] for k in ("path", "type", "array_size") if k in odb}
        out.append(item)
    return out


def catalogue(spec: dict, generic_page: str = DEFAULT_GENERIC_PAGE) -> list[dict]:
    """Spec -> the PAGES array, in spec order with the generic page last."""
    declared = list(spec.get("chrome", {}).get("custom_pages", []))
    pages, generic = [], []
    for group in spec["groups"]:
        name = group.get("page")
        target = generic if name in (None, "Custom") else pages
        target.append({
            "page": generic_page if name in (None, "Custom") else name,
            "group": group["id"],
            "name": group["name"],
            "question": group["question"],
            "elements": elements_of(group, generic_page),
        })
    # Menu order: the spec's declaration order, then anything it did not
    # declare, then the generic page -- which is the order a shifter reads them.
    rank = {name: i for i, name in enumerate(declared)}
    pages.sort(key=lambda p: rank.get(p["page"], len(rank)))
    return pages + generic


def render(spec_text: str, generic_page: str = DEFAULT_GENERIC_PAGE) -> str:
    spec = json.loads(spec_text)
    sha = hashlib.sha256(spec_text.encode("utf-8")).hexdigest()
    pages = catalogue(spec, generic_page)
    # ensure_ascii: the spec's one non-ASCII character is an em-dash, and
    # escaping it removes any question about the charset mhttpd serves a .js
    # with. indent=2 so a drift diff is readable line by line.
    # The closing "];" lands at column 0, which is what the drift test's regex
    # anchors on -- nothing inside the array closes that way. Same convention as
    # the DEFAULTS literal in dqm-common.js, for the same reason.
    body = json.dumps(pages, indent=2, ensure_ascii=True)
    return TEMPLATE.format(sha=sha, version=spec.get("spec_version", 1), pages=body)


TEMPLATE = '''//
// dqm-panels.js -- the panel catalogue. GENERATED; do not edit.
//
// Regenerate with:
//   scripts/gen-panels.py --spec ~/demonstrator-shifter-ui/spec/dqm_shifter.json
//
// tests/test_panels.py regenerates and compares when that checkout is present,
// and skips when it is not -- the optional-sibling rule the source repo uses
// for its own extracted vocabulary. Editing this file by hand fails that test.
//
// Every field here has a reader in dqm-page.js or a page file, and a test says
// so. Do not add one speculatively: a shipped field nobody reads is exactly the
// rot this file is generated to prevent.
//
// source:       demonstrator-shifter-ui spec/dqm_shifter.json
// spec_version: {version}
// sha256:       {sha}
//
(function (root) {{
"use strict";

const SPEC_SHA256 = "{sha}";

// Strict JSON on purpose: tests/test_panels.py slices this literal out with a
// regex and json.loads() it, the same trick tests/test_manifest.py plays on
// DEFAULTS in dqm-common.js. No comments, no trailing commas, no JS inside.
const PAGES = {pages};

const BY_ID = {{}};
PAGES.forEach(function (p) {{
  p.elements.forEach(function (e) {{ e.page = p.page; BY_ID[e.id] = e; }});
}});

/** The catalogue entry for one page, or null. */
function byPage(name) {{
  for (let i = 0; i < PAGES.length; i++) if (PAGES[i].page === name) return PAGES[i];
  return null;
}}

const DQMPanels = {{ SPEC_SHA256, PAGES, BY_ID, byPage }};
root.DQMPanels = DQMPanels;
if (typeof module !== "undefined" && module.exports) module.exports = DQMPanels;

}})(typeof globalThis !== "undefined" ? globalThis : this);
'''


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--spec", required=True, type=Path,
                    help="path to demonstrator-shifter-ui/spec/dqm_shifter.json")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--generic-page", default=DEFAULT_GENERIC_PAGE,
                    help="key for the group the spec gives no page of its own")
    ap.add_argument("--check", action="store_true",
                    help="diff against the committed file and exit 1 if stale")
    args = ap.parse_args(argv)

    if not args.spec.exists():
        print(f"no spec at {args.spec}", file=sys.stderr)
        return 2
    want = render(args.spec.read_text(encoding="utf-8"), args.generic_page)

    if not args.check:
        args.out.write_text(want, encoding="utf-8")
        n = sum(len(p["elements"]) for p in catalogue(json.loads(args.spec.read_text()),
                                                     args.generic_page))
        print(f"wrote {args.out} ({n} elements, {len(want)} bytes)")
        return 0

    got = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
    if got == want:
        return 0
    sys.stdout.writelines(difflib.unified_diff(
        got.splitlines(keepends=True), want.splitlines(keepends=True),
        fromfile=f"{args.out} (committed)", tofile="regenerated from the spec"))
    print(f"\n{args.out} is stale; re-run without --check.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
