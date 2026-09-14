# demonstrator-midas-dqm

The shifter screens for the ATAR8 demonstrator campaign at PSI πM1, built as
**mhttpd custom pages**. No nginx, no node, no ROOT, no ZMQ, no second web
stack: the pages are plain HTML and JavaScript served by the mhttpd the
experiment already runs, on the port operators already have open.

Forked from [wavedream-midas-dqm](https://github.com/jlabounty/wavedream-midas-dqm),
which is the same architecture proven at a different experiment. `main` still
holds that state, so `git log main..demonstrator-pages` is the whole diff. What
carried over is the framework; what left is WaveDream's own pages and plugin.

The page set is specified in `demonstrator-shifter-ui` (`spec/dqm_shifter.json`),
and `pages/js/dqm-panels.js` is generated from it — see **Regenerating the panel
catalogue** below.

Two halves, kept apart on purpose:

| generic — works at any MIDAS experiment | this experiment |
|---|---|
| `src/mdqm/dqm/`, `src/mdqm/install/` | `src/mdqm/plugins/` (empty — no plugin yet) |
| `pages/js/dqm-common.js`, `dqm-brpc.js` | `pages/js/dqm-panels.js` and the page files |

## Install

```bash
pip install -e .
mdqm-register-pages --experiment pim1        # writes the /Custom keys
```

Then open the experiment's mhttpd and pick a page from the side menu.

| page | asks | mechanism | waiting on |
|---|---|---|---|
| **Rates** | Is anything arriving, and at what rate? | ODB + history | a counting equipment; `fetrigger`, `fecalo`, `femupix` |
| **Scope** | What does this event look like? | event buffer | **decoder built** — waits only on a frontend writing `AD00`/`AT00` into a live buffer |
| **Channels** | Is every channel behaving? | analyzer | the bank, and the analyzer client nobody has started |
| **Pulses** | What does a pulse look like, and what is it worth? | analyzer | the above, plus an energy calibration with an owner |
| **Physics** | Does this look like stopped muons? | analyzer | the above, plus track finding |
| **SlowControls** | Is the hardware where it should be? | ODB + history | `fecaen_hv` and `featar_sc`; and for humidity, a name in the run-conditions vocabulary |
| **Retired** | What did the webapp carry that these pages do not? | — | nothing; it records three decisions so they are not re-argued |

Forty-one of the forty-four panels are blocked, and **every one of them says so
in the panel**, naming what it is waiting for. That is the point of registering
them: a shifter who opens Channels at 3am and finds eleven titled panels each
explaining its own absence has been told the state of the experiment. One who
finds a blank page has not, and stops trusting the menu.

The three pages backed by an analyzer check for one at load rather than
asserting its absence, so the reason they show is about this experiment now.

Scope is the exception, and the reason is below: its bank layout turned out to
be documented, so the browser decoder is written and tested against real bytes.
Point it at a replay of an existing run and it draws today.

One blocker has since moved. `docs/sampic-bank-verification.md` records what
`~/sampic-to-midas` settles: the physics event id, both bank names and the full
`AD00`/`AT00` byte layout are confirmed, so Scope is waiting on a frontend
rather than on a document. It also records what that file does **not** settle —
its run has no ODB dump in it, so every `/Equipment` path here is still a
proposal from `frontend_requirements.md`, which is why they are all editable
keys.

## Regenerating the panel catalogue

Every panel's title, question, blocked-reason and alarm sentence comes from the
spec, via a generated asset:

```bash
scripts/gen-panels.py --spec ~/demonstrator-shifter-ui/spec/dqm_shifter.json
```

Then bump the `?v=` on `dqm-panels.js` in every page that loads it. `--check`
diffs without writing and exits non-zero when the committed file is stale;
`tests/test_panels.py` calls the same code path, and skips when that checkout is
not present.

`--list` shows what would be registered, `--dry-run` says what would change,
`--check` verifies every registered key still resolves to a readable file, and
`--remove` unregisters (only the keys pointing into this checkout).

Registration is idempotent and safe to run on every start — that is how a moved
checkout heals itself.

## Sharing an experiment

The pages register as `/Custom/<name>` keys holding **absolute** paths, and never
read or write `/Custom/Path`. That is what makes them safe as a guest: another
group's frontend may rewrite `/Custom/Path` on every start (musip's does) without
affecting us at all.

Use `--prefix` to namespace the menu entries if a name might collide:

```bash
mdqm-register-pages --experiment Mu3e --prefix WD
```

The prefix must be space-free, for the same reason the keys are: the key becomes
both `?cmd=custom&page=<key>` and the argument to `mhttpd_init()`.

Registration **refuses** to overwrite a key whose value points outside this
checkout, and says what it found. It never writes `/Custom` as a subtree.

## Configuration

Every page reads its configuration from the ODB at load; nothing is compiled in.
Overrides live under `/DQM` — `/DQM/<Page>` for one page's own keys, `/DQM`
itself for what they all share — seeded by the installer. With a subtree absent
the page uses identical built-in defaults and says so, so it works on an
experiment nobody has set up.

