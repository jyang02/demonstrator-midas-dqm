#!/usr/bin/env python3
"""Screenshot a page after its JavaScript has actually finished.

`firefox --screenshot` fires on the load event, which for any MIDAS page is
long before the content exists -- the stock status page photographs as the word
"Loading...". So this drives geckodriver over plain WebDriver HTTP (no selenium
dependency) and waits for a condition you supply.

    scripts/shoot.py URL out.png
    scripts/shoot.py URL out.png --wait-for "document.querySelector('.dqm-chip')"
    scripts/shoot.py URL out.png --console          # also dump console + JS errors

Exit code is non-zero if the wait condition never became true, so it is usable
as a test rather than only as a screenshot tool.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def rq(method: str, url: str, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url} -> {e.code}: {e.read().decode()[:400]}") from None


class Session:
    def __init__(self, driver: str, headless: bool = True, width=1400, height=1200):
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.proc = subprocess.Popen(
            [driver, "--port", str(self.port), "--log", "fatal"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _attempt in range(100):
            try:
                rq("GET", f"{self.base}/status", timeout=1)
                break
            except Exception:
                time.sleep(0.1)
        else:
            raise RuntimeError("geckodriver did not come up")

        args = ["-width", str(width), "-height", str(height)]
        if headless:
            args.insert(0, "-headless")
        caps = {"capabilities": {"alwaysMatch": {
            "browserName": "firefox",
            # Do not let the driver dismiss dialogs behind our back. MIDAS uses
            # dlgAlert() to report real errors ("mhttpd_init() called more than
            # once", "unknown plot type"), and a harness that silently clicks
            # them away turns a loud failure into a mystery.
            "unhandledPromptBehavior": "ignore",
            # A throwaway profile: the user very likely has Firefox open, and
            # sharing a profile makes it refuse to start a second instance.
            "moz:firefoxOptions": {"args": args, "prefs": {
                "browser.shell.checkDefaultBrowser": False,
                "devtools.console.stdout.content": True,
            }},
        }}}
        self.id = rq("POST", f"{self.base}/session", caps, timeout=90)["value"]["sessionId"]
        self.url = f"{self.base}/session/{self.id}"

    def goto(self, url: str):
        rq("POST", f"{self.url}/url", {"url": url}, timeout=60)

    def script(self, src: str, args=None):
        return rq("POST", f"{self.url}/execute/sync",
                  {"script": src, "args": args or []})["value"]

    def alert_text(self) -> str | None:
        """The text of an open alert, or None. Never raises."""
        try:
            return rq("GET", f"{self.url}/alert/text", timeout=5).get("value")
        except Exception:
            return None

    def dismiss_alert(self) -> None:
        with contextlib.suppress(Exception):
            rq("POST", f"{self.url}/alert/dismiss", {}, timeout=5)

    def screenshot(self) -> bytes:
        return base64.b64decode(rq("GET", f"{self.url}/screenshot", timeout=60)["value"])

    def close(self):
        # Best effort: if the session is already gone the driver is about to be
        # killed anyway, and a teardown that raises hides the real failure.
        with contextlib.suppress(Exception):
            rq("DELETE", self.url, timeout=10)
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


# Installed before the page's own scripts run, so nothing is missed.
CAPTURE_CONSOLE = """
window.__log = [];
for (const k of ["log", "warn", "error", "info"]) {
  const orig = console[k].bind(console);
  console[k] = function (...a) {
    window.__log.push(k + ": " + a.map(String).join(" "));
    orig(...a);
  };
}
window.addEventListener("error", (e) =>
  window.__log.push("EXCEPTION: " + e.message + " @" + e.filename + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) =>
  window.__log.push("REJECTION: " + e.reason));
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--wait-for", default=None,
                    help="JS expression polled until truthy (default: document.readyState)")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--settle", type=float, default=0.7,
                    help="extra seconds after the condition, for paint")
    ap.add_argument("--width", type=int, default=1400)
    ap.add_argument("--height", type=int, default=1200)
    ap.add_argument("--console", action="store_true", help="print console output and errors")
    ap.add_argument("--driver", default=os.environ.get("MDQM_GECKODRIVER") or
                    shutil.which("geckodriver"))
    args = ap.parse_args()

    if not args.driver:
        print("error: geckodriver not found; set $MDQM_GECKODRIVER", file=sys.stderr)
        return 2

    s = Session(args.driver, width=args.width, height=args.height)
    try:
        # about:blank first so the console hook is in place before the real page.
        s.goto("about:blank")
        s.script(f"window.__hook = true; {CAPTURE_CONSOLE}")
        s.goto(args.url)
        s.script(CAPTURE_CONSOLE)

        cond = args.wait_for or "document.readyState === 'complete'"
        deadline = time.time() + args.timeout
        ok = False
        while time.time() < deadline:
            alert = s.alert_text()
            if alert is not None:
                print(f"error: the page raised a dialog: {alert}", file=sys.stderr)
                s.dismiss_alert()
                return 1
            try:
                if s.script(f"return !!({cond});"):
                    ok = True
                    break
            except RuntimeError:
                pass                       # page still navigating
            time.sleep(0.15)

        time.sleep(args.settle)

        if args.console:
            for line in s.script("return window.__log || [];") or []:
                print(f"  [console] {line}")

        if args.out:
            with open(args.out, "wb") as f:
                f.write(s.screenshot())
            print(f"wrote {args.out}")

        if not ok:
            print(f"error: condition never became true: {cond}", file=sys.stderr)
            text = s.script("return document.body ? document.body.innerText.slice(0,600) : '';")
            print(f"body text was:\n{text}", file=sys.stderr)
            return 1
        return 0
    finally:
        s.close()


if __name__ == "__main__":
    sys.exit(main())
