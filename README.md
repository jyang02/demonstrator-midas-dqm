# demonstrator-midas-dqm

The shifter screens for the ATAR8 demonstrator campaign at PSI πM1, built as
**mhttpd custom pages**. No nginx, no node, no ROOT, no ZMQ, no second web
stack: the pages are plain HTML and JavaScript served by the mhttpd the
experiment already runs, on the port operators already have open.

The page set is specified by `dqm_shifter.json`, a spec file kept outside this
repository, and `pages/js/dqm-panels.js` is generated from it — see
**Regenerating the panel catalogue** below.

Two halves, kept apart on purpose:

| generic — works at any MIDAS experiment | this experiment |
|---|---|
| the analyzer, histograms and RPC in `src/mdqm/dqm/`; `src/mdqm/install/` | `sampic.py` and `sampic_plugin.py` beside them |
| `pages/js/dqm-common.js`, `dqm-brpc.js` | `pages/js/dqm-panels.js` and the page files |

## Install

```bash
pip install -e .
mdqm-register-pages --experiment pim1        # writes the /Custom keys
```

Then open the experiment's mhttpd and pick **ATAR** from the side menu.

Upgrading a checkout that had the old six pages registered needs nothing extra:
`register_pages.prune()` runs after every successful registration and removes
any `/Custom` key pointing into this checkout that the manifest no longer lists,
which is exactly the six pages and the two renderers that went with them.

One page, **ATAR**, with four tabs. A tab is a spec group, and the tabs are the
order the questions get asked at 3am rather than the order the data arrives in.

| tab | asks | mechanism | state |
|---|---|---|---|
| **Channels** | Is every channel behaving? | analyzer | **all five draw** — occupancy, hits per event, baseline and noise as recent-value scatters, and amplitude by channel behind a per-tile toggle |
| **Scope** | What does this event look like? | event buffer | **four of five draw** — waveforms by layer, the hit-position maps, the charge-depth profile and the raw dump, all off one event; the layer hit rate waits on a counting equipment |
| **Trends** | Is the detector's response holding still? | analyzer | persistence draws behind its toggle; the average waveform is proposed, and energy-against-amplitude and the two-track rate want a calibration and track finding |
| **Proposed** | What has been asked for and not built? | — | the backlog, on the screen rather than in a document, each tile naming what it waits for |

It was six pages — Rates, Scope, Channels, Pulses, Physics and SlowControls —
organised by mechanism: what the panel read from. **Rates and SlowControls are
gone.** Every panel on Rates waited on a counting equipment nobody has
specified, and every panel on SlowControls waited on `fecaen_hv` or `featar_sc`
— and once MIDAS histories those variables, `mhttpd` trends them for free, so it
was never obvious those tiles should exist here at all. The panels that were not
about ATAR went with them. Nothing was deleted: the spec's `retired` group holds
all twenty-five with the reason each one left, so the decision is not re-argued
in November.

**Every panel that is still empty says why**, naming what it is waiting for.
That is the point of registering them: a shifter who opens the Proposed tab at
3am and finds eight titled panels, each explaining its own absence, has been
told the state of the experiment. One who finds a blank page has not, and stops
trusting the menu.

Ten of the twenty-five panels are `ready` and draw real data against a replay
today: four on Scope (waveforms, the hit-position maps, the charge-depth
profile, the raw dump), five on Channels, and persistence on Trends. Two of
those ten are colormaps and open off, a click from drawing — held for the paint
cost of a colormap, not for want of data, which is a page's choice rather than a
blocker and so not what the chip reports.

The three tabs backed by an analyzer check for one at load rather than asserting
its absence, so the reason they show is about this experiment now. The probe runs
once, at boot, and its answer is cached: a tab opened ten minutes later carries
the same footnote as the one that was open when the page loaded.

Scope was the first exception, and the reason is below: its bank layout turned
out to be documented, so the browser decoder is written and tested against real
bytes. Point it at a replay of an existing run and it draws today — and the
same bank, decoded again in the analyzer, is what Channels and Trends draw.

One blocker has since moved. `docs/sampic-bank-layout.md` is the written
specification of `AD00`/`AT00`: the physics event id, both bank names and the
full byte layout, so Scope waits on a frontend rather than on a document. It
also records what is **not** settled — a recorded run carries no ODB dump, so
every `/Equipment` path here is still a proposal, which is why they are all
editable keys.

## Tabs, and where they come from

There is no tab key in the spec. A **group** was always "one screen's worth of
panels"; all that changed is that several groups now name the same `page`, and
`gen-panels.py` collects them into one catalogue entry with a `tabs` array.
Adding a tab is adding a group.

