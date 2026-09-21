//
// dqm-atar-geom.js -- the ATAR channel map, read once from the ODB, and the
// colours that encode it.
//
// This exists because two files now need the same geometry and neither of the
// files that could have held it is allowed to: dqm-common.js is generic by
// contract -- nothing in it knows about any equipment, bank or channel -- and
// dqm-adbanks.js decodes bytes and states that it never touches the network or
// the DOM. Reading /Equipment/SAMPIC/Settings is both detector-specific and a
// network call, so it belongs in neither, and putting it in one page file and
// importing it from the other gets the dependency backwards: dqm-hists.js is
// the analyzer half and dqm-scope.js the raw-event half, and neither is
// beneath the other.
//
// What it holds is exactly what both halves need to draw the target rather
// than a list of channels: which layer and which strip a readout channel is,
// which way that layer's strips run, the two-column-by-parity panel host that
// turns eight layers into four rows, and the colour ramp that puts a strip's
// position into the line without a legend.
//
// The load is cached in a promise, so the Channels tab and the Scope tab share
// one read of the ODB however they are opened. The cache is the answer, not
// the success: a map that came back null because the frontend never wrote the
// geometry is cached too, and that is correct -- it will not have appeared by
// the time the second tab asks.
//

(function (root) {
"use strict";

const SETTINGS = "/Equipment/SAMPIC/Settings";

//: The in-flight or completed load. One per page load; see the header.
let pending = null;

/**
 * Which layer each readout channel is in, or null if the ODB does not say.
 *
 * Two things are needed and BOTH have to come from the ODB: the channel ids
 * themselves, and the geometry that encoded them. A pim1 pixel id becomes
 * (layer, strip) only under the base and the stride it was made with, so
 * guessing the stride gives the wrong layer and the wrong strip while looking
 * entirely plausible -- 56 of 256 channels move if 48 is assumed where the
 * file used 46. There is no default here for that reason: no geometry in the
 * ODB means no layer view, and the panels that wanted one say so.
 */
async function read() {
  let v;
  try {
    v = await DQM.getODB([
      `${SETTINGS}/Channel map channel id`,
      `${SETTINGS}/Channel map detector`,
      `${SETTINGS}/Atar pixel id base`,
      `${SETTINGS}/Atar strips per layer`,
      `${SETTINGS}/Atar n layers`,
      `${SETTINGS}/Atar first layer orientation`,
    ]);
  } catch (e) {
    return null;
  }
  const [ids, detectors, pixelBase, stride, nLayers, firstOrientation] = v || [];
  if (!Array.isArray(ids) || !ids.length) return null;
  if (!Number.isFinite(Number(pixelBase)) || !(Number(stride) > 0)) return null;

  const byChannel = new Map();
  const stripOfChannel = new Map();
  const layers = new Set();
  ids.forEach(function (id, i) {
    // Only channels the map calls ATAR have a layer; anything else is on the
    // same digitiser but is not a strip.
    const det = Array.isArray(detectors) ? detectors[i] : "atar";
    if (det && String(det).toLowerCase() !== "atar") return;
    const index = Number(id) - Number(pixelBase);
    if (!(index >= 0)) return;
    const layer = Math.floor(index / Number(stride));
    if (Number(nLayers) > 0 && layer >= Number(nLayers)) return;
    byChannel.set(i, layer);
    // The strip's position across the layer. Same decode as the layer, the
    // other half of the divmod.
    stripOfChannel.set(i, index % Number(stride));
    layers.add(layer);
  });
  if (!byChannel.size) return null;
  const allStrips = Array.from(stripOfChannel.values());
  return { byChannel: byChannel, stripOf: stripOfChannel,
           stripLo: Math.min.apply(null, allStrips),
           stripHi: Math.max.apply(null, allStrips),
           layers: Array.from(layers).sort((a, b) => a - b),
           firstOrientation: typeof firstOrientation === "string" ? firstOrientation : null,
           source: `${SETTINGS} (${byChannel.size} channels, ${layers.size} layers)` };
}

/** The channel map, read at most once per page load. Never throws. */
function load() {
  if (!pending) pending = read();
  return pending;
}

/**
 * The strip orientation of a layer, or null if the ODB does not say.
 *
 * Layers alternate, so the orientation follows the parity of the layer number
 * once the first one is known -- which is why splitting the panels by parity
 * is the same thing as grouping them by orientation. Read rather than assumed:
 * a target built the other way round would put every label on the wrong column.
 */
function orientationOf(map, layer) {
  if (!map || !map.firstOrientation) return null;
  const first = String(map.firstOrientation).toLowerCase();
  const other = first === "vertical" ? "horizontal" : "vertical";
  return layer % 2 === 0 ? first : other;
}

/** The layer a channel is in, or null when the map does not cover it. */
function layerOf(map, channel) {
  if (!map) return null;
  const l = map.byChannel.get(channel);
  return l === undefined ? null : l;
}

/** The channel's strip position across its layer, or null if unmapped. */
function stripOf(map, channel) {
  if (!map || !map.stripOf) return null;
  const s = map.stripOf.get(channel);
  return s === undefined ? null : s;
}

/**
 * The two-column panel host, even layers left and odd right.
 *
 * Layers alternate orientation, so that is the same thing as putting each
 * strip direction in its own column -- a track crossing the target is read
 * down one column for one coordinate and down the other for the other,
 * instead of zig-zagging between orientations the way a single stack does.
 * With the demonstrator's eight layers it is also what makes the block four
 * rows deep, which is the shape both the waveforms and the baselines are read
 * in.
 *
 * Even first, which puts the vertical strips -- the x coordinate -- on the
 * left, because the energy display on the Scope tab reads charge against x on
 * the left and charge against y on the right. Two sections of one page
 * disagreeing about which coordinate is which side is a way to misread a track
 * that costs nothing to avoid.
 *
 * Returns a Map of parity (0 even, 1 odd) to the column element, so the caller
 * appends a layer's tile with `columns.get(layer % 2)`.
 */
function layerColumns(host, map, idPrefix) {
  const columns = new Map();
  [["even", 0], ["odd", 1]].forEach(function (pair) {
    const parity = pair[1];
    const col = DQMPage.el("div",
      { class: "dqm-layer-col", id: `${idPrefix}-col-${pair[0]}` });
    // The layers actually present with this parity, so the heading describes
    // the column rather than asserting a geometry nothing confirmed.
    const mine = map.layers.filter((L) => L % 2 === parity);
    const orient = mine.length ? orientationOf(map, mine[0]) : null;
    col.appendChild(DQMPage.el("div", { class: "dqm-subhead dqm-col-head" },
      orient ? `${orient} strips — ${pair[0]} layers` : `${pair[0]} layers`));
    host.appendChild(col);
    columns.set(parity, col);
  });
  return columns;
}

//: matplotlib's tab10. Used for a channel the map cannot place: with no strip
//: there is no position to encode, so a categorical palette that separates
//: neighbours is the right answer there.
const PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
                 "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf"];
function colourFor(ch) { return PALETTE[ch % PALETTE.length]; }

//: viridis, at tenths. Perceptually uniform and colourblind-safe, so equal
//: steps along the strip axis look like equal steps of colour and the order is
//: readable without a key.
const VIRIDIS = ["#440154", "#482878", "#3e4a89", "#31688e", "#26828e",
                 "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#d8e219",
                 "#fde725"];

//: Stop short of the pale end. viridis finishes at #fde725, which is a 1px
//: yellow line on a white plot with grey gridlines -- ordered, and invisible.
//: 0.85 ends around a yellow-green that still reads.
const RAMP_TOP = 0.85;

function lerpHex(a, b, t) {
  const p = (h, i) => parseInt(h.substr(1 + 2 * i, 2), 16);
  const c = (i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t)
    .toString(16).padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}

/**
 * Where this strip sits across its layer, as a colour.
 *
 * A ramp rather than a categorical palette because position is what this is
 * for: strip 3 and strip 28 should look far apart at a glance, and two
 * neighbouring strips should look like neighbours. The cost is the other way
 * round from tab10 -- a track crossing two adjacent strips draws two similar
 * lines -- so where there is room the legend still names the strip, which is
 * what tells them apart.
 *
 * `lo`/`hi` are the instrumented window taken from the channel map itself, so
 * the ramp spans the strips that exist rather than a guessed 0..45.
 */
function stripColour(strip, lo, hi) {
  const span = (hi > lo) ? (hi - lo) : 1;
  const t = Math.min(1, Math.max(0, (strip - lo) / span)) * RAMP_TOP;
  const x = t * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  return lerpHex(VIRIDIS[i], VIRIDIS[i + 1], x - i);
}

/**
 * A value's place on a sequential scale, as a fill colour.
 *
 * The whole of viridis, where stripColour stops at RAMP_TOP. The two are not
 * the same ramp and must not share a function: RAMP_TOP exists because a pale
 * 1px line on a white plot is ordered and invisible, and a filled cell has no
 * such problem -- it is bounded by its neighbours and by the grid gap, so the
 * yellow end reads perfectly well and throwing it away would waste a sixth of
 * the scale. scope.test.js pins the line ramp's darkness; nothing here may
 * loosen that.
 *
 * `t` is clamped rather than trusted. A caller working from a clipped scale
 * hands this values above 1 by design, and a ramp that indexed past its own
 * array for them would return undefined and paint the cell transparent.
 */
function heatColour(t) {
  const c = Math.min(1, Math.max(0, t));
  const x = c * (VIRIDIS.length - 1);
  const i = Math.min(VIRIDIS.length - 2, Math.floor(x));
  return lerpHex(VIRIDIS[i], VIRIDIS[i + 1], x - i);
}

//: The ends of a diverging scale, and its middle.
//:
//: ColorBrewer RdBu's extremes. Blue and red rather than red and green because
//: the one thing this ramp has to carry is the SIGN -- quieter than average or
//: louder -- and red/green is the pair that a deuteranope cannot separate at
//: all. Blue and red stay distinguishable as light and dark even when the hue
//: does not arrive.
//:
//: The midpoint is #f7f7f7 and not #fff on purpose. Zero is the commonest
//: value on the difference map and a pure-white cell would be indistinguishable
//: from the page behind a no-data cell, which is the one confusion this map
//: cannot afford: "did not move" and "nothing to say" are opposite readings.
const DIVERGE_LO = "#2166ac";
const DIVERGE_MID = "#f7f7f7";
const DIVERGE_HI = "#b2182b";

/**
 * A signed value's place on a diverging scale, as a fill colour.
 *
 * `t` runs -1..+1 and is clamped at both ends, for the reason heatColour is.
 * Two straight legs off the midpoint rather than a table, because what a reader
 * has to get off this is the sign and roughly the size, and a symmetric ramp is
 * the only kind where equal moves in opposite directions look equally large.
 */
function diffColour(t) {
  const c = Math.min(1, Math.max(-1, t));
  return c < 0 ? lerpHex(DIVERGE_MID, DIVERGE_LO, -c)
               : lerpHex(DIVERGE_MID, DIVERGE_HI, c);
}

//: How many swatches a heat key is drawn with.
//:
//: stripLegend uses one per strip because a strip's colour IS one discrete step
//: out of the ramp and a smooth bar would claim a precision the plot does not
//: have. Here the opposite is true: the value is continuous, so the key is as
//: near continuous as it can be drawn, and 32 swatches at the bar's 320px is
//: 10px each -- fine enough to read as a gradient and coarse enough that the
//: DOM is not doing something silly.
const KEY_STEPS = 32;

function keyBar(colourAt) {
  const bar = DQMPage.el("div", { class: "dqm-heat-bar" });
  for (let i = 0; i < KEY_STEPS; i++) {
    const sw = DQMPage.el("div", { class: "dqm-heat-swatch" });
    sw.style.background = colourAt(i / (KEY_STEPS - 1));
    bar.appendChild(sw);
  }
  return bar;
}

//: How many decimals a key end carries by default. The recent-value series
//: arrives rounded to 4 (see RecentByChannel.points), so printing more would
//: invent precision. A key over counts passes 0, because "1204.0000 hits"
//: claims a precision that the word "hits" already rules out.
function keyNum(v, decimals) {
  return Number(v).toFixed(decimals === undefined ? 4 : decimals);
}

/**
 * The key to heatColour: the ramp, its two ends as numbers, and any caveat.
 *
 * Here rather than beside the plot, for the reason stripLegend gives about
 * itself -- it is the ramp's own documentation and the two have to change
 * together. A key that goes on claiming a range the scale no longer uses is
 * not a harmless stale label: a colour key is read as authority, and this one
 * is how a reader turns a cell back into volts.
 *
 * `note` is where the scale says what it is hiding, and it is kept to a phrase.
 * A clipped scale that did not say so would be a lie told in the one place a
 * reader trusts -- but the sentence explaining *how* it clipped is not what
 * makes it honest, the visible mark is, so that sentence goes in `detail` and
 * is read by hovering the key. A paragraph under every plot is a paragraph
 * nobody reads, including the ones that matter.
 */
function heatLegend(lo, hi, opts) {
  const el = DQMPage.el;
  const o = opts || {};
  const kids = [
    el("span", { class: "dqm-heat-label" }, o.label || "RMS (V)"),
    el("span", { class: "dqm-heat-end" }, keyNum(lo, o.decimals)),
    keyBar(heatColour),
    el("span", { class: "dqm-heat-end" }, keyNum(hi, o.decimals)),
  ];
  if (o.note) kids.push(el("span", { class: "dqm-heat-note" }, o.note));
  const key = el("div", { class: "dqm-heat-key" }, ...kids);
  if (o.id) key.setAttribute("id", o.id);
  if (o.detail) key.title = o.detail;
  return key;
}

/**
 * The key to diffColour. Symmetric by construction: one number, used twice.
 *
 * Taking a single half-range rather than a lo and a hi is the argument made in
 * the type system. A diverging scale whose ends were set independently would
 * put zero somewhere other than the middle of the bar, and every cell's colour
 * would then encode a mixture of its size and the run's worst excursion in the
 * other direction.
 */
function diffLegend(hi, opts) {
  const el = DQMPage.el;
  const o = opts || {};
  const kids = [
    el("span", { class: "dqm-heat-label" }, o.label || "change (V)"),
    el("span", { class: "dqm-heat-end" }, `-${keyNum(hi)}`),
    keyBar((t) => diffColour(t * 2 - 1)),
    el("span", { class: "dqm-heat-end" }, `+${keyNum(hi)}`),
  ];
  if (o.note) kids.push(el("span", { class: "dqm-heat-note" }, o.note));
  const key = el("div", { class: "dqm-heat-key" }, ...kids);
  if (o.id) key.setAttribute("id", o.id);
  if (o.detail) key.title = o.detail;
  return key;
}

//: Label every Nth strip along a grid's bottom axis. A two-digit number does
//: not fit in a cell, so most columns go unlabelled and the reader counts from
//: the nearest tick -- which is what an axis is.
const LABEL_EVERY = 4;

/**
 * The target as a grid of cells: a row per layer, a column per strip.
 *
 * Here rather than in a page file because it is the same claim `layerColumns`
 * makes -- this is what it takes to draw the target rather than a list of
 * channels, and more than one tile now needs it. The noise maps ask it for
 * three grids of RMS and the occupancy tile for one of counts; neither of them
 * should own the arithmetic that turns a readout channel into a position, and
 * a second copy of it is a second place for the row order to drift.
 *
 * It paints nothing. Every cell comes back in the `dqm-heat-nodata` state with
 * its identity on it, and the caller fills in colour, class and title -- which
 * is what keeps the meaning of a cell with the tile that knows it. "No value in
 * the window" and "no hits all run" are different statements and this cannot
 * tell which one it is drawing.
 *
 * **A position holds however many channels the map puts there, not one.** In
 * ping-pong mode a strip is wired to two consecutive channels and a deposit is
 * recorded on whichever was not used last, so `Channel map channel id` stops
 * being injective. Inverting it one channel per position -- `atPos.set(key,
 * ch)` in a loop over ascending channel -- silently drops half the detector:
 * the second of every pair overwrites the first, half the channels get no cell
 * at all, and the tile goes on looking healthy. Positions carry a channel
 * *list* for that reason, and
 * `byPos` is what a caller paints from -- `byCh` maps every channel to its
 * cell, so both partners of a pair resolve to the same one and iterating it
 * would visit that cell twice.
 *
 * `opts.member` narrows every cell to ONE channel of its position -- 0 for the
 * first the map lists, 1 for the second -- which is what lets two grids of the
 * same geometry be drawn side by side, one per ping-pong channel, so each is
 * read for its own health rather than against its partner. `paired` still
 * describes the underlying map rather than the narrowed view, so a caller can
 * ask whether a second column exists before building one.
 *
 * Which channel is first at a position is the order the map lists them, never
 * the parity of the channel number. Pairs being (2k, 2k+1) is a cabling fact
 * this file is in no position to assume -- the same refusal that stops it
 * guessing the pixel stride -- and one non-ATAR channel in the middle of the
 * map shifts the parity of every channel after it.
 *
 * With no map it falls back to a single ribbon of every channel. That is not a
 * lesser version of the same picture and the caller is expected to say so: the
 * layer and strip of a channel cannot be guessed, because a pixel id decodes
 * only under the base and the stride it was made with.
 */
function heatGrid(map, opts) {
  const o = opts || {};
  const grid = DQMPage.el("div", { class: "dqm-heat" });
  if (o.id) grid.setAttribute("id", o.id);
  const byCh = new Map();
  const byPos = [];

  function cell(channels, layer, strip) {
    const c = DQMPage.el("div", { class: "dqm-heat-cell dqm-heat-nodata" });
    // Assigned rather than written as a data- attribute: the node tests'
    // element stub fills dataset only on direct assignment, and a channel read
    // back out of a display string would make the wording load-bearing.
    //
    // `ch` stays the FIRST channel at this position rather than becoming a
    // list. It is what every lookup in and out of this file keys on, and on
    // any map that is not ping-pong there is exactly one channel here, so the
    // attribute means what it always meant. `chs` carries the whole list and
    // is always set, so nothing has to guess which of the two applies.
    c.dataset.ch = String(channels[0]);
    c.dataset.chs = channels.join(",");
    if (layer !== null && layer !== undefined) c.dataset.layer = String(layer);
    if (strip !== null && strip !== undefined) c.dataset.strip = String(strip);
    if (o.onHover) {
      // The handler takes no event argument: the stub calls listeners with
      // none, so one reaching for ev.target would work in the browser and throw
      // under test, which is the worst asymmetry on offer.
      c.addEventListener("mouseenter", function () { o.onHover(channels, c); });
    }
    channels.forEach(function (ch) { byCh.set(ch, c); });
    byPos.push({ cell: c, channels: channels,
                 layer: layer === undefined ? null : layer,
                 strip: strip === undefined ? null : strip });
    return c;
  }

  let anyPaired = false;
  if (map) {
    const lo = map.stripLo, hi = map.stripHi;
    grid.style.gridTemplateColumns =
      `max-content repeat(${hi - lo + 1}, minmax(0, 1fr))`;
    // Reversed once per grid: this is walked by position and needs to ask
    // "which channels are here", where the map answers "where is this channel".
    const atPos = new Map();
    map.byChannel.forEach(function (layer, ch) {
      const key = `${layer}:${stripOf(map, ch)}`;
      const here = atPos.get(key);
      if (here) { here.push(ch); anyPaired = true; } else atPos.set(key, [ch]);
    });
    map.layers.forEach(function (layer) {
      const orient = orientationOf(map, layer);
      grid.appendChild(DQMPage.el("div", { class: "dqm-heat-rowlab" },
        orient ? `L${layer} ${orient.slice(0, 4)}` : `L${layer}`));
      for (let strip = lo; strip <= hi; strip++) {
        const chs = atPos.get(`${layer}:${strip}`);
        if (chs === undefined) {
          // No channel at this position: the layer is not instrumented here.
          // A fact about the detector, where an empty cell elsewhere is a fact
          // about the run, so it does not get painted like one.
          const gap = DQMPage.el("div", { class: "dqm-heat-cell dqm-heat-empty" });
          gap.title = `No channel at layer ${layer}, strip ${strip}.`;
          grid.appendChild(gap);
          continue;
        }
        if (o.member !== undefined) {
          // This grid draws one channel per strip. A strip wired to fewer
          // channels than that has nothing here, and it is a fact about the
          // cabling rather than about the run -- the same state as a position
          // the layer does not instrument, and painted the same way.
          if (chs.length <= o.member) {
            const gap = DQMPage.el("div",
              { class: "dqm-heat-cell dqm-heat-empty" });
            gap.title = `Layer ${layer}, strip ${strip} is wired to `
              + `${chs.length} channel${chs.length === 1 ? "" : "s"}, so it has `
              + `none in this column.`;
            grid.appendChild(gap);
            continue;
          }
          grid.appendChild(cell([chs[o.member]], layer, strip));
          continue;
        }
        grid.appendChild(cell(chs, layer, strip));
      }
    });
    if (o.axis) {
      grid.appendChild(DQMPage.el("div", { class: "dqm-heat-rowlab" }, "strip"));
      for (let strip = lo; strip <= hi; strip++) {
        grid.appendChild(DQMPage.el("div", { class: "dqm-heat-collab" },
          strip % LABEL_EVERY === 0 ? String(strip) : ""));
      }
    }
  } else {
    // No map, no pairing: which channels share a strip is exactly what the
    // geometry says, and a ribbon is what gets drawn when there is none. One
    // channel per cell, which is also what leaves `paired` false and keeps
    // every tile's partner view off.
    grid.classList.add("dqm-heat-ribbon");
    grid.style.gridTemplateColumns =
      `max-content repeat(${o.channels || 0}, minmax(0, 1fr))`;
    grid.appendChild(DQMPage.el("div", { class: "dqm-heat-rowlab" }, "all"));
    for (let ch = 0; ch < (o.channels || 0); ch++) {
      grid.appendChild(cell([ch], null, null));
    }
  }
  // From the map and not from byPos: with `member` set every cell holds one
  // channel, so counting them would report an unpaired map and the caller
  // would never build the second column.
  return { grid: grid, byCh: byCh, byPos: byPos, paired: anyPaired };
}

/**
 * A position's channels, named the way the rest of the page names them.
 *
 * "ch 4+5" and not "ch 4, 5", because this goes in a table column and in the
 * first words of a cell's hover, where it is read as one identifier for one
 * strip rather than as a list of two things. A position with one channel is
 * "ch 5" exactly as it always was, so nothing that is not ping-pong sees a
 * change of wording.
 */
function chLabel(channels) {
  return `ch ${channels.join("+")}`;
}

/** Where a channel sits, in words, for a cell title or a hover readout. */
function whereText(map, cell) {
  if (!map || cell.dataset.layer === undefined) return "unmapped";
  return `layer ${cell.dataset.layer}, strip ${cell.dataset.strip}`;
}

// Exports are what somebody reads, and nothing more. In particular there is no
// reset(): the cache lives in this script's evaluation, so a browser clears it
// by loading the page and the node tests clear it by loading this file through
// runPage's `also` rather than require(), which is how they get a fresh map
// per boot. A cache that needed clearing by hand would be one more thing to
// forget in the test that mattered.
/**
 * The key to stripColour: a swatch per strip, labelled at both ends.
 *
 * Here rather than in the page that shows it, because it is the ramp's own
 * documentation and the two have to change together. A legend built next to
 * the plot would go on claiming viridis over 0..45 the day the ramp or the
 * instrumented window moved, and a colour key that is wrong is worse than
 * none: it is read as authority.
 *
 * One swatch per strip, not a CSS gradient, for the same reason. What a
 * channel actually gets is a discrete colour out of the ramp at its own strip,
 * so the key shows exactly those colours -- a smooth bar would imply a
 * precision of reading the plot does not have.
 */
function stripLegend(map) {
  const el = DQMPage.el;
  const lo = map.stripLo, hi = map.stripHi;
  const bar = el("div", { class: "dqm-ramp-bar" });
  for (let strip = lo; strip <= hi; strip++) {
    const sw = el("div", { class: "dqm-ramp-swatch" });
    sw.style.background = stripColour(strip, lo, hi);
    sw.title = `strip ${strip}`;
    bar.appendChild(sw);
  }
  return el("div", { class: "dqm-ramp-key" },
    el("span", { class: "dqm-ramp-label" }, "strip across the layer"),
    el("span", { class: "dqm-ramp-end" }, String(lo)),
    bar,
    el("span", { class: "dqm-ramp-end" }, String(hi)));
}

const ATARGeom = { SETTINGS, load, orientationOf, layerOf, stripOf,
                   layerColumns, heatGrid, chLabel, whereText,
                   stripLegend, heatLegend, diffLegend,
                   colourFor, stripColour, heatColour, diffColour,
                   PALETTE, VIRIDIS, RAMP_TOP,
                   DIVERGE_LO, DIVERGE_MID, DIVERGE_HI };
root.ATARGeom = ATARGeom;
if (typeof module !== "undefined" && module.exports) module.exports = ATARGeom;

})(typeof globalThis !== "undefined" ? globalThis : this);
