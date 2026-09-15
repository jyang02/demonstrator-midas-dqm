#!/usr/bin/env python3
"""Capture real demonstrator events into tests/js/demonstrator-event-fixture.json.

The run 108 fixture beside it is a single-board recording repackaged by
sampic-to-midas' converter: one FE board, no AC00, AT00 telemetry all zero.
It cannot exercise anything that only a generated demonstrator file has.

This captures events from a demonstrator file instead -- four FE boards, an
AC00 collector record, and AT00 telemetry actually filled -- so the browser
decoder is checked against bytes nobody in this repository wrote.

    python3 scripts/capture-demonstrator-events.py PATH/TO/file.mid

Needs sampic-to-midas on PYTHONPATH for its .mid reader.
"""

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mdqm.dqm import sampic as S  # noqa: E402

OUT = Path(__file__).resolve().parents[1] / "tests" / "js" / "demonstrator-event-fixture.json"
WANTED = 4
MAX_HITS = 6           # keep the fixture small; waveforms are 64 floats each


def main(path: str) -> int:
    from converter import mid_reader

    events = []
    for ev in mid_reader.iter_events(path):
        banks = {name: data for name, _tid, data in ev.banks}
        if "AC00" not in banks or "AT00" not in banks:
            continue
        hits = S.decode_ad(banks["AD00"])
        if not 2 <= len(hits) <= MAX_HITS:
            continue
        boards = {h["fe_board_index"] for h in hits}
        # The point of this fixture: more than one board in one event.
        if len(boards) < 2 and len(events) < WANTED - 1:
            continue
        events.append({
            "event_id": ev.event_id, "serial": ev.serial, "time": ev.time_stamp,
            "banks_b64": {n: base64.b64encode(d).decode() for n, d in banks.items()},
            "decoded": {
                "nhits": len(hits),
                "boards": sorted(boards),
                "channels": sorted({h["global_channel"] for h in hits}),
                "timing": S.decode_at(banks["AT00"]),
                "collector": S.decode_ac(banks["AC00"]),
                "hits": [{k: v for k, v in h.items() if k != "waveform"}
                         | {"waveform": list(h["waveform"])} for h in hits],
            },
        })
        if len(events) >= WANTED:
            break

    OUT.write_text(json.dumps({
        "_doc": (
            "Real MIDAS events from a sampic-to-midas demonstrator file: four FE "
            "boards, an AC00 collector record per event, and AT00 telemetry that "
            "is actually filled. The run 108 fixture beside this one is a "
            "single-board repackaged recording and can exercise none of that. "
            "Raw bank bytes here beside what mdqm.dqm.sampic decodes from them, "
            "so tests/js/adbank.test.js checks the browser decoder against bytes "
            "nobody in this repository wrote. Regenerate with "
            "scripts/capture-demonstrator-events.py."),
        "source": f"sampic-to-midas {Path(path).name}",
        "events": events,
    }, indent=1) + "\n")
    multi = sum(1 for e in events if len(e["decoded"]["boards"]) > 1)
    print(f"wrote {OUT}: {len(events)} events, {multi} spanning >1 board")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
