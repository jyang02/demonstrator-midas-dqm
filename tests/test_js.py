"""Run the node tests for the pure JS helpers, if node is available.

Node is not a dependency of this project and must not become one: the pages
themselves have no build step and load plain <script src>. So this is a skip,
not a failure, where node is missing -- but where it exists the JS gets the same
scrutiny as the Python.

Point $MDQM_NODE at a node binary to use a specific one.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


def find_node() -> str | None:
    explicit = os.environ.get("MDQM_NODE")
    if explicit:
        return explicit if Path(explicit).is_file() else None
    return shutil.which("node") or shutil.which("nodejs")


def test_js_helpers():
    node = find_node()
    if not node:
        pytest.skip("no node on PATH; set $MDQM_NODE to run the JS tests")

    # The files by name rather than the directory: node 22 resolves a bare
    # directory argument through the module loader and fails with
    # MODULE_NOT_FOUND, where node 18 and 20 walked it. Naming them works on all
    # three, and makes a suite that was silently not running visible.
    suites = sorted(p.name for p in (REPO / "tests" / "js").glob("*.test.js"))
    assert suites, "no JS suites found; tests/js/*.test.js is empty"

    proc = subprocess.run(
        [node, "--test", *(f"tests/js/{name}" for name in suites)],
        cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(f"node --test failed:\n{proc.stdout}\n{proc.stderr}")
