# The element contract, as this repository reads it

`spec/dqm_shifter.json` describes one screen. `scripts/gen-panels.py` turns it into
`pages/js/dqm-panels.js`, and `pages/js/dqm-page.js` builds the page out of that. This file
documents the part of the spec that survives that trip.

**It is not the whole contract.** The spec format belongs to the spec project, along with the
validator that enforces it and the vocabularies it accepts; neither is checked out here, so nothing
in this repository validates a spec file. What this repository enforces is *drift*:
`tests/test_panels.py` regenerates the catalogue and fails if `pages/js/dqm-panels.js` is not what
`scripts/gen-panels.py` produces from the spec. A field this file does not list may still be legal
in a spec — it simply does not reach the page, and `gen-panels.py` drops it without complaint.

## What the generator reads

At the top of the file:

| Key | Used for |
|---|---|
| `spec_version` | copied into the generated catalogue's header |
| `chrome.custom_pages` | the **order** the pages come out in; anything undeclared follows, and the generic page is last |
| `groups` | one tab each |

Nothing else at the top level is read. `chrome.style`, `chrome.experiment` and `chrome.links` are
not: mhttpd draws its own side menu, and `mdqm-register-pages` is what puts an entry in it.

Per group:

| Key | Required | Used for |
|---|---|---|
| `id` | yes | the tab's `group`, which is also its `#tab=` deep link |
| `name` | yes | the tab button's text |
| `question` | yes | the line under the tab bar |
| `page` | no | which `/Custom` page this group is a tab of. Absent, or `"Custom"`, makes it the generic page |
| `elements` | yes | the tiles |

**A tab is a group.** There is no tab key in the spec and no second layout concept: several groups
naming the same `page` become several tabs of it, in spec order. Adding a tab is adding a group.

## The element envelope

`gen-panels.py` carries exactly these, and omits any that is absent, empty or `null`:

| Key | Required | What the page does with it |
|---|---|---|
| `id` | yes | the tile's HTML id, and what a renderer claims to draw the tile |
| `kind` | yes | `panel` or `note` |
| `label` | yes | the tile heading |
| `question` | `panel` | the line under the heading |
| `why` | yes | not rendered; it is why the tile exists, for whoever reads the spec later |
| `status` | yes | `ready`, `blocked`, `proposed` or `dropped` |
| `size` | `panel` | `s`, `m` or `l` — the tile's width and whether it shares a row |
| `sketch` | `panel` | what an empty tile says it *would* have drawn |
| `blocked_by` | when `blocked` | what the tile is waiting for, shown in the empty tile |
| `alarm` | no | the condition and the action, shown under the tile |
| `body` | `note` | the banner's text |

Two are derived rather than copied:

- **`note`** comes from a dropped element's `_note`, and is the only thing a dropped panel can say.
- **`odb`** comes from `targets.odb`, narrowed to `path`, `type` and `array_size`. It is the one
  `targets` slot this repository reads; the others name things downstream of a different consumer.

Anything else in an element — `help`, `evidence`, `badge`, `by`, `cites`, `source`,
`proposed_figure`, the rest of `targets` — stays in the spec and does not reach the browser. That
is deliberate: a field shipped to the page that nothing reads is a field a reader assumes is load
bearing.

## The vocabularies that reach the page

`kind`:

`panel` · `note`

`status`:

`ready` · `blocked` · `proposed` · `dropped`

It answers exactly one question: *will this be on the real page?* `ready` means a real source
exists today. `blocked` means something specific is missing, and `blocked_by` says what.
`proposed` means nobody has agreed to it yet. `dropped` means it was considered and declined, kept
so the decision is not re-argued.

The page does not draw a status chip per panel. Every panel that is not `ready` is on one tab, so
the tab a tile is on is its status; the tile's left border carries the colour.

`size`:

`s` · `m` · `l`

`.dqm-tile-s`, `-m` and `-l` in `pages/css/dqm.css` are 420px, 660px and full width, and the first
two also declare a flex basis so two small tiles share a row. **An element with no `size` is drawn
as `m`**, and a size this list does not name gets a class the stylesheet does not define, which is
full width with no basis — so it will draw, and it will not share a row with anything.

`sketch`:

`hist1d` · `hist2d` · `trend` · `table` · `status` · `scalar` · `event` · `none`

This says what an *empty* tile claims it would have drawn, in words — `SHAPE` in `dqm-page.js`. It
is a sentence and not a silhouette on purpose: a shape drawn in a real page can be mistaken for a
measurement.

Choosing `scalar` is a design claim rather than a formatting one. Not everything a shifter reads is
a plot, and a trend on something nobody is asking a temporal question about is the easy mistake,
because MIDAS gives the trend away and it looks like more information. It answers a question the
shift crew did not ask, in the space where the answer to the one they did ask should be.

| The question the panel answers | `sketch` |
|---|---|
| *what is it right now* — one value, a threshold, a setpoint met or not | `scalar` |
| *which channel is different* — one value per channel | `hist1d` |
| *does this value match the one beside it* — a reading against a setpoint | `table` |
| *has it changed since the run started* | `trend` |

## `alarm`

Both halves, or it is not actionable at 3am:

```jsonc
"alarm": { "condition": "leakage above the sc.channel alarm_hi for that sensor",
           "action":    "note it and call the detector expert; do not stop the run" }
```

A threshold with no action tells a shifter that something is wrong and not what to do about it.

## Regenerating

```bash
scripts/gen-panels.py --spec spec/dqm_shifter.json
scripts/stamp-assets.py
```

`--check` diffs without writing and exits non-zero when the committed catalogue is stale;
`tests/test_panels.py` calls the same code path. `DQM_SPEC` points the check at a spec kept
somewhere else. Editing `pages/js/dqm-panels.js` by hand fails that test, which is the point.
