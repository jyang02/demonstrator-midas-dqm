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

`register_pages.prune()` runs after every successful registration and removes
any `/Custom` key pointing into this checkout that the manifest no longer lists,
so a checkout that moves, or a page set that changes, heals itself on the next
run rather than leaving a menu entry that 404s.

One page, **ATAR**, with four tabs. A tab is a spec group, and the tabs are the
order the questions get asked at 3am rather than the order the data arrives in.

| tab | asks | mechanism | state |
|---|---|---|---|
| **Channels** | Is every channel behaving? | analyzer | **all four draw** — occupancy as a strip-by-layer map and hits per event beside it at the top, then noise and baseline as three strip-by-layer maps each: a long average, a short one, and the difference. In ping-pong mode each is drawn twice side by side, once per channel of a pair |
| **Scope** | What does this event look like? | event buffer | **all three draw** — waveforms by layer, the hit-position maps and the charge-depth profile, every one of them off the one event on screen |
| **Trends** | Is the detector's response holding still? | analyzer | **all three draw**, each behind its own toggle — persistence, charge against amplitude, and amplitude by channel. What they have in common is that they accumulate over the run rather than showing the event in front of you, which is what makes this a tab and not three tiles on Scope |
| **Proposed** | What has been asked for and not built? | — | the backlog, on the screen rather than in a document, each tile naming what it waits for |

Panels the page set does not draw are not deleted from the spec: the `retired`
group holds them with the reason each one left, so a decision is not re-argued a
month later.

**Every panel that is empty says why**, naming what it is waiting for. That is
the point of registering them: a shifter who opens the Proposed tab at 3am and
finds ten titled panels, each explaining its own absence, has been told the
state of the experiment. One who finds a blank page has not, and stops trusting
the menu.

Ten of the twenty panels are `ready` and draw real data against a replay
today: four on Channels (the occupancy map, hits per event, the baseline maps,
the noise maps), three on Scope (waveforms, the hit-position maps, the
charge-depth profile), and three on Trends (persistence, charge against
amplitude, and amplitude by channel). Three of those ten are colormaps and open
off, a click from drawing — held for the paint cost of a colormap, not for want
of data, which is a page's choice rather than a blocker and so does not make
them part of the backlog.

The other ten are the backlog, and all ten of them are on the Proposed tab.
That is the only place on the page where a panel is waiting for something, which
is why no panel states its own status: Channels, Scope and Trends draw
everything they hold, Proposed draws nothing, and the tab is the answer.

The three tabs backed by an analyzer check for one at load rather than asserting
its absence, so the reason they show is about this experiment now. The probe runs
once, at boot, and its answer is cached: a tab opened ten minutes later carries
the same footnote as the one that was open when the page loaded.

Scope draws without an analyzer because its bank layout is written down.
`docs/sampic-bank-layout.md` specifies `AD00`/`AT00` — the physics event id,
both bank names and the full byte layout — and the browser decoder is tested
against real bytes, so pointing the page at a replay of a recorded run is enough
to draw. The same bank, decoded again in the analyzer, is what Channels and
Trends draw.

That document also records what is **not** settled: a recorded run carries no
ODB dump, so every `/Equipment` path here is a proposal, which is why they are
all editable keys.

## Tabs, and where they come from

There is no tab key in the spec. A **group** is one screen's worth of panels,
and several groups name the same `page`; `gen-panels.py` collects them into one
catalogue entry with a `tabs` array. Adding a tab is adding a group.

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
http://localhost:8090/?cmd=custom&page=ATAR#tab=atar_trends
```

An unknown or absent name opens the first tab rather than nothing.

## Regenerating the panel catalogue

Every panel's title, question, blocked-reason and alarm sentence comes from the
spec, via a generated asset:

```bash
scripts/gen-panels.py --spec path/to/dqm_shifter.json
```

Then run `scripts/stamp-assets.py`, which restamps the `?v=` on every asset
`pages/atar.html` loads. `--check` diffs without writing and exits non-zero when
the committed file is stale; `tests/test_panels.py` calls the same code path,
and skips when that checkout is not present.

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
PYTHONPATH=src python -m pytest --ignore=tests/test_analyzer.py
MDQM_NODE=/path/to/node PYTHONPATH=src python -m pytest --ignore=tests/test_analyzer.py
```

