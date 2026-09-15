# Replaying a run and looking at the page

The Scope page decodes one event out of a live event buffer, so seeing it work
needs three things: a MIDAS with `mplot.js`, an experiment, and something putting
`AD00` banks into a buffer. There is no detector, so the third is a replay of an
existing run file.

## Without MIDAS at all

`scripts/gen-preview.py` builds a single self-contained HTML file with real
events from run 108 baked in, running the real page code against stubbed MIDAS
calls. The plot widget is a minimal stand-in for `mplot.js`, so it is good for
judging layout, decoded numbers and empty states, and not for judging the plot.

## On pionline (192.168.40.106)

Everything needed is already installed there. Two traps first, both of which
cost an afternoon if you meet them the other way round.

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

```bash
ssh pioneer@192.168.40.106

export MIDASSYS=/home/pioneer/josh/modern_midas/install
export PATH=$MIDASSYS/bin:$PATH
export LD_LIBRARY_PATH=$MIDASSYS/lib:$LD_LIBRARY_PATH
export PYTHONPATH=/home/pioneer/josh/modern_midas/midas/python
export MIDAS_EXPTAB=~/demo-dqm/exptab
export MIDAS_EXPT_NAME=DEMODQM

mkdir -p ~/demo-dqm/expt
echo "DEMODQM /home/pioneer/demo-dqm/expt pioneer" > ~/demo-dqm/exptab

cd ~/demo-dqm/expt
odbedit -e DEMODQM -c "ls"          # creates the ODB on first run

# Port 8090, not 8088: 8088 is WDSCALERS.
mhttpd -e DEMODQM -p 8090 &
```

### Register the pages

```bash
cd ~/demo-dqm/repo
pip install --user -e .
mdqm-register-pages --experiment DEMODQM --list       # 16 keys, all absolute
mdqm-register-pages --experiment DEMODQM --dry-run    # says what it would write
mdqm-register-pages --experiment DEMODQM
```

### Replay

`run108-slice.mid` is the first 8000 events of `triumf_run108.mid`,
about 7 MB, already copied to `~/demo-dqm/`. The full 905 MB file works the same
way. The begin-of-run record is skipped by `is_midas_internal_event()`, so the
stub ODB payload in it is not a problem.

```bash
cd ~/demo-dqm/repo
scripts/replay-run.py ~/demo-dqm/run108-slice.mid --experiment DEMODQM \
    --rate 5 --loop --client-name demo_replay
```

`--loop` restarts at the end. `--rate 5` is well under what the page polls at, so
every event gets looked at; raise it to see the page keep up. The script refuses
to run while a run is active, which on a fresh experiment it is not.

### Look at it

`mhttpd` binds localhost, so tunnel:

```bash
ssh -N -L 8090:localhost:8090 pioneer@192.168.40.106
```

Then open <http://localhost:8090/?cmd=custom&page=Scope>. The waveform panel
should show a trace per hit, the raw-event table the decoded hit scalars, and
the status line the event serial and hit count. The other four pages are in the
side menu and will all be explaining themselves, since that experiment has no
equipment.

### What to expect on the other pages

| page | on a bare DEMODQM |
|---|---|
| Rates | `midas_event_rate` lists the replay client's equipment if it registers any; otherwise "no equipment is registered" |
| Scope | **live** from the replay |
| Channels / Pulses / Physics | every panel blocked, each naming the analyzer it asked for and got no answer from |
| SlowControls | six panels, each waiting for `ATAR_SC` / `ATAR_HV` / `Motion` |

### Cleaning up

```bash
pkill -f "mhttpd -e DEMODQM"
pkill -f demo_replay
rm -rf ~/demo-dqm            # nothing outside this directory was touched
```
