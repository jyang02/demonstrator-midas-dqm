"""The AD00, AT00 and AC00 bank layouts, as bytes.

This module exists so the browser decoder in ``pages/js/dqm-adbanks.js`` has a
Python twin that cannot drift from it: ``tests/generate_adbank_cases.py``
encodes a set of hits here and ``tests/js/adbank.test.js`` decodes the same
bytes there, so a field that moves on one side fails on the other.

The layout is not invented and not guessed: it is written down in
``docs/sampic-bank-layout.md``, which is the specification both decoders are
built from and which records what recorded data does and does not settle.

Two things worth knowing before reading a waveform out of here:

* **the samples are already volts.** The int16 source is divided by 1e4 before
  the bank is written, so a decoder that scales again produces a plot that is
  wrong by four orders of magnitude and still looks plausible.
* **the sampling period is not in the bank.** It lives in the SAMPIC ``.bin``
  header (``1e3 / sampling_freq_msps`` ns: 0.625 ns at the demonstrator's
  1.6 GSPS, 0.15625 ns at the 6400 MS/s run 108 was taken at) and does not
  survive into MIDAS. Anything drawing a time axis has to be told it, which is
  why ``/DQM/Scope/Sample Period ns`` exists.
* **AT00's telemetry is only sometimes filled.** The ten fields after
  ``nparents`` are zero in anything the .bin/.root repackagers write and carry
  real per-chip readout timings in generated demonstrator files, so a page
  showing them has to treat zero as "not reported" rather than "took no time".
"""

from __future__ import annotations

import struct

#: Bank names. The DAQ prefix-matches "AD"/"AT" and excludes "AD%"/"AT%",
#: which belong to a different digitiser.
AD_BANK = "AD00"
AT_BANK = "AT00"
AC_BANK = "AC00"

#: kMaxSamples in EventBankUnpacker.hh. Every hit carries all 64 slots whatever
#: its data_size says; the unused tail is zero and must not be plotted.
AD_MAX_SAMPLES = 64

#: One SAMPIC chip. channel // 16 is the chip, channel % 16 the input on it.
CHANNELS_PER_SAMPIC = 16

#: One FE board. ``channel`` counts within a board, so it is NOT unique across
#: an experiment: board 0 channel 5 and board 3 channel 5 are different readout
#: channels that both report ``channel == 5``. ``global_channel`` below is the
#: identity to key on; ``channel`` remains what the hardware calls it.
CHANNELS_PER_BOARD = 64

#: 11 x int32 HitHeader, then AD_MAX_SAMPLES x float32 volts, then HitScalars.
_HEADER = struct.Struct("<11i")
_WAVEFORM = struct.Struct(f"<{AD_MAX_SAMPLES}f")
_SCALARS = struct.Struct("<ifffffdfd")

#: Asserted rather than commented: a layout change that still compiles is the
#: failure mode this whole module is guarding against.
AD_HIT_BYTES = _HEADER.size + _WAVEFORM.size + _SCALARS.size
assert AD_HIT_BYTES == 344, AD_HIT_BYTES

HEADER_FIELDS = ("fe_board_index", "channel", "hit_number", "sampic_index",
                 "channel_index", "data_size", "inl_corrected", "adc_corrected",
                 "residual_pedestal_corrected", "cell_info",
                 "first_cell_physical_index")
SCALAR_FIELDS = ("raw_tot_value", "tot_value", "amplitude", "baseline", "peak",
                 "time_index", "time_instant", "time_amplitude",
                 "first_cell_timestamp")

#: One 56-byte EventTiming record. Spelled "<Q12I" rather than "<QII10I" --
#: byte-identical, and both unpack to a 13-tuple -- so the ten fields after
#: nparents can be named instead of discarded.
AT_RECORD = struct.Struct("<Q12I")
assert AT_RECORD.size == 56

AT_FIELDS = ("timestamp_ns", "nhits", "nparents",
             "sp_prepare_us_sum", "sp_read_us_sum", "sp_decode_us_sum",
             "sp_total_us_sum", "sp_prepare_us_max", "sp_read_us_max",
             "sp_decode_us_max", "sp_total_us_max",
             "sp_acq_retry_max", "sp_acq_retry_sum")

#: Everything after nparents: per-chip readout timings, microseconds, and the
#: acquisition retry counters. Zero means "not reported" -- see the note above.
AT_TELEMETRY_FIELDS = AT_FIELDS[3:]

#: One 32-byte CollectorTiming record, the AC00 bank. The event builder's own
#: account of assembling the event: when it stamped it, how many events and
#: hits went in, and where the time went.
AC_RECORD = struct.Struct("<Q6I")
assert AC_RECORD.size == 32

AC_FIELDS = ("collector_timestamp_ns", "n_events", "total_hits",
             "wait_us", "group_build_us", "finalize_us", "total_us")

#: Written into tot_value where the standalone .bin format carries no
#: time-over-threshold. It is a sentinel, not a measurement, and a page that
#: plots it draws a spike at -1 ns.
TOT_ABSENT = -1.0


def global_channel(hit) -> int:
    """``fe_board_index * CHANNELS_PER_BOARD + channel``.

    A single-board recording has ``fe_board_index == 0``, so this is the
    channel number itself and nothing about such a file changes.
    """
    return (int(hit.get("fe_board_index", 0)) * CHANNELS_PER_BOARD
            + int(hit["channel"]))


