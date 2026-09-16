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
// sha256:       a4e9fee9efd706b5f0fb6b413648db8bd3d51bdfdba3b1efcdc6fb3741d81a3c
//
(function (root) {
"use strict";

const SPEC_SHA256 = "a4e9fee9efd706b5f0fb6b413648db8bd3d51bdfdba3b1efcdc6fb3741d81a3c";

// Strict JSON on purpose: tests/test_panels.py slices this literal out with a
// regex and json.loads() it, the same trick tests/test_manifest.py plays on
// DEFAULTS in dqm-common.js. No comments, no trailing commas, no JS inside.
const PAGES = [
  {
    "page": "Rates",
    "group": "rates",
    "name": "Rates",
    "question": "Is anything arriving, and at what rate?",
    "elements": [
      {
        "id": "midas_event_rate",
        "kind": "panel",
        "label": "MIDAS event rate",
        "question": "Is anything arriving, and how much of it?",
        "why": "it is the only tile on this page that waits on nothing",
        "status": "proposed",
        "size": "s",
        "sketch": "scalar",
        "alarm": {
          "condition": "the event counter stops moving while the run is marked running",
          "action": "check the frontend before the DQM; a dead publisher and a dead beam look identical here"
        }
      },
      {
        "id": "t0_hit_rate",
        "kind": "panel",
        "label": "T0 hit rate",
        "question": "Is the beam counter seeing beam?",
        "why": "it is the first number that separates no beam from no readout",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No counting equipment exists. docs/frontend_requirements.md lists what a trigger equipment would own -- but there is no fetrigger, and no decision about whether the coincidence lives in its own equipment or inside fesampic -- so there is no /Equipment/<name>/Variables key for this rate and nothing for MIDAS history to trend. Wishlist 1b.",
        "alarm": {
          "condition": "the T0 singles rate falls to zero while the run is running",
          "action": "check the beamline before the DAQ -- this counter is upstream of everything else on this page"
        }
      },
      {
        "id": "t0_t1_coincidence_rate",
        "kind": "panel",
        "label": "T0 + T1 coincidence rate",
        "question": "How many particles go all the way through?",
        "why": "it is the denominator the stop rate is measured against",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No counting equipment exists. docs/frontend_requirements.md lists what a trigger equipment would own -- but there is no fetrigger, and no decision about whether the coincidence lives in its own equipment or inside fesampic -- so there is no /Equipment/<name>/Variables key for this rate and nothing for MIDAS history to trend. The coincidence needs its own Variables key as well as the singles. Wishlist 1c."
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
        "id": "t0_atar_coincidence_by_layer",
        "kind": "panel",
        "label": "T0 + ATAR coincidence per layer",
        "question": "Which layers are in time with the beam counter?",
        "why": "it is the per-layer version of the question the stop rate asks in one number",
        "status": "blocked",
        "size": "l",
        "sketch": "hist1d",
        "blocked_by": "No counting equipment exists. docs/frontend_requirements.md lists what a trigger equipment would own -- but there is no fetrigger, and no decision about whether the coincidence lives in its own equipment or inside fesampic -- so there is no /Equipment/<name>/Variables key for this rate and nothing for MIDAS history to trend. A key per layer, and the same decision 2 question about where the coincidence is formed. Wishlist 1f."
      },
      {
        "id": "stop_rate",
        "kind": "panel",
        "label": "Stop rate \u2014 T0 + ATAR without T1",
        "question": "How many muons are actually stopping in the target?",
        "why": "it is the rate the whole campaign is trying to maximise",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No counting equipment exists. docs/frontend_requirements.md lists what a trigger equipment would own -- but there is no fetrigger, and no decision about whether the coincidence lives in its own equipment or inside fesampic -- so there is no /Equipment/<name>/Variables key for this rate and nothing for MIDAS history to trend. This one needs a vetoed coincidence key, which is a third thing for the same frontend to count rather than a third frontend. Wishlist 1g.",
        "alarm": {
          "condition": "the stop rate moves while the T0 singles rate does not",
          "action": "suspect the degrader or the beam momentum before the readout -- the beam is still there and is stopping somewhere else"
        }
      },
      {
        "id": "calo_event_rate",
        "kind": "panel",
        "label": "Calorimeter event rate",
        "question": "Is the calorimeter seeing the positrons?",
        "why": "a calorimeter that has gone quiet invalidates every energy tile downstream",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No calorimeter equipment exists; docs/frontend_requirements.md lists fecalo. Its Statistics would give the rate for free once it does, or a scaler Variables key if the rate wanted is hits rather than events. Wishlist 1j."
      },
      {
        "id": "mupix_hit_rate",
        "kind": "panel",
        "label": "MuPix hit rate",
        "question": "Is the tracker seeing anything at all?",
        "why": "it is the cheapest check that the tracker is in the run",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No MuPix equipment exists; docs/frontend_requirements.md lists femupix. This is the scalar rate only -- the position density map is a 2D accumulation and belongs on Channels, which is mechanism C and waits on the analyzer. Wishlist 1i, the first half."
      },
      {
        "id": "trigger_settings",
        "kind": "panel",
        "label": "Trigger settings for this run",
        "question": "What trigger made these events, and what is this rate divided by?",
        "why": "different runs have different trigger settings and a rate means nothing without them",
        "status": "blocked",
        "size": "m",
        "sketch": "table",
        "blocked_by": "No fetrigger and no fesampic, so not one of the four keys this panel reads exists: /Equipment/Trigger/Settings/{Mode, Prescale, Coincidence window} and /Equipment/SAMPIC/Settings/Threshold. Until they do, every rate on this screen is an uncorrected count and nothing on the page says so.",
        "alarm": {
          "condition": "any of the four keys is absent, or Prescale is not 1 while the screen shows a raw rate",
          "action": "read the prescale before believing any rate on this page; note it in the eLog with the run number"
        }
      }
    ]
  },
  {
    "page": "Scope",
    "group": "scope",
    "name": "One event",
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
        "label": "ATAR raw waveforms, by layer",
        "question": "Does a pulse look like a pulse?",
        "why": "it is the page you open when a histogram is empty and nothing else says why",
        "status": "ready",
        "size": "l",
        "sketch": "event"
      },
      {
        "id": "calo_waveforms",
        "kind": "panel",
        "label": "Calorimeter waveforms",
        "question": "Does a calorimeter pulse look like a pulse?",
        "why": "the same question as the ATAR waveforms, asked of a different detector",
        "status": "blocked",
        "size": "l",
        "sketch": "event",
        "blocked_by": "No calorimeter bank and no document describing one; docs/frontend_requirements.md lists the quantities nobody writes because there is no fecalo. Same requirement as the ATAR waveforms and the same failure mode if the layout is assumed rather than written. Wishlist 3i."
      },
      {
        "id": "event_display_energy",
        "kind": "panel",
        "label": "Event display \u2014 energy",
        "question": "Does the energy deposited along the track rise the way a stopping muon should?",
        "why": "slide 8 asks for energy and position and they are not the same panel",
        "status": "blocked",
        "size": "l",
        "sketch": "event",
        "blocked_by": "Per-strip edep is not in the tree. demonstrator-dqm docs/DESIGN.md section 8.5 gates it on a sim_to_tree.py extension, which demonstrator-pim1's proposed_analyses.md items 6 and 7 want anyway."
      },
      {
        "id": "raw_event",
        "kind": "panel",
        "label": "Raw EVENT",
        "question": "What is actually on the wire?",
        "why": "it is the panel you open when a plot is empty",
        "status": "blocked",
        "size": "m",
        "sketch": "table",
        "blocked_by": "This panel was ready against a figure type that demonstrator-dqm registers, and the conversion retires that registry. Under MIDAS a raw dump reads the event buffer through mhttpd, which needs a documented bank layout like everything else on that page."
      }
    ]
  },
  {
    "page": "Channels",
    "group": "channels",
    "name": "Channels",
    "question": "Is every channel behaving?",
    "elements": [
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
        "id": "hits_per_event",
        "kind": "panel",
        "label": "Hits per event",
        "question": "Is the trigger selecting what we think it is?",
        "why": "the cheapest single number that says the trigger changed",
        "status": "blocked",
        "size": "m",
        "sketch": "hist1d",
        "blocked_by": "This panel was ready against figure types that demonstrator-dqm registers, and the conversion retires that registry. Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from.",
        "alarm": {
          "condition": "the mean moves away from the run-108 reference near 2.3 hits per event",
          "action": "check the trigger threshold and the enabled-channel mask before assuming physics"
        }
      },
      {
        "id": "baseline_by_channel",
        "kind": "panel",
        "label": "Baseline by channel",
        "question": "Is every channel sitting where it should?",
        "why": "a channel whose baseline has walked is the cheapest fault to find",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from. Wishlist 3c."
      },
      {
        "id": "noise_by_channel",
        "kind": "panel",
        "label": "Noise by channel",
        "question": "Which channels are noisier than their neighbours?",
        "why": "noise is what separates a dead channel from a loud one",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "Mechanism C: it needs the analyzer client nobody has started -- a client that samples the event buffer and serves accumulated histograms -- as well as the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic, which is the frontend the bank would come from. Wishlist 3d."
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
        "id": "atar_time_vs_t0",
        "kind": "panel",
        "label": "ATAR hit time relative to T0",
        "question": "Is the ATAR timed in with the beam counter?",
        "why": "an axis labelled relative to T0 is the check that the event builder works",
        "status": "blocked",
        "size": "m",
        "sketch": "hist1d",
        "blocked_by": "Needs T0 and this detector in the same event record, not merely a T0 that exists somewhere. If each detector is read out as its own equipment with its own events, this tile draws a plot whose numbers mean nothing -- which is why it is the tile that reveals whether the event builder works. Nothing in docs/frontend_requirements.md provides a common time base across subsystems yet, and decision 7 settles what T0 names but not who wires it. Wishlist 3h. Per channel, which needs a channel identity within a layer -- the strip map, a frontend setting nobody has checked against the cabling."
      },
      {
        "id": "mupix_time_vs_t0",
        "kind": "panel",
        "label": "MuPix hit time relative to T0",
        "question": "Is the tracker timed in at all?",
        "why": "a flat distribution here says the subsystems are not synchronised",
        "status": "blocked",
        "size": "m",
        "sketch": "hist1d",
        "blocked_by": "Needs T0 and this detector in the same event record, not merely a T0 that exists somewhere. If each detector is read out as its own equipment with its own events, this tile draws a plot whose numbers mean nothing -- which is why it is the tile that reveals whether the event builder works. Nothing in docs/frontend_requirements.md provides a common time base across subsystems yet, and decision 7 settles what T0 names but not who wires it. docs/frontend_requirements.md lists the quantities nobody writes because there is no femupix. Drawn as one distribution for the whole detector rather than per channel: the first question for MuPix is whether it is timed in at all."
      },
      {
        "id": "calo_time_vs_t0",
        "kind": "panel",
        "label": "Calo hit time relative to T0",
        "question": "Is the calorimeter timed in with the rest?",
        "why": "the same question the other two T0 tiles ask, asked of the calorimeter",
        "status": "blocked",
        "size": "m",
        "sketch": "hist1d",
        "blocked_by": "Needs T0 and this detector in the same event record, not merely a T0 that exists somewhere. If each detector is read out as its own equipment with its own events, this tile draws a plot whose numbers mean nothing -- which is why it is the tile that reveals whether the event builder works. Nothing in docs/frontend_requirements.md provides a common time base across subsystems yet, and decision 7 settles what T0 names but not who wires it. docs/frontend_requirements.md lists the quantities nobody writes because there is no fecalo. Per channel, which the calorimeter channel count allows."
      },
      {
        "id": "mupix_hit_density",
        "kind": "panel",
        "label": "MuPix hit position density",
        "question": "Where on the tracker is the beam landing?",
        "why": "a beam that has moved shows here before it shows in any rate",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "No MuPix equipment and no bank carrying pixel addresses; docs/frontend_requirements.md lists the quantities nobody writes because there is no femupix. This is the 2D half of wishlist 1i -- the scalar rate is on Rates, where it gets a free history trend, and this accumulation is mechanism C and gets none."
      },
      {
        "id": "atar_occupancy",
        "kind": "panel",
        "label": "ATAR occupancy",
        "question": "Is the beam hitting the target where we put it?",
        "why": "it is the fastest check that the geometry matches the ODB",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "This panel was ready against a figure type that demonstrator-dqm registers, and the conversion retires that registry. Under MIDAS it is mechanism C and waits on the analyzer client nobody has started."
      }
    ]
  },
  {
    "page": "Pulses",
    "group": "pulses",
    "name": "Pulses",
    "question": "What does a pulse look like, and what is it worth?",
    "elements": [
      {
        "id": "pulse_persistence",
        "kind": "panel",
        "label": "Persistence waveform",
        "question": "What does a pulse actually look like?",
        "why": "a mean waveform hides the two-population case this one shows immediately",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "Mechanism C: the ATAR bank, a histogram definition, and the analyzer client nobody has started. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. Wishlist 3b."
      },
      {
        "id": "amplitude_by_channel",
        "kind": "panel",
        "label": "Amplitude by channel",
        "question": "Is every channel seeing the same pulse height?",
        "why": "it is where a channel whose gain has drifted shows up first",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "Mechanism C: the ATAR bank, a histogram definition, and the analyzer client nobody has started. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. Wishlist 3e."
      },
      {
        "id": "energy_vs_amplitude",
        "kind": "panel",
        "label": "Energy against amplitude",
        "question": "Does the energy scale hold across the range?",
        "why": "it is the tile that says whether the calibration is linear where it matters",
        "status": "blocked",
        "size": "l",
        "sketch": "hist2d",
        "blocked_by": "Mechanism C: the ATAR bank, a histogram definition, and the analyzer client nobody has started. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. And an energy calibration with an owner, which this design surfaces and does not own: nothing says where the volts-to-MeV constant per channel comes from, who sets it, or whether it lives in the ODB where a page can read it. Until that is answered this tile plots amplitude with the axis named honestly, because an uncalibrated axis labelled MeV is the kind of plot that is believed for a month. Wishlist 3f."
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
      }
    ]
  },
  {
    "page": "Physics",
    "group": "physics_page",
    "name": "Physics",
    "question": "Does this look like stopped muons?",
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
        "id": "calo_spectrum",
        "kind": "panel",
        "label": "Total energy in ATAR and calo",
        "question": "Does the energy add up to a stopped muon and its positron?",
        "why": "the edge is a calibration anchor a shifter can watch",
        "status": "blocked",
        "size": "m",
        "sketch": "hist1d",
        "blocked_by": "This panel was ready against a figure type that demonstrator-dqm registers, and the conversion retires that registry. the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. And an energy calibration with an owner, which nothing in this design provides; until it exists the axis says amplitude rather than MeV. Wishlist 4b.",
        "alarm": {
          "condition": "the edge near 52.8 MeV moves",
          "action": "the calibration moved, or the HV did; note the run number and check the bias before the next run"
        }
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
        "id": "mupix_vs_positron_direction",
        "kind": "panel",
        "label": "MuPix direction against positron direction",
        "question": "Do the tracker and the target agree about where the positron went?",
        "why": "it is the tile most likely to leave this screen entirely, and it says so",
        "status": "blocked",
        "size": "m",
        "sketch": "hist2d",
        "blocked_by": "Track finding in the analyzer, which nobody has started, on top of the ATAR bank and a histogram definition. docs/frontend_requirements.md lists the quantities nobody writes because there is no fesampic. MuPix hits in the same event as the ATAR, which is the event-building requirement the T0 tiles on Channels carry. The channel to strip map, which is a frontend setting nobody has checked against the cabling. And a relative alignment nobody has measured. Wishlist 5c."
      }
    ]
  },
  {
    "page": "SlowControls",
    "group": "slow_controls",
    "name": "Slow controls",
    "question": "Is the hardware where it should be?",
    "elements": [
      {
        "id": "healthy_banner",
        "kind": "note",
        "label": "This page is blocked on frontends and sensors, not on the DQM",
        "why": "an entire tab of empty panels needs explaining once",
        "status": "blocked",
        "blocked_by": "Every panel here waits on a slow-control frontend writing ODB Variables -- fecaen_hv for bias, readback and leakage current, featar_sc for temperature and light. Neither exists. See docs/frontend_requirements.md.",
        "body": "Every tile on this page is a MIDAS history plot over a slow-control equipment's Variables. None of it is DQM work: once those equipment exist, mhttpd draws all of it with no code on this side. What is missing is sensors and frontends, which is why this page is last in the menu and requires the most."
      },
      {
        "id": "temperature_sensors",
        "kind": "panel",
        "label": "Temperature",
        "question": "Is the ATAR or the SAMPIC crate heating up?",
        "why": "gain depends on it, so a drift here explains a drift there",
        "status": "blocked",
        "size": "m",
        "sketch": "trend",
        "blocked_by": "No featar_sc frontend, and further back than that no temperature sensor is installed or catalogued. The UDB has sc.quantity temperature_c waiting for one.",
        "odb": {
          "path": "/Equipment/ATAR_SC/Variables/Temperature",
          "type": "FLOAT"
        }
      },
      {
        "id": "humidity_sensors",
        "kind": "panel",
        "label": "Humidity",
        "question": "Is the enclosure dry enough to hold bias?",
        "why": "wishlist 2b asks for it and nothing can record the reading yet",
        "status": "blocked",
        "size": "s",
        "sketch": "scalar",
        "blocked_by": "One step further back than the other three on this page: not 'no sensor' but nowhere to put the reading. The run-conditions vocabulary records slow-control readings under a fixed set of quantity names -- temperature, light level, leakage current, pressure, beam current -- and there is no name for humidity, so spec/vocab.json has nothing this tile could reference. That is a vocabulary change somebody else owns; CLAUDE.md section 1 says this repo may reference such a name and may not invent one. Flagging it is the useful thing this design can do."
      },
      {
        "id": "light_sensors",
        "kind": "panel",
        "label": "Light level",
        "question": "Is the detector volume light-tight?",
        "why": "slide 4 catalogues light sensors, so somebody intends to fit them",
        "status": "blocked",
        "size": "s",
        "sketch": "scalar",
        "blocked_by": "One step further back than the temperature: no sensor exists, none is catalogued, and no featar_sc frontend would read one. cat.sensor_kind has 'light' and sc.quantity has 'light_level', so only the database is ready.",
        "odb": {
          "path": "/Equipment/ATAR_SC/Variables/Light level",
          "type": "FLOAT"
        }
      },
      {
        "id": "leakage_current",
        "kind": "panel",
        "label": "ATAR leakage current",
        "question": "Is a channel drawing current it should not be?",
        "why": "slide 8 asks for it and it is an early damage warning",
        "status": "blocked",
        "size": "l",
        "sketch": "hist1d",
        "blocked_by": "No fecaen_hv frontend. A MIDAS hv class driver reads current alongside voltage, so this variable costs nothing extra once that frontend exists -- and until it does, demonstrator-dqm's slow_control table holds fixtures from db/seed_slow_control.py, which backend/services/scan.py:94 says out loud.",
        "alarm": {
          "condition": "a channel's current crosses the alarm limit for that channel",
          "action": "note it and call the detector expert; do not change the bias yourself"
        },
        "odb": {
          "path": "/Equipment/ATAR_HV/Variables/Current",
          "type": "FLOAT"
        }
      },
      {
        "id": "hv_readback",
        "kind": "panel",
        "label": "Bias: demand vs measured",
        "question": "Is the bias actually what the DAQ page claims it is?",
        "why": "nothing anywhere currently checks a setpoint against a readback",
        "status": "blocked",
        "size": "m",
        "sketch": "table",
        "blocked_by": "No fecaen_hv frontend. The hv class driver's Demand and Measured arrays are exactly this comparison, and today neither number exists in the ODB: the CAEN crate is driven from its own front panel and the value is retyped into a record.",
        "alarm": {
          "condition": "measured and demand differ by more than the channel tolerance",
          "action": "the run is still usable; flag it so analysis knows the recorded bias is wrong"
        },
        "odb": {
          "path": "/Equipment/ATAR_HV/Variables/Measured",
          "type": "FLOAT"
        }
      },
      {
        "id": "motion_readback",
        "kind": "panel",
        "label": "Degrader and rotations",
        "question": "Is the geometry what the run record says it is?",
        "why": "a stage move that nobody types is invisible to every analysis",
        "status": "blocked",
        "size": "m",
        "sketch": "table",
        "blocked_by": "There are no actuators, so there is nothing for a femotion frontend to read back. Today the degrader plate is swapped by hand and the turntables are set by hand, and the only record is what somebody typed. This panel exists to make that gap visible on the screen a shifter is actually looking at.",
        "alarm": {
          "condition": "a measured position differs from the demanded one",
          "action": "stop before the next run: every downstream analysis will use the demanded value"
        },
        "odb": {
          "path": "/Equipment/Motion/Variables/Position",
          "type": "FLOAT"
        }
      }
    ]
  }
];

const BY_ID = {};
PAGES.forEach(function (p) {
  p.elements.forEach(function (e) { e.page = p.page; BY_ID[e.id] = e; });
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