Tabs are built **lazily**, the first time each is shown, and that is
load-bearing rather than an optimisation: `mplot` sizes a graph from its host
div, and a div inside a `display: none` tab measures zero, so a plot built while
hidden comes back blank with no error anywhere. It has a second effect worth
having — the Scope tab's event poll and the histogram timers do not start until
somebody opens the tab they are on, so a page left sitting on Channels asks
`mhttpd` for nothing that Scope would have asked for.

The open tab is in the URL as `#tab=<group>`, so "look at the Trends tab" is a
link that can be pasted into the eLog:

```
http://localhost:8088/?cmd=custom&page=ATAR#tab=atar_trends
```

An unknown or absent name opens the first tab rather than nothing.

## Regenerating the panel catalogue

Every panel's title, question, blocked-reason and alarm sentence comes from the
spec, via a generated asset:

```bash
scripts/gen-panels.py --spec path/to/dqm_shifter.json
```

Then bump the `?v=` on `dqm-panels.js` in `pages/atar.html`. `--check`
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

Every `/Equipment` path these pages name is **proposed**, not deployed. The
frontend requirements that accompany the spec say out loud that only the bank
names and the run-parameter key names are the collaboration's, and that the
equipment names, paths and types want confirming against the build actually
running at PSI.
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

### Seeing it run

`docs/replay-and-view.md` is the end-to-end recipe: which MIDAS to use, how to
stand up an experiment that cannot disturb one already running, and how to
replay a recorded run into it so the Scope tab has events to draw.

### Working without a detector

`scripts/replay-run.py` feeds a recorded run file into a live event buffer, so
everything downstream of the buffer — the Scope tab and the analyzer alike —
can be developed and tested against real events on a machine with no hardware
attached:

```bash
scripts/replay-run.py run00201.mid.lz4 --rate 15 --loop --event-id 401
```

It refuses to run while a run is active unless you insist: with the logger
recording, replayed events would be written into the run file as though they
were real data, which is a corrupted dataset nobody would notice until analysis.
With the run stopped, mlogger is not reading the buffer and nothing reaches disk.

`--loop` matters for the time base: the DRS cell-width table rides only the run's
*first* event, so restarting the file is the only way to see one again.

### Running the analyzer against that replay

`mdqm-analyzer` samples the same buffer and serves accumulated histograms over
binary RPC. The `sampic` plugin decodes AD00 with `mdqm.dqm.sampic` -- the same
layout the Scope tab decodes in the browser -- and publishes five histograms
and two recent-value series:

```bash
mdqm-analyzer --experiment DEMODQM --plugin sampic
```

It publishes occupancy, hits per event, amplitude (flat and by channel),
baseline by channel, noise by channel, and a persistence plot. It deliberately
publishes no time-over-threshold and no time-between-hits: `tot_value` is the
`TOT_ABSENT` sentinel in every hit of run 108, and hits within an event share a
`time_instant`, so both would be spikes that read as measurements. The module
docstring lists the rest of what the data will not support.

`pages/js/dqm-hists.js` draws them. Six panels claim a renderer -- occupancy,
hits per event, baseline, noise and amplitude by channel on the Channels tab,
and persistence on Trends -- each fetching one histogram and handing it to mplot
through `BRPC.display()`. The mapping from panel to histogram is the one
page-shaped fact in that file; nothing there knows which tab it is on, and it
must not: a renderer claims a panel id, and where that panel sits is the spec's
business.

Four of the six draw when their tab opens. Occupancy and hits per event are 1D
and a few hundred bins. Baseline and noise by channel are **recent-value
series** rather than histograms -- the last N values on each channel, drawn as
a scatter of channel against value -- fetched over `dqm::series` and listed in
`SERIES`.

That pair changed shape because of the question they answer, not only the cost.
"Is this channel sitting where it should" is about *now*; a colormap summed
since the run started cannot answer it, and actively hides a channel that has
walked inside a column still carrying every value it ever had. The scatter also
shows the spread within a channel, which separates a channel that has moved
from one that is merely noisy. Depth is `/DQM/Analyzer/Binning/recent per
channel`, default 10, and it is the whole cost of those tiles. Each point
carries its age, and the tile reports the oldest one drawn, because channels are
hit at very different rates and the points are not one moment.

The remaining two -- amplitude by channel on Channels, persistence on Trends --
are **colormaps and start off**, listed in `TWO_D` in that file, each with a
`Show plot` button in its own tile.
Off is a real off -- no fetch, no draw, no timer -- so a page of these costs
what a page of text costs, and the toggle lasts until the page is reloaded.