def encode_hit(hit: dict) -> bytes:
    """One 344-byte AD record from a dict of the field names above."""
    waveform = list(hit.get("waveform", ()))
    if len(waveform) > AD_MAX_SAMPLES:
        raise ValueError(f"{len(waveform)} samples exceeds kMaxSamples {AD_MAX_SAMPLES}")
    channel = int(hit.get("channel", 0))
    header = {
        "sampic_index": channel // CHANNELS_PER_SAMPIC,
        "channel_index": channel % CHANNELS_PER_SAMPIC,
        "data_size": len(waveform),
    }
    header.update({k: v for k, v in hit.items() if k in HEADER_FIELDS})
    header["channel"] = channel

    return (_HEADER.pack(*(int(header.get(f, 0)) for f in HEADER_FIELDS))
            + _WAVEFORM.pack(*(waveform + [0.0] * (AD_MAX_SAMPLES - len(waveform))))
            + _SCALARS.pack(int(hit.get("raw_tot_value", 0)),
                            *(float(hit.get(f, 0.0)) for f in SCALAR_FIELDS[1:])))


def encode_ad(hits: list[dict]) -> bytes:
    """The AD00 payload: hits back to back, with no count prefix.

    The hit count is the bank size divided by 344, which is why the assert above
    matters: a bank whose size is not a multiple of the record size is a layout
    disagreement, and decode_ad refuses it rather than reading a partial hit.
    """
    return b"".join(encode_hit(h) for h in hits)


def decode_hit(blob: bytes, offset: int = 0) -> dict:
    values = _HEADER.unpack_from(blob, offset)
    hit = dict(zip(HEADER_FIELDS, values))
    wf = _WAVEFORM.unpack_from(blob, offset + _HEADER.size)
    scalars = _SCALARS.unpack_from(blob, offset + _HEADER.size + _WAVEFORM.size)
    hit.update(zip(SCALAR_FIELDS, scalars))
    # Truncated to data_size, never the full 64: the tail is zero padding, and a
    # plot that includes it shows a cliff to 0 V that looks like a real edge.
    n = max(0, min(int(hit["data_size"]), AD_MAX_SAMPLES))
    hit["waveform"] = list(wf[:n])
    # Derived, not in the bank: the identity of the readout channel across
    # boards. Anything keyed on "which channel is this" wants this rather than
    # `channel`, which repeats once per board.
    hit["global_channel"] = global_channel(hit)
    return hit


def decode_ad(blob: bytes) -> list[dict]:
    if len(blob) % AD_HIT_BYTES:
        raise ValueError(
            f"AD00 payload of {len(blob)} bytes is not a multiple of {AD_HIT_BYTES}; "
            "the bank layout and this decoder disagree")
    return [decode_hit(blob, i) for i in range(0, len(blob), AD_HIT_BYTES)]


def encode_at(timestamp_ns: int, nhits: int, nparents: int | None = None,
              **telemetry) -> bytes:
    """One AT00 record. Telemetry defaults to zero, as the repackagers write it.

    An unknown telemetry name is an error rather than a silently dropped typo.
    """
    unknown = set(telemetry) - set(AT_TELEMETRY_FIELDS)
    if unknown:
        raise ValueError(f"unknown AT00 telemetry field(s): {sorted(unknown)}")
    return AT_RECORD.pack(
        int(timestamp_ns), int(nhits),
        int(nhits if nparents is None else nparents),
        *(int(telemetry.get(name, 0)) for name in AT_TELEMETRY_FIELDS))


def decode_at(blob: bytes) -> dict:
    """All 13 AT00 fields by name.

    The ten telemetry fields are kept rather than discarded. Anything that
    repackages a recording leaves them zero, but generated files fill them, and
    they are the only per-chip readout timing there is.
    """
    if len(blob) < AT_RECORD.size:
        raise ValueError(f"AT00 payload is {len(blob)} bytes, expected {AT_RECORD.size}")
    return dict(zip(AT_FIELDS, AT_RECORD.unpack_from(blob, 0)))


def encode_ac(collector_timestamp_ns: int, n_events: int, total_hits: int,
              wait_us: int = 0, group_build_us: int = 0, finalize_us: int = 0,
              total_us: int = 0) -> bytes:
    """One 32-byte AC00 record, in the order the unpacker reads it."""
    return AC_RECORD.pack(int(collector_timestamp_ns), int(n_events),
                          int(total_hits), int(wait_us), int(group_build_us),
                          int(finalize_us), int(total_us))


def decode_ac(blob: bytes) -> dict:
    """The AC00 payload: exactly one 32-byte record.

    Exact rather than "at least", mirroring the unpacker, which rejects any
    other size outright instead of reading the first 32 bytes of something
    else. ``total_hits`` is the checkable one: it should equal AT00's nhits and
    the AD00 hit count, and a disagreement means the event was assembled from
    parts that did not belong together.
    """
    if len(blob) != AC_RECORD.size:
        raise ValueError(f"AC00 payload is {len(blob)} bytes, expected {AC_RECORD.size}")
    return dict(zip(AC_FIELDS, AC_RECORD.unpack(blob)))
