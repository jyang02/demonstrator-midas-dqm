# What run 108 confirms, and what it does not

Checked 2026-09-14 against `~/sampic-to-midas` at commit `d16c675`, whose
`triumf_run108.mid` is 905 MB of real SAMPIC data re-packaged into MIDAS format.

`demonstrator-shifter-ui/docs/frontend_requirements.md` says only three things in
that document are the collaboration's — the `/Experiment/Run Parameters/` key
names, the `AD00`/`AT00` bank names, and the UDB columns — and that everything
else is proposed and wants confirming against the build deployed at PSI. This is
that confirmation, for the part of it that can be confirmed today.

## There is no ODB in that file

The run file's begin-of-run event carries a 16-byte payload reading
`fake-sampic-odb\0`, not an ODB dump. `converter/midas_writer.py:79` puts it
there deliberately, and says why: `PIMidasSelector::next()` indexes `&data[16]`
on a 16-byte vector when `data_size == 0`, tripping a bounds assertion in
debug-STL builds, so the payload must be non-empty but need not be real.

So **no `/Equipment` path in this repo is confirmed by anything**. The names in
`config_defaults.py` — `ATAR_SC`, `ATAR_HV`, `Motion`, `Trigger`, `SAMPIC` —
remain proposals from `frontend_requirements.md`, which is why every one of them
is an editable ODB key and why every panel that fails to resolve one offers a
button that opens it.

## What is confirmed

| | value | source |
|---|---|---|
| physics event id | `1` | `converter/bin_to_mid.py:31` (`PHYSICS_EVENT_ID`) |
| waveform bank | `AD00` | `converter/sampic_banks.py:19` |
| hit-timing bank | `AT00` | `converter/sampic_banks.py:20` |
| samples per hit | 64, fixed, zero-padded | `AD_MAX_SAMPLES`; the reader truncates to `data_size` |
| channels per SAMPIC | 16 | `CHANNELS_PER_SAMPIC` |
| ADC to volts | `sample / 1e4` | `ADC_TO_VOLTS` |

`/DQM/Scope`'s four defaults match all of this, which is now a checked claim
rather than a copied one.

## The ATAR bank layout is documented after all

`spec/dqm_shifter.json` blocks all five Scope panels partly on "no ATAR bank, and
no document describing one… the layout has to be a written specification rather
than a struct that happens to compile". The first half still holds — there is no
`fesampic` writing into a live event buffer. **The second half no longer does.**

`converter/sampic_banks.py` is that written specification, and it cites the
headers it mirrors (`sampic/EventBankUnpacker.hh`,
`sampic/EventTimingBankUnpacker.hh`):

* **AD00** — back-to-back 344-byte hit records, no count prefix; the bank size
  divided by 344 is the hit count. Each record is an 11×`int32` `HitHeader`
  (`fe_board_index`, `channel`, `hit_number`, `sampic_index`, `channel_index`,
  `data_size`, `inl_corrected`, `adc_corrected`, `residual_pedestal_corrected`,
  `cell_info`, `first_cell_physical_index`), then 64 `float32` of corrected
  waveform in volts, then `HitScalars` (`raw_tot_value` i32, `tot_value` f32,
  `amplitude` f32, `baseline` f32, `peak` f32, `time_index` f32, `time_instant`
  f64, `time_amplitude` f32, `first_cell_timestamp` f64). Little-endian
  throughout; the 344-byte size is asserted at import in that file.
* **AT00** — exactly one 56-byte record, `<QII10I`:
  `fe_timestamp_ns` u64, `nhits` u32, `nparents` u32, then ten reserved u32.
* Bank framing is `bk_init32a` (`flags = 0x31`), banks zero-padded to 8-byte
  alignment, `tid = TID_BYTE`.

A browser decoder for this is therefore writable today, which is what the Scope
page's mechanism (one event through `mhttpd`, decoded in the browser) needs. It
is not written here: what is still missing is a frontend putting these banks
into a live event buffer, so a decoder would have nothing to decode outside a
replay.

## The catalogue's run-108 reference checks out

`hits_per_event`'s alarm reads "the mean moves away from the run-108 reference
near 2.3 hits per event". Measured over the first 40 000 events of
`triumf_run108.mid`: **92 941 hits, mean 2.324 per event**.

Occupancy over the same sample, 32 channels across two SAMPIC chips:

```
ch  1- 8   9 245 .. 13 402 hits   the beam
ch  0      81                     nearly dead
ch  9-12   47 .. 58               nearly dead
ch 13-16   2 .. 4                 dead
ch 17-31   284 .. 422             low, flat
```

That distribution is what `channel_health` and `atar_occupancy` would draw, and
it is a reminder that "is every channel behaving" has a real answer in this data
that nothing currently shows anyone.

## What is still missing for Scope

1. a `fesampic` frontend writing `AD00`/`AT00` into a live event buffer;
2. the channel-to-strip map, which `frontend_requirements.md` puts in that
   frontend's `Settings` and which wants checking against the cabling.

Neither is a DQM task. The bank document is no longer one of them.