Both parts of that invocation are load-bearing.

`PYTHONPATH=src` because `import mdqm` may resolve to another checkout of this
package that happens to be installed — the analyzer is shared infrastructure and
more than one copy of it exists on the machines it runs on. Without it the
suite either tests somebody else's code or fails to import, and neither says so.

`--ignore=tests/test_analyzer.py` because that module imports
`mdqm.dqm.analyzer`, which imports `midas` at module scope. Where the MIDAS
Python bindings are absent that is a **collection** error, which aborts the
whole run rather than skipping one file — so without the flag nothing runs at
all. Everything else needs no MIDAS; run the analyzer suite where the bindings
are, which is the DAQ machine.

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

Both are regression tests, because both are silent when they are wrong.

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
charge against amplitude, baseline by channel, noise by channel, and a
persistence plot. It deliberately
publishes no time-over-threshold and no time-between-hits: `tot_value` is the
`TOT_ABSENT` sentinel in every hit of run 108, and hits within an event share a
`time_instant`, so both would be spikes that read as measurements. The module
docstring lists the rest of what the data will not support.

`pages/js/dqm-hists.js` draws them. Six panels claim a renderer -- occupancy,
hits per event, baseline and noise on the Channels tab, and amplitude by channel
and persistence on Trends. Three of those hand a histogram straight to mplot
through `BRPC.display()`; the other three are the exceptions to the
one-tile-one-plot shape, and two of them are not mplot at all.

**Occupancy and noise are drawn as the target**, on a grid of one `div` per
channel placed by strip and layer -- `ATARGeom.heatGrid()`, shared between them
so that a column is the same strip on both tiles. Occupancy is a histogram over
`dqm::histogram`, drawn as a map because its question is "where". Against the
global channel a beam spot arrives as four disconnected clumps of bars, because
that axis is `fe_board * 64 + channel` and not a position. Divs rather than an mplot
colormap because a cell has states a colour scale cannot carry -- a measured
zero is not the bottom of a ramp -- and because 256 of them is nothing beside
the 26316 rectangles the colormaps here are toggled off to avoid.

Under the occupancy map are **two rankings side by side, quietest and
busiest**, and in ping-pong mode a third under those, because a cell carries no label and the channel number is what the
ODB, the frontend, the cable map and the elog all speak. The two ends fail
differently, which is why both are there: the quiet end is a field of dark
cells in which the channel that took nothing looks like its neighbours that
took three, and nothing but a ranking finds it, while the busy end is an
obvious shape whose top channel a colour ramp still cannot name -- least of all
when the scale is clipped and several cells are drawn at the fence. Level with
each other, five rows against five, the gap between the two hits columns is
also the spread of the run. Neither judges, for the reason the noise ranking
does not. When too few channels carry distinct counts the two ends are the same
channels picked by a tie-break, and the footnote says so rather than letting
five arbitrary rows read as a finding -- which is what a run with the beam off
looks like.

**Baseline is the same renderer as noise**, `channelMaps`, with a different
series, its own pair of window keys, its own idea of what "out of family"
means, and its own rule for which half of a ping-pong pair to draw.

A map of one value per channel cannot show a baseline *walking* the way a plot
of value against time can. Two windows recover most of it -- the difference map
is signed, so which way and how far both survive -- and what a map genuinely
cannot say is *when* a walk started, or tell a slope from fattening noise on
sight. What it buys is a Channels tab where all three tiles are the same grid
read the same way, a strip is the same cell on every one of them, and there is
one implementation to be right rather than two. The full time history is in
MIDAS history instead, which the analyzer publishes; see **Trending in MIDAS
history** below.

