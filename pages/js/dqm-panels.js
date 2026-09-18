//
// dqm-panels.js -- the panel catalogue. GENERATED; do not edit.
//
// Regenerate with:
//   scripts/gen-panels.py --spec path/to/dqm_shifter.json
//
// tests/test_panels.py regenerates and compares when the spec file is reachable,
// and skips when it is not, so the spec is never a build dependency. Editing
// this file by hand fails that test.
//
// Every field here has a reader in dqm-page.js or a page file, and a test says
// so. Do not add one speculatively: a shipped field nobody reads is exactly the
// rot this file is generated to prevent.
//
// source:       dqm_shifter.json
// spec_version: 1
// sha256:       2d39ae05f5d6243bc7e89ea50a2c036128cb586163546ab42bb3dc8db7f9a519
//
(function (root) {
"use strict";

const SPEC_SHA256 = "2d39ae05f5d6243bc7e89ea50a2c036128cb586163546ab42bb3dc8db7f9a519";

// Strict JSON on purpose: tests/test_panels.py slices this literal out with a
// regex and json.loads() it, the same trick tests/test_manifest.py plays on
// DEFAULTS in dqm-common.js. No comments, no trailing commas, no JS inside.
const PAGES = [
  {
    "page": "ATAR",
    "tabs": [
      {
        "group": "atar_channels",
        "name": "Channels",
        "question": "Is every channel behaving?",
        "elements": [
          {
            "id": "atar_occupancy",
            "kind": "panel",
            "label": "ATAR occupancy by strip and layer",
            "question": "Is the beam hitting the target where we put it?",
            "why": "the global-channel axis is the readout order, so a beam spot arrives as four disconnected clumps of bars rather than as a spot",
            "status": "ready",
            "size": "m",
            "sketch": "hist2d"
          },
          {
            "id": "hits_per_event",
            "kind": "panel",
            "label": "Hits per event",
            "question": "Is the trigger selecting what we think it is?",
            "why": "the cheapest single number that says the trigger changed",
            "status": "ready",
            "size": "m",
            "sketch": "hist1d",
            "alarm": {
              "condition": "the mean moves away from the run-108 reference near 2.3 hits per event",
              "action": "check the trigger threshold and the enabled-channel mask before assuming physics"
            }
          },
          {
            "id": "baseline_by_channel",
            "kind": "panel",
            "label": "Baseline by strip and layer",
            "question": "Is every channel sitting where it should, and is it staying there?",
            "why": "against time a baseline that has walked is a slope, where against channel it is only a wider column and indistinguishable from one that got noisier",
            "status": "ready",
            "size": "l",
            "sketch": "trend"
          },
          {
            "id": "noise_by_channel",
            "kind": "panel",
            "label": "Noise RMS by strip and layer",
            "question": "Which strips are noisier than their neighbours, and has any of them got louder just now?",
            "why": "a strip-and-layer map puts a loud channel beside its physical neighbours, and average against freshest separates one that has always been noisy from one that just changed",
            "status": "ready",
            "size": "l",
            "sketch": "hist2d"
          }
        ]
      },
      {
        "group": "atar_scope",
        "name": "Scope",
        "question": "What does this event look like?",
        "elements": [
          {
            "id": "scope_refresh",
            "kind": "note",
            "label": "One event per second, read from the ODB at load",
            "why": "one page now drives two views that tolerate different rates",
            "status": "proposed",
            "body": "This page refreshes one event per second by default, matching mhttpd's own one-second loop so a shifter does not hold two cadences in their head. The rate is read from an ODB key at load -- the same pattern as the layer definition -- so it is tunable during a shift without a rebuild. The merge of the event display into this page is what makes the number worth stating: a waveform view and a position view tolerate different rates, and leaving it to whoever builds the page would have produced two."
          },
          {
            "id": "atar_raw_waveforms",
            "kind": "panel",
            "label": "ATAR waveforms",
            "question": "Does a pulse look like a pulse?",
            "why": "it is the page you open when a histogram is empty and nothing else says why",
            "status": "ready",
            "size": "l",
            "sketch": "event"
          },
          {
            "id": "atar_hit_positions",
            "kind": "panel",
            "label": "ATAR hit positions",
            "question": "Where in the target did this event put its charge?",
            "why": "layer against strip, one column per strip orientation, is the view that shows a track where a channel list shows none",
            "status": "ready",
            "size": "l",
            "sketch": "event"
          },
          {
            "id": "event_display_energy",
            "kind": "panel",
            "label": "ATAR charge deposit depth",
            "question": "Does the charge along the track rise the way a stopping muon should, and how much is there in total?",
            "why": "it is the shape that says a muon stopped rather than passed through",
            "status": "ready",
            "size": "l",
            "sketch": "event"
          }
        ]
      },
      {
        "group": "atar_trends",
        "name": "Trends",
        "question": "Is the detector's response holding still?",
        "elements": [
          {
            "id": "pulse_persistence",
            "kind": "panel",
            "label": "Persistence waveform",
            "question": "What does a pulse actually look like?",
            "why": "a mean waveform hides the two-population case this one shows immediately",
            "status": "ready",
            "size": "l",
            "sketch": "hist2d"
          },
          {
            "id": "energy_vs_amplitude",
            "kind": "panel",
            "label": "Charge against amplitude",
            "question": "Does the pulse response hold its shape across the range?",
            "why": "two measures of the same pulse that stop agreeing somewhere is where a saturating channel or a changed shaping shows up, and neither the amplitude spectrum nor the persistence plot can show it alone",
            "status": "ready",
            "size": "l",
            "sketch": "hist2d"
          },
          {
            "id": "amplitude_by_channel",
            "kind": "panel",
            "label": "Amplitude by channel",
            "question": "Is every channel seeing the same pulse height?",
            "why": "it is where a channel whose gain has drifted shows up first",
            "status": "ready",
            "size": "l",
            "sketch": "hist2d"
          }
        ]
      },
      {
        "group": "atar_proposed",
        "name": "Proposed",
        "question": "What has been asked for and not built?",
        "elements": [
          {
            "id": "physics_selection",
            "kind": "note",
            "label": "Every tile here states its selection, and the page counts what passed",
            "why": "a histogram filled under an undeclared cut is unreadable at 3am",
            "status": "proposed",
            "body": "The wishlist heading for these items is an event selection -- stopped muons, has 2 tracks -- and this page treats that as a first-class thing rather than an implementation detail. A shifter cannot tell an empty plot from a cut that rejected everything, so every tile states the selection it was filled under and the page shows how many events passed it. The page that validates the selection is Scope: a stopped muon and its decay positron share a vertex, because the positron leaves from the strip the muon stopped in, and two unrelated muons in the same window do not."
          },
          {
            "id": "physics_nearline_rule",
            "kind": "note",
            "label": "The DQM shows the distribution; the nearline fits it",
            "why": "a fit over a partial run is wrong early and silently",
            "status": "proposed",
            "body": "Each tile here carries the distribution a fit will run on, not the fit, because a number that is wrong early is worse than no number -- a shifter cannot tell which. The one argued exception is the time between tracks: the muon lifetime is a known physical constant, so fitting it is a check rather than a measurement and a shifter can act on its being wrong. The exception is why the rule is worth writing down: it is a rule with a stated hole rather than a prohibition."
          },
          {
            "id": "channel_health",
            "kind": "panel",
            "label": "Channel health",
            "question": "Is any channel dead, noisy, or drifting?",
            "why": "a dead channel is the most common thing a shift catches",
            "status": "blocked",
            "size": "l",
            "sketch": "hist2d",
            "blocked_by": "This panel was ready against figure types that demonstrator-dqm registers, and the conversion retires that registry. Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from.",
            "alarm": {
              "condition": "a column is empty, or a baseline row has walked off its band",
              "action": "note the channel number in the eLog and tell the DAQ expert; this is not a reason to stop the run"
            }
          },
          {
            "id": "atar_hit_rate_by_layer",
            "kind": "panel",
            "label": "ATAR hit rate by layer",
            "question": "Is every layer seeing the beam it should?",
            "why": "a layer that has gone quiet is a cable or a bias, and it shows here first",
            "status": "blocked",
            "size": "l",
            "sketch": "hist1d",
            "blocked_by": "No counting equipment exists. docs/frontend_requirements.md lists what a trigger equipment would own -- but there is no fetrigger, and no decision about whether the coincidence lives in its own equipment or inside fesampic -- so there is no /Equipment/<name>/Variables key for this rate and nothing for MIDAS history to trend. And which mechanism this tile uses is decision 2's open half: a layer coincidence formed in hardware makes it a Variables key with a free trend, one counted in software makes it an analyzer product with no trend at all. Which channels form a layer is settled and is a setting in the frontend. Wishlist 1d."
          },
          {
            "id": "amplitude_recent_by_channel",
            "kind": "panel",
            "label": "Amplitude vs. channel (last N events)",
            "question": "Is any channel's pulse height drifting right now?",
            "why": "the accumulated colormap answers what happened over the run where the shift question is what is happening now",
            "status": "proposed",
            "size": "l",
            "sketch": "hist2d"
          },
          {
            "id": "crosstalk_by_layer",
            "kind": "panel",
            "label": "Crosstalk \u2014 channel by channel",
            "question": "Is a channel talking to its neighbour?",
            "why": "crosstalk read as signal is a fault that survives every other check here",
            "status": "blocked",
            "size": "l",
            "sketch": "hist2d",
            "blocked_by": "Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from. It also needs the layer definition, which is declared configuration in the frontend Settings (decision 2). A colormap must be plot[0] in mplot.js and cannot be overlaid, so this is one graph per layer and not one graph. Wishlist 3g."
          },
          {
            "id": "hit_time_between_layers",
            "kind": "panel",
            "label": "Hit time difference between layers",
            "question": "Do the layers see the same particle at the same time?",
            "why": "a layer out of time with its neighbours is a cable length or a threshold",
            "status": "blocked",
            "size": "m",
            "sketch": "hist1d",
            "blocked_by": "Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from. The layer definition it groups by is declared configuration (decision 2). Wishlist 1e."
          },
          {
            "id": "energy_by_channel",
            "kind": "panel",
            "label": "Energy by ATAR and calo channel",
            "question": "Is every channel worth the same MeV?",
            "why": "a channel calibrated differently from its neighbours breaks every sum downstream",
            "status": "blocked",
            "size": "l",
            "sketch": "hist2d",
            "blocked_by": "Mechanism C: the ATAR bank, a histogram definition, and the analyzer client nobody has started. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. And an energy calibration with an owner, which this design surfaces and does not own: nothing says where the volts-to-MeV constant per channel comes from, who sets it, or whether it lives in the ODB where a page can read it. Until that is answered this tile plots amplitude with the axis named honestly, because an uncalibrated axis labelled MeV is the kind of plot that is believed for a month. Wishlist 4a."
          },
          {
            "id": "stopping_distribution",
            "kind": "panel",
            "label": "Stopping distribution \u2014 last layer on the track",
            "question": "Where in the target are the muons stopping?",
            "why": "it closes the loop on the degrader field on the DAQ page",
            "status": "blocked",
            "size": "m",
            "sketch": "hist1d",
            "blocked_by": "This panel was ready against a figure type that demonstrator-dqm registers, and the conversion retires that registry. Track finding in the analyzer, which nobody has started, on top of the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. Wishlist 5b.",
            "alarm": {
              "condition": "the peak is not near the depth the degrader thickness implies",
              "action": "check that the degrader thickness on the DAQ page matches the plate that is physically in the beam"
            }
          },
          {
            "id": "stopping_energy_profile",
            "kind": "panel",
            "label": "Energy in the last three layers on the track",
            "question": "Did the muon actually stop, or did it leave?",
            "why": "an ordering of three peaks says stop or no stop without any calibration",
            "status": "blocked",
            "size": "l",
            "sketch": "hist1d",
            "blocked_by": "Track finding in the analyzer, which nobody has started, on top of the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. And more than the stopping distribution beside it asks for: the deposits have to be attributed to the muon track, because the decay positron crosses those same upstream layers on its way out and a whole-window integral flattens the profile for a reason that has nothing to do with stopping."
          },
          {
            "id": "n_tracks_in_window",
            "kind": "panel",
            "label": "Rate of events with 2 tracks",
            "question": "How often does an event look like a stopped muon?",
            "why": "slide 8 asks for it and the answer is further away than it looks",
            "status": "blocked",
            "size": "m",
            "sketch": "hist1d",
            "blocked_by": "Track finding in the analyzer, which nobody has started, on top of the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. A live count only, with no trend and honest about it: the analyzer writes its per-run summaries to the UDB, which no custom page can read, so the run-over-run comparison is a link out rather than a tile in (decision 3). That is also why it is here and not on Rates, whose whole premise is a value with a free history trend beside it."
          },
          {
            "id": "time_between_hits",
            "kind": "panel",
            "label": "Time between tracks",
            "question": "Is the time between the two tracks a muon lifetime?",
            "why": "it is slide 8's timing ask in the form that exists today",
            "status": "blocked",
            "size": "m",
            "sketch": "hist1d",
            "blocked_by": "This panel was ready against a figure type that demonstrator-dqm registers, and the conversion retires that registry. Track finding in the analyzer, which nobody has started, on top of the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. And a time base good to the muon lifetime. Wishlist 5a."
          }
        ]
      }
    ]
  }
];

const BY_ID = {};
PAGES.forEach(function (p) {
  p.tabs.forEach(function (t) {
    t.page = p.page;
    t.elements.forEach(function (e) { e.page = p.page; e.tab = t.group; BY_ID[e.id] = e; });
  });
});

/** The catalogue entry for one page, or null. */
function byPage(name) {
  for (let i = 0; i < PAGES.length; i++) if (PAGES[i].page === name) return PAGES[i];
  return null;
}

const DQMPanels = { SPEC_SHA256, PAGES, BY_ID, byPage };
root.DQMPanels = DQMPanels;
if (typeof module !== "undefined" && module.exports) module.exports = DQMPanels;

})(typeof globalThis !== "undefined" ? globalThis : this);