This matters more here than it did upstream. Every `/Equipment` path these pages
name is **proposed**, not deployed: `demonstrator-shifter-ui`'s
`docs/frontend_requirements.md` says out loud that only the bank names and the
run-parameter key names are the collaboration's, and that the equipment names,
paths and types want confirming against the build actually running at PSI.
Correcting one has to be an ODB edit during a shift, not a patch — so every
panel that comes up empty because a configured path did not resolve offers a
button that opens that key in the ODB editor.

## Development

```bash
python -m pytest                                    # no MIDAS needed
MDQM_NODE=/path/to/node python -m pytest            # + the JavaScript tests
```

The JS tests run the real page code against fixtures captured verbatim from a
live ODB, using a small DOM stub in `tests/js/domstub.js` rather than a browser.
Node is **not** a dependency — the pages have no build step — so those tests skip
where it is missing.

`tests/js/domstub.js` models mhttpd's refresh loop rather than approximating it,
because its contract is where this page is easiest to get wrong. Two rules are
worth knowing before touching a handler:

- **A `modb` watcher's first value fires `onload`, not `onchange`.** mhttpd
  stores it silently and fires `onchange` only on *subsequent* changes. A
  handler wired to `onchange` alone never runs while the ODB is static — which
  is exactly the case when the frontend it is monitoring has died.
- **A `modbvalue`'s `innerHTML` is rewritten every tick**, but `onchange` fires
  only on change. Anything that renders text from a handler is correct for one
  tick and then silently reverts.

Both of those shipped as bugs during development and are now regression tests.

### Working without a detector

`scripts/replay-run.py` feeds a recorded run file into a live event buffer, so
everything downstream of the buffer — the Scope page, and the analyzer when one
exists — can be developed and tested against real events on a machine with no
hardware attached:

```bash
scripts/replay-run.py run00201.mid.lz4 --rate 15 --loop --event-id 401
```

It refuses to run while a run is active unless you insist: with the logger
recording, replayed events would be written into the run file as though they
were real data, which is a corrupted dataset nobody would notice until analysis.
With the run stopped, mlogger is not reading the buffer and nothing reaches disk.

`--loop` matters for the time base: the DRS cell-width table rides only the run's
*first* event, so restarting the file is the only way to see one again.

### Checking every page without a detector

Each of these runs against a live mhttpd with **no demonstrator equipment at
all**, which is the state under test. `shoot.py` exits non-zero when its
condition never becomes true, so each one is a test and not only a camera.

```bash
B="http://localhost:8088/?cmd=custom&page"
T="document.querySelectorAll('#dqm-root .dqm-tile').length"
W="document.querySelectorAll('#dqm-root .dqm-empty-why').length"

scripts/shoot.py "$B=Rates"        /tmp/rates.png        --console --wait-for "$T === 9"
scripts/shoot.py "$B=Scope"        /tmp/scope.png        --console --wait-for "$T === 5 && $W === 3"
scripts/shoot.py "$B=Channels"     /tmp/channels.png     --console --wait-for "$T === 11 && $W === 11"
scripts/shoot.py "$B=Pulses"       /tmp/pulses.png       --console --wait-for "$T === 4 && $W === 4"
scripts/shoot.py "$B=Physics"      /tmp/physics.png      --console --wait-for "$T === 6"
scripts/shoot.py "$B=SlowControls" /tmp/slowcontrols.png --console --wait-for "$T === 6 && $W === 6"
scripts/shoot.py "$B=Retired"      /tmp/retired.png      --console --wait-for "$T === 3"
```

The `$W` counts are the useful ones to watch, because they say how many panels
are still explaining themselves. SlowControls drops from 6 to 5 the day
`featar_sc` exists; Scope is already at 3 of 5 because its waveform and
raw-event panels are built. Those invocations failing is the signal to update
them.

### Seeing the page without a browser

```bash
scripts/shoot.py "http://localhost:8088/?cmd=custom&page=Rates" out.png \
    --wait-for "document.querySelectorAll('#dqm-root .dqm-tile').length === 9" --console
```

`firefox --screenshot` is not usable here: it fires on the load event, which for
any MIDAS page is long before the content exists — the stock status page
photographs as the word "Loading...". `shoot.py` drives geckodriver over plain
WebDriver HTTP (no selenium dependency), waits for a condition you name, and can
dump the console and any uncaught exceptions. It exits non-zero if the condition
never becomes true, so it works as a test and not only as a camera.

### The one thing that will waste your afternoon

mhttpd stamps `Expires: <now + 24 h>` on anything served through `send_fp()`,
with no `ETag` and no `Last-Modified`. Pages are exempt because their `/Custom`
key contains no dot, which routes them through `show_custom_page()` instead —
but **assets are not**. Bump the `?v=` on the `<script src>` and `<link href>`
when you change a `.js` or `.css` file, or hard-reload (Ctrl-Shift-R).

## Troubleshooting

**`show_custom_page: Cannot open file ... errno 13`** — mhttpd's uid cannot read
the file. `mdqm-register-pages --check` tests readability from *its own* uid,
which is necessary and not sufficient; check the whole path is traversable by
whoever runs mhttpd.

**The side menu shows a page that 404s** — the checkout moved. Re-run
`mdqm-register-pages`; it rewrites values that are recognisably stale copies of
its own.

**`/Custom/Path` appeared as an empty string** — mhttpd creates it itself on the
first unmatched URL once `/Custom` exists. Expected; leave it alone.