Beside the maps in both tiles, in a column of their own, are a **distribution
of every channel's long-window average** and the rankings. The distribution is
binned over the same range as the colour key — so the plot's x axis and the
maps' scale are one axis, and a bar sits at the colour the cells of that value
are painted. It is also drawn at exactly the width of the tables under
it, sharing both their edges, so a bar and the row naming the channel it belongs
to are read down one column rather than across two widths that happen to be
similar. That width is measured from the table each tick rather than set in CSS,
because sizing the column to its content closes a loop — mplot gives its canvas
an intrinsic width taken from the column, and the canvas then counts towards the
column's own content width. Beside and not below: three grids stacked are most
of a screen tall, so a plot underneath them would be a scroll away from the
colour key it shares an axis with, and comparing a bar to the colour a cell of
that value is painted is the whole reason the plot is there. A map is as wide as
its strip count and no wider, so the column is space the tile already has. The maps are what gives way when the window is
small: they are capped at 58% of the row, so the cells narrow — a cell carries
no text and can — rather than the column wrapping at the first window that
cannot hold both at full size. Below about 1010px of tile width even that is
not enough and the row wraps, flex-wrap and not a media query, the same choice
the tile row above it makes; the two go back to being stacked and nothing is
lost but the adjacency. Above the width where 58% is more than the grids want,
the cells are exactly the size they always were. What it adds over the maps is the *shape* of
the family: one peak is a detector whose channels agree, two is a set that has
split into two populations, and a map can only show that as a mixture of
colours with no way to count the groups. A channel past the fenced end of the
scale lands in the outermost bin rather than stretching the axis and squashing
everything else into three bins. It is built from the series the tile already
has, so it costs no extra fetch and no analyzer change.

One table is common to both, under the distribution in that column:
**Moved most**, the channels whose short average is furthest from their own long
one. That question is the same whatever is being
averaged, so it is part of the shared renderer.

A tile may put a ranking of its own in front of it, and only noise does --
**Loudest**, the highest RMS, which is what out of family means when loud is
high and only high. Baseline carries no equivalent, because the highest baseline
means nothing: a set of channels all at 0.74 V is a healthy detector. What
answers that question is the map. A baseline away from where the others sit is a
cell that is not the colour of its neighbours, on a scale spanning every
channel, which is legible without a table. What a table adds over a map is the
channel number, and **Moved most** carries it for the channels that changed.

The map all three tiles lay their cells out by comes from
`pages/js/dqm-atar-geom.js`, read once from `/Equipment/SAMPIC/Settings` and
shared with the Scope tab; with no geometry there each is one row of every
channel and a line saying which key it wanted. The mapping from panel to
histogram is the one page-shaped fact in that file; nothing there knows which
tab it is on, and it must not: a renderer claims a panel id, and where that
panel sits is the spec's business.

Four of the six draw when their tab opens. Occupancy and hits per event are 1D
and a few hundred bins. Baseline and noise by channel are **recent-value
series** rather than histograms -- every value each channel has produced in the
last couple of minutes -- fetched over `dqm::series`. Neither is listed in
`/DQM/ATAR/Histograms`: the analyzer does not advertise them in `dqm::list`, so
`probeAnalyzer` would report them missing, and each tile says instead whether
its own series arrived.

The cut is by **time, not by count**, and that is the point of the series. A
fixed count is a different amount of history on every channel -- ten values is
eight seconds on a busy channel and four minutes on a quiet one, so the two ends
of one plot would be showing windows differing by a factor of thirty. `recent
seconds per channel` is a time, and the page makes its own cut on the axis the
reader can actually see. The cost follows the event rate rather than the channel
count, which `RecentByChannel` says out loud.

Time is also what the question wants. "Is this channel sitting where it should"
is about *now*; a colormap summed since the run started cannot answer it, and
actively hides a channel that has walked inside a column still carrying every
value it ever had. The depth is
`/DQM/Analyzer/Binning/recent seconds per channel`, default 120, and it is the
whole cost of those tiles. Each point carries its age, which is what lets both
tiles be honest that their points are not one moment: channels are hit at very
different rates.

Both draw **against the target**: three grids of one cell per channel each,
placed by strip and layer, showing the quantity averaged over a long window,
over a short one, and the difference. Not against the global channel, which is
the readout order -- two adjacent columns on that axis are two channels sharing
a cable rather than two strips sharing a neighbourhood, and "which strips are
loud" is a question about where they are. The three maps stack so a column is one strip
read three ways, and they are `div`s rather than an mplot colormap because a
cell has states no colour scale can carry: no value in the long window, no value
in the short one, and no older values to compare the short one against, so the
difference would be zero by construction rather than by measurement. A colormap
paints them all as the bottom of the ramp, which is the one reading they must
not get. Under each pair of maps is a ranking that names the tile's own outliers and the
channels that moved most, because a cell carries no label and the global channel
number is what the ODB, the frontend and the cable map all speak.

