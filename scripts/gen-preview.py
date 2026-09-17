#!/usr/bin/env python3
"""Build a self-contained HTML preview of the Scope tab, with real events in it.

The Scope tab needs a live MIDAS to do anything, which makes it the one part of
this set you cannot review by opening a file. This assembles the real page code
-- dqm-common, dqm-panels, dqm-page, dqm-adbanks, dqm-scope, unmodified -- with
a stubbed MIDAS surface and a few dozen real events from a run file baked in, so
the decoding and the layout can be looked at on a laptop.

What it is good for: the panel layout, the empty states, the blocked reasons,
the decoded hit scalars in the raw-event table, the channel picker, the status
line. What it is NOT good for: judging the plot. mplot.js is a MIDAS resource
and is not vendored here, so the preview substitutes a minimal canvas plotter
with the same call surface. A trace that looks wrong here may look fine in
mhttpd, and vice versa.

    scripts/gen-preview.py --run path/to/triumf_run108.mid -o /tmp/scope.html
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import struct
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
EVENT_HEADER = struct.Struct("<HHIII")
BANK32A = struct.Struct("<III")


def read_events(path: Path, want: int, event_id: int) -> list[dict]:
    """Pull `want` physics events out of a .mid, keeping the bank bytes verbatim."""
    events: list[dict] = []
    with path.open("rb") as f:
        while len(events) < want:
            head = f.read(EVENT_HEADER.size)
            if len(head) < EVENT_HEADER.size:
                break
            eid, _mask, serial, stamp, dsize = EVENT_HEADER.unpack(head)
            data = f.read(dsize)
            if eid != event_id:
                continue                      # BOR/EOR and other frontends
            banks, off = {}, 8                # past the bank header
            while off + 16 <= len(data):
                name = data[off:off + 4].decode("ascii", "replace")
                _tid, bsize, _ = BANK32A.unpack(data[off + 4:off + 16])
                banks[name] = base64.b64encode(data[off + 16:off + 16 + bsize]).decode()
                off += 16 + ((bsize + 7) & ~7)
            if "AD00" in banks:
                events.append({"event_id": eid, "serial_number": serial,
                               "time_stamp": stamp, "banks": banks})
    return events


def defaults() -> dict:
    text = (REPO / "pages" / "js" / "dqm-common.js").read_text()
    return json.loads(re.search(r"\nconst DEFAULTS = (\{.*?\n\});\n", text, re.S).group(1))


def build(events: list[dict]) -> str:
    asset = lambda p: (REPO / p).read_text()
    template = (Path(__file__).resolve().parent / "preview-template.html").read_text()
    return (template
            .replace("__DQMCSS__", asset("pages/css/dqm.css"))
            .replace("__EVENTS__", json.dumps(events))
            .replace("__CFG__", json.dumps(defaults()))
            .replace("__N__", str(len(events)))
            .replace("__COMMON__", asset("pages/js/dqm-common.js"))
            .replace("__PANELS__", asset("pages/js/dqm-panels.js"))
            .replace("__PAGE__", asset("pages/js/dqm-page.js"))
            .replace("__ADBANKS__", asset("pages/js/dqm-adbanks.js"))
            .replace("__SCOPE__", asset("pages/js/dqm-scope.js")))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", type=Path, required=True, help="a .mid run file to read events from")
    ap.add_argument("-o", "--out", type=Path, default=Path("scope-preview.html"))
    ap.add_argument("--events", type=int, default=60, help="how many to bake in")
    ap.add_argument("--event-id", type=int, default=1, help="the physics event id")
    args = ap.parse_args(argv)

    if not args.run.exists():
        print(f"no run file at {args.run}", file=sys.stderr)
        return 2
    events = read_events(args.run, args.events, args.event_id)
    if not events:
        print(f"no event id {args.event_id} carrying an AD00 bank in {args.run}", file=sys.stderr)
        return 1

    args.out.write_text(build(events))
    print(f"{len(events)} events -> {args.out} ({args.out.stat().st_size // 1024} kB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
