# The element contract

What a spec file may contain. `render/model.py` is the authority that enforces this; the two are
pinned together by `tests/test_schema_doc.py`, which fails if a vocabulary named here is missing
from the validator or vice versa. The `<!-- vocab: -->` and `<!-- required: -->` comments below are
what that test reads — leave them in place.

A spec describes **one screen**. There is one: `spec/dqm_shifter.json`. What a MIDAS frontend has
to write before those pages can be drawn is a list rather than a screen, and lives in
`docs/frontend_requirements.md` — a document, not a spec, so nothing here governs it.

## The file

```jsonc
{
  "_readme": ["Free prose. Any key beginning with _ is ignored by the validator."],
  "spec_version": 1,
  "surface": "dqm",
  "title": "Demonstrator DQM — shift view",
  "subtitle": "Is the system alive and healthy?",
  "chrome": { "style": "dqm-webapp", "experiment": "pim1", "links": [ {"label": "MIDAS", "href": "..."} ] },
  "groups": [ { "id": "alive", "name": "Alive", "question": "Is anything arriving?",
                "elements": [ ... ] } ]
}
```

`surface` is one of
<!-- vocab: surface -->
`dqm`

`chrome.style` is one of
<!-- vocab: chrome_style -->
`midas` · `dqm-webapp`

`chrome.links` are the menu entries. mhttpd builds the side navigation out of four things, each
its own block separated by an `mseparator`: its own menu, then `/Custom`, then `/Script`, then
`/Alias`. These are different keys in different ODB trees, so a link says which one it means:

`via` is one of
<!-- vocab: link_via -->
`menu` · `custom` · `alias`

defaulting to `menu` when the label is one of mhttpd's own pages and `custom` otherwise.

A `menu` link is one of `Status`, `ODB`, `Messages`, `Chat`, `ELog`, `Alarms`, `Programs`,
`History`, `MSCB`, `Sequencer`, `Config`, `Help`, and it lands in the standard block in that
order whether or not the spec lists it. **It carries no `href`** — mhttpd builds the entry as
`?cmd=<name>` itself and ignores anything else, so supplying one asks for something it will not
do (R17). A `custom` link is a page under `/Custom/`, reached as `?cmd=Custom&page=<name>`. An
`alias` is a key under `/Alias` holding an arbitrary URL, which is the only way anything outside
mhttpd gets into the menu at all; `mhttpd.js` opens it in a new tab with a `↗` when the ODB key
name ends with `&`, which is what any external link wants.

A label claimed as `custom` or `alias` leaves the standard block, because that is what an
experiment does: to put its own eLog in the menu you drop `ELog` from `/Experiment/Menu` and add
`/Alias/ELog&`. The demonstrator's eLog is the collaboration's, not mhttpd's built-in one, so it
is an alias — and the standard `ELog` entry goes away rather than being drawn pointing somewhere
mhttpd would never point it. Otherwise a spec cannot invent a standard page or silently lose one.