### Trending in MIDAS history

A map answers "where is this channel now" and cannot answer "when did it start
moving". The analyzer publishes the numbers for the second question into MIDAS
history, so `mhttpd`'s own History tab trends them and no tile here has to.

It is **off by default** — writing under `/History` is not something a
monitoring client should do to an experiment that did not ask for it. Turn it on
under `/DQM/Analyzer/Sampling`:

| key | default | what it is |
|---|---|---|
| `publish history` | `false` | write the values and create the links at all |
| `history period s` | `60` | seconds between writes, and the whole of what this costs on disk |

Values are written under `/DQM/Analyzer/History` and linked from
`/History/Links`, not fabricated as an equipment record: `/Equipment` is where
an operator looks to find out what is actually running, and an equipment there
would claim a readout that does not exist.

Three events, and the split is not cosmetic:

| event | holds |
|---|---|
| `DQM` | the scalars — `Baseline median`, `Baseline spread`, `Baseline channels`, `Baseline quiet`, the same four for `Noise`, plus `Hits per event` and `Events` |
| `DQMBaseline` | one array of per-channel baselines, one entry per channel |
| `DQMNoise` | the same for noise |

**A `/History/Links` event is one record**, and mlogger rewrites all of it on
every ODB write to any tag in it — there is no per-event minimum period, the way
`Common/Log history` throttles an equipment. With the scalars sharing an event
with the two per-channel arrays, each scalar write drags the whole of both
arrays onto disk with it: measured on this experiment's 512 channels at
**816 MB/day**, against ~11 MB/day for the split above at the 60 s period. **The cost is per name, not per byte** — another scalar is free,
another array doubles the file. That is the number to check before adding one.

Medians and inter-quartile spread rather than means and sigmas: one channel
stuck at rail moves a mean and a sigma and leaves the median where the detector
actually is. It is the same robustness argument the tiles' own fence makes, and
`_quantile` is the nearest-rank definition `dqm-hists.js` uses, so a median
quoted in history and one quoted on the page are one statistic.

A channel with nothing in the window is written as exactly `0.0`, which no real
baseline or RMS can be, so it reads as "nothing here" rather than as a
measurement — and the `channels` count beside it says how many there are. A
`NaN` would plot as a gap indistinguishable from the logger having been down.

Histograms are deliberately not published. Occupancy, amplitude and persistence
are distributions, and a distribution is not a time series: history would store
one tag per bin, and the bins only mean anything together. Occupancy's counts are monotonic
besides, so trending them draws a ramp whose slope is the only real content.

### Ping-pong mode

The digitiser can be run so that **each ATAR strip is wired to two consecutive
channels** — 0 and 1, 2 and 3 — and a deposit over threshold is recorded on
whichever of the two was not used last, which buys a second trigger inside what
would otherwise have been dead time. The ODB's `Channel map channel id` then
stops being injective: two entries carry the same pixel id, and a grid position
holds two channels rather than one.

Inverting that map naively halves the detector in silence: keyed by position in
a loop over ascending channel, the second of every pair overwrites the first and
half the channels get no cell at all, while every tile goes on reporting its
full channel count in the chips above. So a position carries a channel **list**,
and `byPos` is what the tiles paint from. `byCh` maps both halves of a pair to
the same cell, so a loop over it would paint that cell twice.

Which of a pair is "first" is **the order the channel map lists them, never the
parity of the channel number**. Pairs being (2k, 2k+1) is a cabling fact this
page is in no position to assume — the same refusal that stops it guessing the
pixel stride — and one non-ATAR channel in the middle of the map shifts the
parity of everything after it.

What each tile does with the pair differs, because the question does:

