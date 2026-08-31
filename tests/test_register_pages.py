"""Registration behaviour, against a fake ODB. No MIDAS needed.

The cases that matter are the refusals: this script runs on every start, in
experiments we share with other groups, so "does nothing surprising" is the
whole specification.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from mdqm.install import register_pages as rp
from mdqm.install.manifest import pages

REPO = Path(__file__).resolve().parents[1]
PAGES_DIR = REPO / "pages"


class FakeClient:
    """Just enough midas.client.MidasClient to exercise register_pages.

    `odb_get` models a *directory* read as well as a leaf read, because that is
    what MIDAS does and what prune() relies on: reading "/Custom" returns its
    children rather than raising. A fake that only did leaves made prune look
    like it worked when it had in fact found nothing.
    """

    def __init__(self, initial=None):
        self.odb = dict(initial or {})
        self.writes = []
        self.deletes = []

    def odb_exists(self, path):
        return path in self.odb

    def odb_get(self, path):
        if path in self.odb:
            return self.odb[path]
        prefix = path.rstrip("/") + "/"
        children = {k[len(prefix):]: v for k, v in self.odb.items()
                    if k.startswith(prefix) and "/" not in k[len(prefix):]}
        if children:
            return children
        raise KeyError(path)

    def odb_set(self, path, value):
        self.odb[path] = value
        self.writes.append((path, value))

    def odb_delete(self, path):
        del self.odb[path]
        self.deletes.append(path)


@pytest.fixture
def entries():
    return pages(PAGES_DIR)


def test_manifest_validates_against_the_real_files(entries):
    assert rp.validate(entries) == []


def test_creates_missing_keys(entries):
    c = FakeClient()
    assert rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False) == rp.EXIT_OK
    assert len(c.writes) == len(entries)
    for odb_name, path, _ in entries:
        assert c.odb[f"/Custom/{odb_name}"] == str(path)


def test_is_idempotent(entries):
    c = FakeClient()
    rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)
    c.writes.clear()
    assert rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False) == rp.EXIT_OK
    assert c.writes == [], "a second run must write nothing"


def test_dry_run_writes_nothing(entries):
    c = FakeClient()
    assert rp.register(c, entries, PAGES_DIR, replace=False, dry_run=True) == rp.EXIT_OK
    assert c.writes == []
    assert c.odb == {}


def test_moved_checkout_heals_itself(entries):
    """A stale value that is still recognisably ours gets rewritten silently."""
    odb_name, path, _ = entries[0]
    c = FakeClient({f"/Custom/{odb_name}": "/somewhere/else/mdqm/pages/scalars.html"})
    assert rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False) == rp.EXIT_OK
    assert c.odb[f"/Custom/{odb_name}"] == str(path)


def test_refuses_a_foreign_value(entries, capsys):
    """The joined-mode guard: never take over somebody else's menu entry."""
    odb_name, _path, _ = entries[0]
    foreign = "/home/musip/musip/custom/quads.html"
    c = FakeClient({f"/Custom/{odb_name}": foreign})

    rc = rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)

    assert rc == rp.EXIT_REFUSED
    assert c.odb[f"/Custom/{odb_name}"] == foreign, "the foreign value must survive"
    err = capsys.readouterr().err
    assert foreign in err, "the refusal must name what it found"


def test_replace_overrides_the_refusal(entries):
    odb_name, path, _ = entries[0]
    c = FakeClient({f"/Custom/{odb_name}": "/home/musip/musip/custom/quads.html"})
    assert rp.register(c, entries, PAGES_DIR, replace=True, dry_run=False) == rp.EXIT_OK
    assert c.odb[f"/Custom/{odb_name}"] == str(path)


def test_refusal_does_not_stop_the_other_keys(entries):
    """One collision must not leave the rest of the page set unregistered."""
    odb_name, _path, _ = entries[0]
    c = FakeClient({f"/Custom/{odb_name}": "/home/musip/musip/custom/quads.html"})
    rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)
    assert len(c.writes) == len(entries) - 1


def test_remove_only_deletes_our_keys(entries):
    c = FakeClient()
    rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)
    foreign_name = entries[0][0]
    c.odb[f"/Custom/{foreign_name}"] = "/home/musip/musip/custom/quads.html"

    rp.unregister(c, entries, PAGES_DIR, dry_run=False)

    assert f"/Custom/{foreign_name}" in c.odb, "a foreign key must not be deleted"
    assert len(c.deletes) == len(entries) - 1


