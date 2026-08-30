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

    proc = subprocess.run(
        [node, "--test", "tests/js/"],
        cwd=REPO, capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        pytest.fail(f"node --test failed:\n{proc.stdout}\n{proc.stderr}")