- **Occupancy sums.** "Where is the beam landing" is answered by the strip, and
  splitting the two channels across two maps would make a reader add them back
  up by eye off two scales fitted separately. The cell says how the pair
  divided, and a third ranking, **Most uneven pairs**, names the ones that did
  not divide evenly. Ranked by `|a-b| / sqrt(a+b)` — the number of standard
  deviations an even split would have — and not by the raw fraction, which
  cannot tell a strip that took three hits from one that took eight hundred.
  Dividing by the expected spread is also what keeps a quiet pair from climbing
  it. **Pairs splitting by 1 or less are left out entirely, and with none above
  that the table does not appear at all**: perfect alternation puts `|a-b|` at
  0, or at 1 when the pair has taken an odd number of hits, so that is the
  healthy state rather than a finding. On a working run this table is absent,
  which is the whole of what it has to say.
- **Noise and baseline draw each channel in its own right.** The three maps
  are duplicated into a second column beside the first, **ping** on the left
  and **pong** on the right, so a strip's two channels each get their own long
  average, short average and difference. What these tiles are asked is whether
  each *channel* is healthy, and a strip's two channels are two amplifiers with
  their own pedestal and their own noise — reducing the pair to one cell would
  answer a question nobody asked of them.

Ping is the first channel the channel map lists for a strip and pong the
second, in map order, never by the parity of the channel number. Both columns
carry the **same scale objects**, sequential and diverging alike, which is what
lets a channel be read against its neighbour across the row: two ramps fitted
separately look identical whether or not they were fitted together. The colour
keys and the per-map headings span both columns for the same reason — one
scale, one window, and a heading repeated per column would invite reading them
as two different measurements.

Neither tile draws a partner difference or a partner ranking. Both would answer
"how far apart are these two channels", which is a question about the pair
rather than about either channel, and not one these tiles are for. The pair's
own health is on the occupancy tile, as **Most uneven pairs**.

None of this is drawn on a one-channel-per-strip map. `heatGrid` reports whether
any position has two channels, and with none there is a single column, with the
same ids and the same layout. The second column is built only where there is a
second channel to put in it.

**Two things ping-pong changes that are not the DQM's to fix.** Hits per event
rises, because the recovered triggers are the point, so the `hits_per_event`
alarm's reference to "near 2.3 hits per event" is a run-108 number that wants
re-taking. And per-channel statistics halve, because a strip's hits now divide
across two channels — so the noise and baseline recent windows average half as
many values per channel as a one-channel-per-strip map would, and the "nothing
in the last 30 s" chip is the number to watch when deciding whether to widen
them.

**Every window is a setting**: `Noise Window Seconds` and `Noise Recent
Seconds` under `/DQM/ATAR`, and `Baseline Window Seconds` and `Baseline Recent
Seconds` beside them, all four defaulting to 120 s and 30 s, with an Edit button
on each chip. They are knobs rather than constants because the right numbers
follow the beam rate and what a shift is chasing, and because they cost nothing:
every cut is made by the page, by age, over the one `dqm::series` reply the
analyzer already sent, so changing any of them resets no history and asks the
analyzer for nothing.

A pair per tile rather than one pair for both, and that is the one place these
tiles are deliberately not shared. A baseline walks over minutes where a noise
excursion arrives in seconds, so narrowing one window to chase something must
not silently move the other. The defaults being equal is a starting point, not a
claim that the two quantities want the same windows.
The page clamps the long window to what the analyzer actually keeps, and the
short one to under the long, and says so in the tile when it has to -- a window
silently narrowed would be a map labelled with a number it is not drawing.

The short map is an **average over a window**, not each channel's freshest
value. A demonstrator event is ~35 hits of 256 channels, so a single value is a
single hit: a map of freshest values moves between refreshes by the noise on one
sample, which is more than most of what it is there to show, and it can only say
how old each value is by dimming the cell. A window bounds the age and averages
the single-hit scatter out, so a channel with nothing inside the short window is
simply absent there. A chip counts those, which is the number to watch when
deciding whether the short window is wide enough.

