#!/usr/bin/env python3
"""Copy the first N events of a MIDAS run file, byte for byte.

A 905 MB run file is a slow thing to push across to a replay box, and the pages
are just as convincing against the first few thousand events. This cuts a slice
small enough to copy in a second.

    scripts/slice-run.py triumf_run108.mid run108-slice.mid --events 8000

Why not ``midas.file_reader``
-----------------------------
The full run files live on the machine where the data was made, which is a
developer box with no MIDAS installed -- and needing MIDAS to prepare a file
*for* a MIDAS box is a bootstrapping problem nobody wants at the moment they
need the slice. So this walks the headers itself, using nothing but the standard
library. A ``EVENT_HEADER`` is 16 bytes little-endian::

    u16 event_id, u16 trigger_mask, u32 serial_number, u32 time_stamp, u32 data_size

followed by ``data_size`` bytes of banks. Walking that needs no knowledge of
what the banks contain, which is the other reason to do it this way: the slice
is a byte-for-byte prefix of the original, so whatever the replay would have
made of the full file it makes of this, and no decoder anywhere downstream can
tell that it was cut.

Keep event 0
------------
The first record is the begin-of-run event (``event_id`` 0x8000, whose serial
number is the run number). ``replay-run.py`` skips it on the way into the buffer
-- ``is_midas_internal_event()`` -- but it is also the record that reopening the
file on ``--loop`` replays first, so a slice that starts after it is a slice
that quietly differs from the run. Taking a prefix keeps it for free.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

EVENT_HEADER = struct.Struct("<HHIII")

#: Nothing in these files comes close, so a larger `data_size` means we have
#: lost sync with the framing -- almost always because the input is not a raw
#: .mid at all but a compressed one (.mid.gz, .mid.lz4), which must be
#: decompressed first. Better to say so than to attempt a 3 GB read.
MAX_PLAUSIBLE_EVENT = 100 << 20


def slice_file(src: Path, dst: Path, count: int, verbose: bool) -> int:
    """Copy the first `count` events of `src` to `dst`. Returns how many."""
    kept = 0
    with src.open("rb") as fin, dst.open("wb") as fout:
        while kept < count:
            raw = fin.read(EVENT_HEADER.size)
            if not raw:
                break
            if len(raw) < EVENT_HEADER.size:
                print(f"warning: trailing {len(raw)} bytes are not a header; stopping",
                      file=sys.stderr)
                break

            event_id, _mask, serial, _time, size = EVENT_HEADER.unpack(raw)
            if size > MAX_PLAUSIBLE_EVENT:
                print(f"error: event {kept} claims {size} bytes. This is not a raw "
                      f".mid file -- if it is compressed, decompress it first.",
                      file=sys.stderr)
                return -1

            data = fin.read(size)
            if len(data) < size:
                print(f"warning: file ends inside event {kept}; stopping", file=sys.stderr)
                break

            fout.write(raw)
            fout.write(data)
            if verbose and (kept < 3 or kept == count - 1):
                print(f"  event {kept}: id=0x{event_id:04x} serial={serial} {size} bytes")
            kept += 1
    return kept


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("run_file", type=Path)
    ap.add_argument("out_file", type=Path)
    ap.add_argument("--events", type=int, default=8000,
                    help="how many events to keep (default: %(default)s)")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    if not args.run_file.is_file():
        print(f"error: no such run file: {args.run_file}", file=sys.stderr)
        return 2
    if args.events < 1:
        print("error: --events must be at least 1", file=sys.stderr)
        return 2

    kept = slice_file(args.run_file, args.out_file, args.events, not args.quiet)
    if kept < 0:
        return 1
    if not args.quiet:
        size = args.out_file.stat().st_size
        print(f"wrote {kept} events, {size / 1e6:.1f} MB, to {args.out_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