That list and its order are `mhttpd_init`'s fallback in `resources/mhttpd.js`, **not** the
[Status Page](https://daq00.triumf.ca/MidasWiki/index.php/Status_Page) wiki article, which is prose
about one page rather than the menu. An experiment replaces the list wholesale by setting
`/Experiment/Menu` or `/Experiment/Menu Buttons`, which `mhttpd_init` reads first; the demonstrator
sets neither today, so the fallback is what its shifters would see. Like `eq_type`, this is a fact
owned by MIDAS and pinned to a release — it wants re-checking against the build deployed at PSI.

`chrome.custom_pages` is the list of pages this spec registers under `/Custom`, and it is the one
place they are named. Three things have to agree about that set — the pages groups land on (R16),
the side menu's `/Custom` block, and the `via: custom` links that point at them (R17) — and
declaring it here is what lets the validator hold them together instead of discovering the
disagreement at PSI. Declaring none is not an error: it is a spec written before the conversion,
which names no page of its own and lands everything on the generic `Custom`. It is meaningful only
under the `midas` chrome, for the same reason `page` is.

Each name is an ODB key under `/Custom`, so it must satisfy four constraints, and **only the first
is MIDAS's**: at most 31 characters, which is `NAME_LENGTH` minus the terminator; then no space, no
regex metacharacter, and no dot. The dot is the one with a mechanism rather than taste behind it —
mhttpd serves a `/Custom` key containing one as a static file rather than as a page, so `dqm.rates`
is not a page with an awkward name, it is not a page. The other two are **this repo's rule and
narrower than MIDAS would accept**: the key is both the `?cmd=custom&page=<key>` parameter and the
argument the page initialises itself with, and a name somebody has to think about at 3am is not
worth the characters it saves. In the validator that is `CUSTOM_PAGE_MAX` and `CUSTOM_PAGE_RE`
(`[A-Za-z][A-Za-z0-9_-]*`). The 31 wants confirming against the build deployed at PSI, like
`eq_type`; the grammar does not, because it is ours.

A name mhttpd already uses is refused as well — a `/Custom/Status` is a second page answering to one
name and which the menu reaches is not ours to decide.

A **group** is one `/Custom` page's worth of panels. It has `id`, `name`, an
optional one-line `question` it exists to answer, an optional `page`, and `elements`. Group order
and element order within a group are the display order; there is no other layout key (see D6 in
the plan).

`page` says which page the group lands on. It is the generic
<!-- vocab: page -->
`Custom`

**or any name this spec declares in `chrome.custom_pages`**, defaulting to `Custom`. The set is the
spec's own and therefore cannot be listed here. A group naming a page it does not declare is an
error, and it is the error worth catching: a group on a page no `/Custom` key registers is a menu
entry that opens to nothing, and the mockup would draw it regardless. Each declared page renders to
its own file (`dqm_rates.html` and the rest, the spec's own stem for the generic `Custom`) and the
side menu links them, so the mockup is a thing a reviewer clicks through rather than one long
scroll.

`PAGES` used to also hold `Status`, `Start`, `Alarms`, `Programs` and `EQTable`, and `PAGE_ORDER`
two more — `ODB` and `Sequencer` — that no group could name. Those are mhttpd's own pages, and the
DAQ surface rendered a mockup of each so that a reviewer could see where a `/Custom` page sits among
them. **None of them is drawn any more.** Nothing MIDAS owns is drawn here (CLAUDE.md §1), so the
side menu shows all twelve of mhttpd's entries as dead and only the `/Custom` block is live, which
is the honest picture: mhttpd serves those pages and this repo does not mock them.

What the DAQ surface recorded that was not a picture of mhttpd — which frontend must write which
ODB key, and which DQM panel is waiting for it — is a list rather than a screen, and is now
`docs/frontend_requirements.md`.

`page` is meaningful only under the `midas` chrome; a `dqm-webapp` spec that sets it is an error,
because a webapp with one bar and a row of tabs has no mhttpd pages to land on.

## The element envelope

Every element, of every kind, carries these.

| Key | Required | What it is |
|---|---|---|
| `id` | yes | `[a-z][a-z0-9_]*`, unique within the file (R1) **and across every spec** (R15). Becomes the traceability row key and the HTML anchor |
| `kind` | yes | see below |
| `label` | yes | what the screen shows |
| `why` | yes | why we decided to put this here. At least five words. For you in November |
| `help` | no | the sentence a shifter reads at 3am. Rendered visibly, in small type |
| `status` | yes | see below |
| `blocked_by` | when `status` is `blocked` | what is missing, and where that is visible. At least four words |
| `evidence` | yes | see below |
| `badge` | when `status` is `ready` and `evidence` is `mc` or `seeded` | see below |
| `by` | `field` and `readout` | who sets it |
| `targets` | yes | the downstream names; see below |
| `cites` | no | repo-relative paths that justify this element |
| `size` | `panel` only | see below |

`kind` is one of
<!-- vocab: kind -->
`panel` · `note`

`status` is one of
<!-- vocab: status -->
`ready` · `blocked` · `proposed` · `dropped`

It answers exactly one question: *will this be on the real page?* `ready` means we want it and a
real source exists today. `blocked` means we want it and something specific is missing.
`proposed` means nobody has agreed to it yet. `dropped` means we considered it and said no — kept
so the decision is not re-argued.

`evidence` is one of
<!-- vocab: evidence -->
`beam` · `replay` · `mc` · `seeded` · `none`

It answers a different question: *what actually backs this today?* `beam` is real beam data.
`replay` is a real `.mid` file replayed. `mc` is simulation. `seeded` is a fixture written by a
seed script. `none` is nothing.

`badge` is one of
<!-- vocab: badge -->
`MC TRUTH` · `REPLAY`

These are `demonstrator-dqm`'s own badges (`webapp/lib/api.js::mcBadge`, `replayBadge`) and must
keep meaning what they mean there.

`size` is one of
<!-- vocab: size -->
`s` · `m` · `l` · `xl`

400×300, 600×380, 800×460 and 1240×460 respectively — the tile geometries
`DQM_webpage/src/managers/FigureManager.js` places on its canvas.

## `targets`

Where this element's name lives downstream. All four slots are optional individually; the object
itself is required, and may be `{}`.

```jsonc
"targets": {
  "odb":    { "path": "/Equipment/ATAR/Settings/Bias V", "type": "FLOAT", "array_size": 8 },
  "udb":    "cond.channel_gain.bias_v",
  "figure": "atar-event-display",
  "hist":   "calo_sum"
}
```

`targets.odb.type` is one of
<!-- vocab: odb_type -->
`BOOL` · `INT32` · `DWORD` · `FLOAT` · `DOUBLE` · `STRING`

`targets.odb.path` must begin with `/`, contain no empty components, and have no component longer
than 31 characters (MIDAS `NAME_LENGTH`). Its first component is one of
<!-- vocab: odb_root -->
`Equipment` · `Experiment` · `Runinfo` · `Logger` · `Alarms` · `Sequencer` · `Custom` · `Analyzer` · `Script`

No two elements may declare the same path.

`targets.udb` is `schema.table.column` in `demonstrator-udb`, and must appear in `spec/vocab.json`
(R8). It once also had to agree with a declared `input.unit` — the cm/mm scar, UDB commit `1c7577f`
— but `input` went with the `field` kind, so that half of R8 has nothing left to compare against.
The unit agreement it protected is now checked by eye where the columns are listed, in
`docs/frontend_requirements.md`.

`targets.figure` and `targets.hist` must appear in `spec/vocab.json`, which is extracted from
`demonstrator-dqm` and never hand-edited. This holds at *every* status, so that a typo cannot pass
itself off as a proposal. To propose a figure that does not exist, leave `targets.figure` null and
set `proposed_figure`.

## Kind-specific bodies

### `panel` — a plot or table on the DQM page

<!-- required: panel -->
`question` · `sketch`

```jsonc
"question": "Is the ATAR drawing the current it should?",
"proposed_figure": "daq-trigger-rate",
"source": { "data_url": "http://localhost:8560/api/slow_control?...", "update_s": 30 },
"alarm":  { "condition": "leakage above the sc.channel alarm_hi for that sensor",
            "action":    "note it and call the detector expert; do not stop the run" },
"sketch": "trend"
```

`question` is the shift question the panel answers, and is required — a panel that cannot name one
is decoration.

`sketch` says what silhouette the mockup draws, and is one of
<!-- vocab: sketch -->
`hist1d` · `hist2d` · `trend` · `table` · `status` · `scalar` · `event` · `none`

The silhouette is deliberately shapeless: no numbers, no axis values. A mockup panel that looks
like it is showing a measurement is the 2023 failure mode.

**`scalar` is a panel that is one number, and choosing it is a design claim.** Not everything a
shifter reads is a plot: `wavedream-midas-dqm` shows `Events sent`, `Events per sec.` and
`kBytes per sec.` as plain `modbvalue` spans and trends none of them, though MIDAS histories all
three and `mhistory.js` would draw them for free (`pages/js/dqm-scalars.js:204`, `:524`). Its
liveness, its FPGA temperature and its derived clock are chips too, and its trends sit in a
collapsed `<details>` built on first open. The rule that page follows, and which this vocabulary
now lets a spec state:

| The question the panel answers | `sketch` |
|---|---|
| *what is it right now* — one value, a threshold, a setpoint met or not | `scalar` |
| *which channel is different* — one value per channel | `hist1d`, a bar per channel |
| *does this value match the one beside it* — a reading against a setpoint | `table` |
| *has it changed since the run started* | `trend` |

A `trend` on something nobody is asking a temporal question about is the easy mistake, because
MIDAS gives the trend away and it looks like more information. It is not: it answers a question the
shift crew did not ask, in the space where the answer to the one they did ask should be.

`alarm` carries **both** halves, copying `demonstrator-udb/webapp/routes/dashboard.py::CHECKS`:
what the condition means, and what a shifter should do about it. A threshold with no action is not
actionable at 3am.

`proposed_figure` is valid only when `targets.figure` is null.

### `note` — a banner

<!-- required: note -->
`body`

## Rules

Each is named for the failure it prevents. `render/model.py` implements them under these ids and
`tests/test_model.py` has one test per rule. All but R15 are what `load()` can check with one file
in front of it; R15 needs every spec at once, so it lives in `check_across()`, which both `load_all()`
and `python -m render` call.

**The numbering has gaps.** R9, R11 and R14 governed `input`, `by` and `equipment`, and went when
those did. The surviving ids keep their numbers rather than closing up, because they are quoted in
the validator's error strings and in `docs/closed_plans/`, where renumbering would silently change
what a closed plan says.

| | Rule | Prevents |
|---|---|---|
| R1 | `id` matches `[a-z][a-z0-9_]*` and is unique in the file | two elements answering to one anchor |
| R2 | `status: blocked` requires `blocked_by` of at least four words | a gap with no stated reason |
| R3 | `status: ready` requires a real source named — `targets.figure` for a panel | `ready` meaning nothing |
| R4 | `targets.figure` must be a registered figure type, at any status | a typo reading as a proposal |
| R5 | `targets.hist` must be a known histogram key | a renamed histogram going unnoticed |
| R6 | `status: ready` with `evidence` of `mc` or `seeded` requires `badge` | synthetic data presented as real |
| R7 | ODB path grammar, and no duplicate paths | an unwritable path discovered at PSI |
| R8 | `targets.udb` must be a column in `demonstrator-udb` | a renamed column going unnoticed |
| R10 | `why` present on every element, at least five words | a decision going unrecorded |
| R12 | any key not in this document is an error, except `_`-prefixed | a typo'd key silently doing nothing |
| R13 | `proposed_figure` only when `targets.figure` is null | ambiguity about what exists |
| R15 | an `id` is unique *across* specs, not only within one | a colliding `traceability.csv` row key, and a gap-table link that lands on the wrong screen |
| R16 | a group's `page` is `Custom` or one the spec declares in `chrome.custom_pages`, whose names satisfy the `/Custom` key constraints; only a `midas` surface sets either | alarms drawn on a custom page, which is a picture of the wrong screen — and a group on a page nothing registers |
| R17 | a menu link names an mhttpd page and carries no `href`; a `custom` or `alias` link has one, and a `custom` one names a declared page | a menu entry pointing somewhere mhttpd would never point it, or at a page that does not exist |