The remaining two -- amplitude by channel and persistence, both on Trends --
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
twice. The Scope tab shows amplitude as the accumulated colormap, which
answers *over the run*; what is asked for is the last N events, which is *now*.
That is the same distinction baseline and noise draw as recent-value series, and
`RecentByChannel` in `sampic_plugin.py` is the class that would carry it, so it
is a contained change -- but nobody has agreed to it, so it sits on Proposed and
the tile that ships says which question it actually answers.

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
B="http://localhost:8090/?cmd=custom&page=ATAR"
T="document.querySelectorAll('#dqm-root .dqm-tile').length"
W="document.querySelectorAll('#dqm-root .dqm-empty-why').length"

scripts/shoot.py "$B#tab=atar_channels" /tmp/channels.png --console --wait-for "$T === 4 && $W === 0"
scripts/shoot.py "$B#tab=atar_scope"    /tmp/scope.png    --console --wait-for "$T === 3 && $W === 0"
scripts/shoot.py "$B#tab=atar_trends"   /tmp/trends.png   --console --wait-for "$T === 3 && $W === 3"
scripts/shoot.py "$B#tab=atar_proposed" /tmp/proposed.png --console --wait-for "$T === 10 && $W === 10"
```

The first two hold whether or not `mdqm-analyzer` is running, which is worth
knowing before reading a failure as "the analyzer is down". `$W` counts
`.dqm-empty-why`, and a colormap tile emits one while it is off, whereas a
drawing tile that cannot reach the analyzer reports a `.dqm-diagnosis` instead.
Every colormap is on Trends now, so Channels and Scope are zero, and the count
is for a freshly opened tab, before anything is toggled on -- each `Show plot`
takes one off. What moves with the analyzer is whether the four tiles that draw
on open -- the occupancy map, hits per event, and the noise and baseline maps
-- show their cells or a red line naming the client they tried. (Blanking
`/DQM/Common/Analyzer Client` is the one thing that would move these: with no
name to try, a drawing tile falls back to an empty-why and `$W` goes up.)

The `$W` counts are the useful ones to watch, because they say how many panels
are still explaining themselves *in a sentence*. Every panel that is waiting for
something now sits on Proposed, so that tab is 10 of 10, and Channels and Scope
are both zero. Trends is 3 of 3, which is the one count worth understanding
before reading it as a gap: `$W` is what is on screen now, and all three Trends
tiles are ready colormaps sitting behind their `Show plot` toggle, drawing the
moment anyone asks. Trends holds every colormap on the page, which is why it is
the only tab whose `$W` is not zero or everything.

`$T` is the tab's panel count exactly -- no renderer adds a tile of its own, and
the three grids each map tile draws, like the eight waveform panels on Scope,
are inside their tile rather than beside it.

The tab buttons carry a count too, and it is a different number: it counts
*panels that are not `ready`*, so it is 0, 0, 0 and 10 -- only Proposed wears
one. That is the whole of the status display: panels carry no status chip and
tabs carry no strip of status counts, because with the backlog gathered onto one
tab the tab you are looking at is the status.

Those invocations failing is the signal to update them.

### Seeing the page without a browser

```bash
scripts/shoot.py "http://localhost:8090/?cmd=custom&page=ATAR" out.png \
    --wait-for "document.querySelectorAll('#dqm-root .dqm-tile').length === 4" --console
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
but **assets are not**. So a browser that has opened the page once will serve
yesterday's `.js` and `.css` off its own disk for a day without asking anyone,
and the page it builds out of them looks completely normal.

The `?v=` on each `<script src>` and `<link href>` is what defeats that, and it
is **the file's sha256, first eight characters** — not a number, and not
something to edit by hand:

```bash
scripts/stamp-assets.py
```

Run it after changing any `.js` or `.css`, and commit `pages/atar.html` with the
change. A hash is used rather than a counter because a counter has to be
remembered: when it is not, the deploy is correct, the page comes back fresh,
and every browser that has seen it before goes on drawing the old assets with
nothing errored and nothing logged. A hash cannot be forgotten, only left
unregenerated, and three things refuse that: `tests/test_manifest.py`,
`scripts/stamp-assets.py --check`, and `mdqm-register-pages`, which prints it
loudly and makes it fatal under `--check`. Registration itself still goes
through — an experiment with no pages is worse than one a hard-reload
(Ctrl-Shift-R) fixes.

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