def test_registration_never_touches_custom_path(entries):
    """The single most important property in a shared experiment.

    Values are absolute, so /Custom/Path is irrelevant to us -- and musip's
    frontend rewrites it on every start. We must neither read nor write it, and
    we must never write /Custom as a subtree (odb_set would then default to
    remove_unspecified_keys=True and delete their keys).
    """
    c = FakeClient({"/Custom/Path": "/home/musip/musip/custom",
                    "/Custom/Quads": "Quads/quad_basics.html"})

    rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)

    assert c.odb["/Custom/Path"] == "/home/musip/musip/custom"
    assert c.odb["/Custom/Quads"] == "Quads/quad_basics.html"
    for path, _value in c.writes:
        assert path != "/Custom", "never write the /Custom subtree as a whole"
        assert path.startswith("/Custom/")
        assert path.count("/") == 2, f"{path} is not a flat top-level key"


def test_all_registered_values_are_absolute(entries):
    """A relative value would be resolved against /Custom/Path, which we do not own."""
    for _odb_name, path, _ in entries:
        assert str(path).startswith("/")


def test_check_reports_unreadable_and_missing(entries, capsys):
    c = FakeClient()
    rp.register(c, entries, PAGES_DIR, replace=False, dry_run=False)
    assert rp.check(c, entries) == rp.EXIT_OK

    odb_name = entries[0][0]
    c.odb[f"/Custom/{odb_name}"] = "/nonexistent/scalars.html"
    assert rp.check(c, entries) == rp.EXIT_REFUSED
    assert "UNREADABLE" in capsys.readouterr().out


class TestPruningStaleKeys:
    """Renaming must not leave the old entries behind.

    Changing the menu prefix used to orphan every page key: they still pointed at
    real files, so they still worked, and the side menu grew a duplicate of each.
    """

    def _client_with(self, extra):
        c = FakeClient()
        rp.register(c, pages(PAGES_DIR), PAGES_DIR, replace=False, dry_run=False)
        c.odb.update(extra)
        c.writes.clear()
        return c

    def test_a_stale_key_of_ours_is_removed(self):
        entries = pages(PAGES_DIR)
        stale = str(entries[0][1])            # a real file in our checkout
        c = self._client_with({"/Custom/OldName": stale})

        assert rp.prune(c, entries, PAGES_DIR, dry_run=False) == 1
        assert "/Custom/OldName" not in c.odb

    def test_another_tenant_s_key_is_never_touched(self):
        entries = pages(PAGES_DIR)
        c = self._client_with({"/Custom/Quads": "Quads/quad_basics.html",
                               "/Custom/Path": "/home/musip/musip/custom"})

        assert rp.prune(c, entries, PAGES_DIR, dry_run=False) == 0
        assert c.odb["/Custom/Quads"] == "Quads/quad_basics.html"
        assert c.odb["/Custom/Path"] == "/home/musip/musip/custom"

    def test_what_was_just_registered_is_kept(self):
        entries = pages(PAGES_DIR)
        c = self._client_with({})
        assert rp.prune(c, entries, PAGES_DIR, dry_run=False) == 0
        for odb_name, _p, _e in entries:
            assert f"/Custom/{odb_name}" in c.odb

    def test_dry_run_removes_nothing(self):
        entries = pages(PAGES_DIR)
        stale = str(entries[0][1])
        c = self._client_with({"/Custom/OldName": stale})
        assert rp.prune(c, entries, PAGES_DIR, dry_run=True) == 1
        assert "/Custom/OldName" in c.odb

    def test_a_prefix_change_leaves_exactly_the_new_names(self):
        """The scenario this exists for."""
        unprefixed = pages(PAGES_DIR)
        c = FakeClient()
        rp.register(c, unprefixed, PAGES_DIR, replace=False, dry_run=False)

        prefixed = [((("WD" + n) if e.menu else n), p, e) for n, p, e in unprefixed]
        rp.register(c, prefixed, PAGES_DIR, replace=False, dry_run=False)
        rp.prune(c, prefixed, PAGES_DIR, dry_run=False)

        menu = sorted(k.rsplit("/", 1)[1] for k in c.odb if not k.endswith("!"))
        assert all(m.startswith("WD") for m in menu), menu
