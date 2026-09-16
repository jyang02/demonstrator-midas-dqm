# Replaying a run and looking at the page

The Scope page decodes one event out of a live event buffer, so seeing it work
needs three things: a MIDAS with `mplot.js`, an experiment, and something putting
`AD00` banks into a buffer. There is no detector, so the third is a replay of an
existing run file. Channels and Pulses need a fourth, an analyzer, because a
histogram is accumulated across events and the browser only ever sees one.

## Without MIDAS at all

`scripts/gen-preview.py` builds a single self-contained HTML file with real
events from run 108 baked in, running the real page code against stubbed MIDAS
calls. The plot widget is a minimal stand-in for `mplot.js`, so it is good for
judging layout, decoded numbers and empty states, and not for judging the plot.

## On pionline (192.168.40.106)

MIDAS, firefox and geckodriver are all installed there; Python packaging is
not, which the setup below works around rather than fixes. Three traps first,
each of which costs an afternoon if you meet it the other way round.

**Use the right MIDAS.** There are two.

| | has `mplot.js` | use it? |
|---|---|---|
| `~/midas/install` (March 2023) | **no** | no — the Scope and Waveforms pages need `MPlotGraph` and would silently load nothing |
| `~josh/modern_midas/install` | yes | **yes** — this is the one `mhttpd` is already running from |

**Do not disturb WDSCALERS.** `mhttpd -e WDSCALERS` and `mlogger -e WDSCALERS`
have been up for days on port 8088; that is somebody else's experiment. Never
replay SAMPIC events into its buffer and never register pages into its ODB. The
recipe below builds a *separate* experiment, with its own exptab, its own shared
memory and its own port, which cannot reach it.

**And `import midas` is booby-trapped from `~`.** `~/midas` is a build tree, and
Python treats it as a namespace package when the current directory is the home
directory, so `import midas` succeeds and `import midas.client` then fails. Run
from anywhere else, or keep `PYTHONPATH` pointing at the real bindings as below.

### One-time setup

The environment is long enough that retyping it is its own source of bugs, so
put it in a file and source it at the top of every step. This assumes the clone
is at `~/demonstrator-midas-dqm`; point `REPO` wherever yours actually landed.

```bash
ssh pioneer@192.168.40.106
mkdir -p ~/demo-dqm/expt

cat > ~/demo-dqm/env.sh <<'EOF'
export MIDASSYS=/home/pioneer/josh/modern_midas/install
export PATH=$MIDASSYS/bin:$PATH
export LD_LIBRARY_PATH=$MIDASSYS/lib:$LD_LIBRARY_PATH
export REPO=/home/pioneer/demonstrator-midas-dqm
export PYTHONPATH=$REPO/src:/home/pioneer/josh/modern_midas/midas/python
export MIDAS_EXPTAB=/home/pioneer/demo-dqm/exptab
export MIDAS_EXPT_NAME=DEMODQM
EOF

echo "DEMODQM /home/pioneer/demo-dqm/expt pioneer" > ~/demo-dqm/exptab

source ~/demo-dqm/env.sh
cd ~/demo-dqm/expt
odbedit -e DEMODQM -c "ls"          # creates the ODB on first run
```

**`mhttpd -p 8090` will not work.** This build takes its port from the ODB and
refuses both `-p` and the `--http` in its own help text; `/Experiment/midas http
port` is obsolete in it and logs an error if you set it. The key does not exist
until `mhttpd` has run once and created `/WebServer`, so the first start is on
the default 8080 and is meant to be thrown away:

```bash
mhttpd -e DEMODQM &                 # creates /WebServer, binds 8080
sleep 3 && kill $!

# Port 8090, not 8088: 8088 is WDSCALERS.
odbedit -e DEMODQM -c 'set "/WebServer/localhost port" 8090'
mhttpd -e DEMODQM & echo $! > ~/demo-dqm/mhttpd.pid
```

Keep the pid. Cleaning up by pattern is a trap of its own -- see below.

### Register the pages

**There is no `pip` on that box, and no `ensurepip`,** so `pip install -e .`
cannot work and the `mdqm-*` console scripts never get created. Skip the install
and call the entry points as modules; `PYTHONPATH` from `env.sh` already has
`src` on it. The box Python is 3.10 against a `requires-python = ">=3.11"` in
`pyproject.toml`, which only an installer would have enforced -- registration and
replay both run fine on 3.10.

```bash
source ~/demo-dqm/env.sh
cd $REPO                            # not ~, or `import midas` finds the build tree
python3 -m mdqm.install.register_pages --experiment DEMODQM --list      # 16 keys, all absolute
python3 -m mdqm.install.register_pages --experiment DEMODQM --dry-run   # says what it would write
python3 -m mdqm.install.register_pages --experiment DEMODQM
```

Worth running after *every* `git pull` and after moving the checkout: the keys
are absolute paths into your working tree, and registration is idempotent
precisely so that a moved checkout heals itself. A `/Custom` left pointing at a
directory that no longer exists is a 404 on all six pages at once.

### Get a run file onto the box

Nothing replays without data, and **the cleanup step at the bottom of this page
deletes it**, so expect to do this again. `triumf_run108.mid` is 905 MB and lives
on the machine the data was made on, not on pionline. Cut a slice there and copy
that instead:

```bash
# on the dev box, where triumf_run108.mid is
scripts/slice-run.py triumf_run108.mid run108-slice.mid --events 8000
scp run108-slice.mid pioneer@192.168.40.106:~/demo-dqm/
```