That default is not a measurement, it is a deferral. A colormap is one
rectangle per bin and mplot repaints every one of them on every arrival;
measured headless on the DAQ machine that is 1.5 ms a draw and free, but on a
real desktop over a tunnel it is reported as making the page crawl. Headless
Firefox rasterises offscreen and never composites to a screen, so both can be
true -- and when the numbers and the person disagree about whether a page is
usable, the person is right. The real fix is probably a canvas blit rather than
a rectangle per bin, and wants measuring on the machine that has the problem;
until then the page is usable and any one plot is a click away.

The rest keep the empty state and their own reason, which is the correct
outcome: crosstalk and hit-time-between-layers need a channel-to-layer map that
exists nowhere, the two energy panels want a calibration with an owner, and the
stopping and two-track panels want track finding. `channel_health` is left
unclaimed deliberately -- "dead, noisy or drifting" is a verdict rather than a
histogram, and the three tiles on the Channels tab each answer one third of it.

`amplitude_recent_by_channel` on the Proposed tab is the one worth reading
twice. The Channels tab shows amplitude as the accumulated colormap, which
answers *over the run*; the screenshot this page set was organised from asks for
the last N events, which is *now*. That is the same argument that already moved
baseline and noise onto recent-value series, and `RecentByChannel` in
`sampic_plugin.py` is the class that would carry it, so it is a contained change
-- but nobody has agreed to it, so it sits on Proposed and the tile that ships
says which question it actually answers.

With no analyzer running, a claimed panel says so itself rather than throwing:
it names the client it tried. If the analyzer stops after a plot is drawn, the
panel says the plot is stale instead of leaving it looking live.

Each plugin owns the binning its detector needs. `status()` reports an
`edge_fraction` per histogram -- the share of entries in under/overflow -- so a
range that does not fit the data says so instead of drawing an empty plot.

### Checking every tab without a detector

Each of these runs against a live mhttpd with **no demonstrator equipment at
all**, which is the state under test. `shoot.py` exits non-zero when its
condition never becomes true, so each one is a test and not only a camera.

The `#tab=` fragment is the page's own deep link, and it is what makes this a
census of tabs rather than of pages: tabs are built when first shown, so
`#dqm-root .dqm-tile` counts the open tab and nothing else.

```bash
B="http://localhost:8088/?cmd=custom&page=ATAR"
T="document.querySelectorAll('#dqm-root .dqm-tile').length"
W="document.querySelectorAll('#dqm-root .dqm-empty-why').length"

scripts/shoot.py "$B#tab=atar_channels" /tmp/channels.png --console --wait-for "$T === 5 && $W === 1"
scripts/shoot.py "$B#tab=atar_scope"    /tmp/scope.png    --console --wait-for "$T === 5 && $W === 1"
scripts/shoot.py "$B#tab=atar_trends"   /tmp/trends.png   --console --wait-for "$T === 4 && $W === 4"
scripts/shoot.py "$B#tab=atar_proposed" /tmp/proposed.png --console --wait-for "$T === 8 && $W === 8"
```

The first two hold whether or not `mdqm-analyzer` is running, which is worth
knowing before reading a failure as "the analyzer is down". `$W` counts
`.dqm-empty-why`, and a colormap tile emits one while it is off, whereas a
drawing tile that cannot reach the analyzer reports a `.dqm-diagnosis` instead.
So Channels is its amplitude colormap and nothing else, and the count is for a
freshly opened tab, before anything is toggled on -- each `Show plot` takes one
off. What moves with the analyzer is whether the four tiles that draw on open --
occupancy, hits per event, and the baseline and noise scatters -- show a plot or
a red line naming the client they tried. (Blanking `/DQM/Common/Analyzer Client`
is the one thing that would move these: with no name to try, a drawing tile
falls back to an empty-why and `$W` goes up.)

The `$W` counts are the useful ones to watch, because they say how many panels
are still explaining themselves *in a sentence*. Scope is 1 of 5: its waveform,
hit-position, charge-depth and raw-event tiles are all built, and only the layer
hit rate is left waiting on a counting equipment. Trends is 4 of 4 and Proposed
is 8 of 8, which is the honest picture of a backlog -- those two tabs are the
gap, and the tab buttons carry a count so it is legible without opening either.
That badge counts *panels that are not `ready`*, so it is 1, 3 and 8 rather than
the `$W` above: `$W` is what is on screen now, and on Trends it includes the
persistence colormap sitting behind its toggle, which is ready and drawing the
moment anyone asks.

Those invocations failing is the signal to update them.

### Seeing the page without a browser

```bash
scripts/shoot.py "http://localhost:8088/?cmd=custom&page=ATAR" out.png \
    --wait-for "document.querySelectorAll('#dqm-root .dqm-tile').length === 5" --console
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
