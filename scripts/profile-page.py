#!/usr/bin/env python3
"""Measure what a custom page costs the machine that is taking data.

A monitoring page must never affect data taking, and on this deployment the
process to watch is not ours -- it is mhttpd, which also serves run control.
Every ODB read the page makes is work in that process, so "the page has no
backend" is not by itself an argument that it is free.

    scripts/profile-page.py --tabs 0 1 2 5 --seconds 30

Reports, per tab count: mhttpd CPU as a fraction of one core, its RSS, and the
DAQ's own dropped-packet counter, against a baseline measured first with no
page open at all.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from shoot import Session  # noqa: E402

CLK = 100.0  # kernel USER_HZ; /proc/<pid>/stat ticks


def pid_of(name: str) -> int | None:
    out = subprocess.run(["pgrep", "-x", name], capture_output=True, text=True).stdout.split()
    return int(out[0]) if out else None


def cpu_ticks(pid: int) -> float:
    """utime + stime, in seconds."""
    parts = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return (int(parts[11]) + int(parts[12])) / CLK


def rss_mb(pid: int) -> float:
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1]) / 1024
    return 0.0


def odb_int(expt: str, path: str) -> int | None:
    out = subprocess.run(["odbedit", "-e", expt, "-q", "-c", f"ls -v '{path}'"],
                         capture_output=True, text=True).stdout.strip()
    try:
        return int(out.split()[0], 0)
    except (ValueError, IndexError):
        return None


def measure(pid: int, seconds: float, expt: str, dropped_path: str | None) -> dict:
    d0 = odb_int(expt, dropped_path) if dropped_path else None
    c0, t0 = cpu_ticks(pid), time.time()
    time.sleep(seconds)
    c1, t1 = cpu_ticks(pid), time.time()
    d1 = odb_int(expt, dropped_path) if dropped_path else None
    return {
        "cpu_cores": (c1 - c0) / (t1 - t0),
        "rss_mb": rss_mb(pid),
        "dropped_delta": (None if d0 is None or d1 is None else d1 - d0),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://localhost:8088/?cmd=custom&page=Scalers")
    ap.add_argument("--process", default="mhttpd", help="process to profile")
    ap.add_argument("--experiment", default="pim1")
    ap.add_argument("--dropped-path",
                    default="/Equipment/WDWaveforms/Variables/Thread/DroppedPackets",
                    help="the DAQ's own loss counter; the gate that matters")
    ap.add_argument("--tabs", type=int, nargs="+", default=[0, 1, 2, 5])
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    pid = pid_of(args.process)
    if not pid:
        print(f"error: {args.process} is not running", file=sys.stderr)
        return 2

    driver = shutil.which("geckodriver")
    if not driver:
        print("error: geckodriver not found", file=sys.stderr)
        return 2

    print(f"profiling {args.process} (pid {pid}) for {args.seconds:.0f}s per point\n")
    print(f"{'tabs':>5} {'CPU (cores)':>12} {'vs idle':>9} {'RSS MB':>8} {'dropped':>8}")

    results = []
    baseline = None
    for n in args.tabs:
        sessions = []
        try:
            for _ in range(n):
                s = Session(driver, width=1200, height=900)
                s.goto(args.url)
                sessions.append(s)
            if n:
                # Let the pages finish discovery before the clock starts, so we
                # measure steady-state polling and not one-off page build.
                time.sleep(6)

            r = measure(pid, args.seconds, args.experiment, args.dropped_path)
            r["tabs"] = n
            results.append(r)
            if baseline is None:
                baseline = r["cpu_cores"]
            delta = r["cpu_cores"] - baseline
            dropped = "-" if r["dropped_delta"] is None else str(r["dropped_delta"])
            print(f"{n:>5} {r['cpu_cores']:>12.4f} {delta:>+9.4f} "
                  f"{r['rss_mb']:>8.1f} {dropped:>8}")
        finally:
            for s in sessions:
                s.close()

    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=1))
        print(f"\nwrote {args.json}")

    per_tab = [r for r in results if r["tabs"]]
    if per_tab and baseline is not None:
        worst = max(per_tab, key=lambda r: r["tabs"])
        cost = (worst["cpu_cores"] - baseline) / worst["tabs"]
        print(f"\nmarginal cost: {cost * 100:.2f}% of one core per open tab")
        bad = [r for r in results if r["dropped_delta"]]
        if bad:
            print("WARNING: the DAQ dropped packets during this measurement.")
            return 1
        print("no packets dropped at any tab count")
    return 0


if __name__ == "__main__":
    sys.exit(main())