8000 events is 7.3 MB and copies in about a second. The slice is a byte-for-byte
prefix, so the replay cannot tell it from the full file; `slice-run.py` needs
nothing but the standard library, which is what lets it run on a box with no
MIDAS. The begin-of-run record is event 0 and is kept; `is_midas_internal_event()`
skips it on the way into the buffer, so its stub ODB payload is not a problem.

### Replay

```bash
source ~/demo-dqm/env.sh
cd $REPO
python3 scripts/replay-run.py ~/demo-dqm/run108-slice.mid --experiment DEMODQM \
    --rate 5 --loop --client-name demo_replay &
echo $! > ~/demo-dqm/replay.pid
```

`--loop` restarts at the end. `--rate 5` is well under what the page polls at, so
every event gets looked at; raise it to see the page keep up. The script refuses
to run while a run is active, which on a fresh experiment it is not.

### The analyzer

Channels and Pulses are blocked without one. It needs numpy, **which the system
Python does not have** -- and since there is no pip, it cannot be given any. The
only interpreters on that box with both numpy and working MIDAS bindings belong
to Josh. Running one read-only is fine; do not install anything into them.

```bash
source ~/demo-dqm/env.sh
cd $REPO
/home/pioneer/josh/slowdash/venv/bin/python3 -m mdqm.dqm.analyzer \
    --experiment DEMODQM --client mdqm_analyzer &
echo $! > ~/demo-dqm/analyzer.pid
```

`~josh/miniconda/install/envs/pion313/bin/python` works equally well, but Josh's
own analyzer runs on it against WDSCALERS -- using the other one keeps the two
processes apart in `ps`, which is worth the nothing it costs.

It should say it seeded `/DQM/Analyzer` and is serving 5 histograms. Five, not
seven: baseline and noise by channel are recent-value *series* now, served over
`dqm::series` and deliberately absent from `dqm::list`. Note that
`mdqm.dqm` is shared infrastructure: Josh runs this same analyzer continuously
against WDSCALERS, but from his own checkout with its own settings and its own
ODB, so our `/DQM` edits cannot reach him. Confirm that again before changing
anything under `src/mdqm/dqm/`.

### Look at it

`mhttpd` binds localhost, so tunnel:

```bash
ssh -N -L 8090:localhost:8090 pioneer@192.168.40.106
```

Then open <http://localhost:8090/?cmd=custom&page=Scope>. The waveform panel
should show a trace per hit, the raw-event table the decoded hit scalars, and
the status line the event serial and hit count.

### What to expect on the other pages

With the replay and the analyzer both up:

| page | on DEMODQM |
|---|---|
| Rates | `midas_event_rate` lists the replay client's equipment if it registers any; otherwise "no equipment is registered" |
| Scope | **live** from the replay |
| Channels | **live**: hits per event, occupancy, and baseline and noise by channel as recent-value scatters (the last 10 per channel, over `dqm::series`) |
| Pulses | **live**: persistence and amplitude by channel, both colormaps and both open off -- `Show plot` on the tile draws them |
| Physics | blocked, and stays blocked -- it wants a calibration nobody has written |
| SlowControls | six panels, each waiting for `ATAR_SC` / `ATAR_HV` / `Motion` |

Individual panels on Channels and Pulses stay blocked too, and correctly so:
they ask for a calorimeter or `fesampic` bank that run 108 does not contain.
Each says which. Without the analyzer, every panel on both pages is blocked and
names the client it got no answer from.

### Checking it really rendered

A MIDAS page photographs as the word "Loading..." if you screenshot it on the
load event, and an `mplot` panel with no bounds set paints a clean white
rectangle with no error anywhere. So verify with a wait condition rather than
with your eyes on a screenshot:

```bash
source ~/demo-dqm/env.sh && cd $REPO
python3 scripts/shoot.py "http://localhost:8090/?cmd=custom&page=Scope" /tmp/scope.png \
    --wait-for "document.querySelector('.dqm-chip')" --console
```

`shoot.py` exits non-zero if the condition never comes true, so it works as a
test. To tell "painted" from "blank", wait on a pixel census -- a canvas showing
more than three distinct colours -- rather than on the canvas existing. firefox
and geckodriver are on pionline; they are not on the dev box.

### Cleaning up

```bash
kill $(cat ~/demo-dqm/mhttpd.pid) $(cat ~/demo-dqm/replay.pid) $(cat ~/demo-dqm/analyzer.pid)
rm -rf ~/demo-dqm
rm -f /dev/shm/1000_DEMODQM_*        # never a wider glob than this
```

Three things about that, all of which have bitten:

**Kill by pid, not by pattern.** `pkill -f "mhttpd -e DEMODQM"` also matches the
ssh command line you are typing it from, and kills your own shell.

**`rm -rf ~/demo-dqm` does not remove the ODB.** It is POSIX shared memory keyed
by the experiment *directory path*, so recreating that path later remaps the old
segment -- stale clients, a `/Custom` full of paths into whatever checkout you
had last time, and a leftover 84 MB SYSTEM buffer whose dead readers pin the
read pointer and hang the next `replay-run.py` inside `BM_WAIT`. Hence the third
line. Glob no wider: the WDSCALERS segments sit right beside it in `/dev/shm`.

**It also deletes `run108-slice.mid`,** which does not exist anywhere else on the
box. Move it out first if you expect to be back.
