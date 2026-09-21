#!/usr/bin/env python3
"""Stamp each ``?v=`` in a page with the hash of the file it busts.

mhttpd puts ``Expires: <now + 24 h>`` on anything served through ``send_fp()``,
with no ``ETag`` and no ``Last-Modified``. Pages escape that because their
``/Custom`` key has no dot and so routes through ``show_custom_page()``, but
every ``.js`` and ``.css`` is stamped -- so a browser that has loaded the page
once will serve yesterday's asset off its own disk for a day without asking
anyone whether it changed.

The ``?v=`` in the page is what defeats that, and it is the file's **hash**
rather than a number bumped by hand. A hand-maintained number fails silently:
the file is rewritten, the number beside it is not, the page comes back fresh
and asks for the token the browser already has, and the dashboard is quietly not
the one that was just deployed. Nothing is broken and nothing is logged.

A hash cannot be forgotten, only left unregenerated -- and that is a thing a
test can see, which a forgotten counter is not. Run this after changing any
asset:

    scripts/stamp-assets.py
    scripts/stamp-assets.py --check      # exit 1 if any token is stale
    scripts/stamp-assets.py --dry-run    # say what would change

``--check`` is what ``tests/test_manifest.py`` and ``mdqm-register-pages`` both
call underneath, so there is one definition of stale and three places that meet
it: the suite, the deploy step on the box, and this.

Stdlib only, and the rules live in ``mdqm.install.manifest`` rather than here,
because what counts as one of our assets is the manifest's business and this is
only the thing that writes.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mdqm.install.manifest import (  # noqa: E402  - after the path insert
    ENTRIES, PAGES_DIR, asset_token, stale_tokens,
)


def restamp(text: str, pages_dir: Path) -> tuple[str, list[str]]:
    """Rewrite every one of our ``?v=`` tokens in one page. Returns (text, notes).

    Rewrites in place rather than rebuilding the tag, so a reference keeps
    whatever else it carries and the diff is the eight characters that moved and
    nothing else. A page is hand-written and full of comments explaining why one
    script is loaded before another; regenerating it from a template would throw
    all of that away to solve a problem that is eight characters wide.
    """
    ours = {e.key: e for e in ENTRIES if not e.menu}
    notes: list[str] = []

    def sub(m: re.Match) -> str:
        attr, name, query = m.group(1), m.group(2), m.group(3) or ""
        asset = ours.get(name)
        if asset is None:
            return m.group(0)             # a stock MIDAS resource, not ours
        target = asset.resolve(pages_dir)
        if not target.is_file():
            notes.append(f"  ! {name} has no file at {target}, left alone")
            return m.group(0)
        want = asset_token(target)
        had = re.search(r"[?&]v=([^&\"]*)", query)
        if had and had.group(1) == want:
            return m.group(0)
        notes.append(f"  ~ {name:22s} {had.group(1) if had else '(none)'} -> {want}")
        # Any other query parameters are kept; only v= is replaced, and a
        # reference with no v= at all gains one.
        if had:
            q = re.sub(r"([?&]v=)[^&\"]*", lambda k: k.group(1) + want, query)
        else:
            q = (query + "&v=" + want) if query else "?v=" + want
        return f'{attr}="{name}{q}"'

    out = re.sub(r'(src|href)="([^"?]+)(\?[^"]*)?"', sub, text)
    return out, notes


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pages", type=Path, default=PAGES_DIR,
                    help="the pages/ directory to stamp (default: this checkout's)")
    ap.add_argument("--check", action="store_true",
                    help="write nothing; exit 1 if any token is stale")
    ap.add_argument("--dry-run", action="store_true",
                    help="say what would change without writing it")
    args = ap.parse_args(argv)

    if args.check:
        problems = stale_tokens(args.pages)
        for p in problems:
            print(f"  x {p}")
        if problems:
            print(f"\n{len(problems)} stale token(s); run scripts/stamp-assets.py.",
                  file=sys.stderr)
            return 1
        print("every ?v= is its file's hash")
        return 0

    changed = 0
    for entry in ENTRIES:
        if not entry.path.endswith(".html"):
            continue
        page = entry.resolve(args.pages)
        if not page.is_file():
            print(f"  ! {entry.path} missing at {page}", file=sys.stderr)
            continue
        text = page.read_text(encoding="utf-8")
        out, notes = restamp(text, args.pages)
        if out == text:
            print(f"  = {entry.path} already stamped")
            continue
        print(f"  {'~' if not args.dry_run else '?'} {entry.path}")
        for n in notes:
            print(n)
        if not args.dry_run:
            page.write_text(out, encoding="utf-8")
        changed += 1

    if args.dry_run:
        print(f"\n{changed} page(s) would change (dry run)")
    else:
        print(f"\n{changed} page(s) restamped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
