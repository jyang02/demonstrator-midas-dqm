"""The AD00 and AT00 bank layouts, as bytes.

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
  header (``1e3 / sampling_freq_msps`` ns, 0.15625 ns at 6400 MS/s) and does not
  survive into MIDAS. Anything drawing a time axis has to be told it, which is
  why ``/DQM/Scope/Sample Period ns`` exists.
"""

from __future__ import annotations

import struct

#: Bank names. The DAQ prefix-matches "AD"/"AT" and excludes "AD%"/"AT%",
#: which belong to a different digitiser.
AD_BANK = "AD00"
AT_BANK = "AT00"

#: kMaxSamples in EventBankUnpacker.hh. Every hit carries all 64 slots whatever
#: its data_size says; the unused tail is zero and must not be plotted.
AD_MAX_SAMPLES = 64

#: One SAMPIC chip. channel // 16 is the chip, channel % 16 the input on it.
CHANNELS_PER_SAMPIC = 16

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

#: One 56-byte EventTiming record: fe_timestamp_ns, nhits, nparents, 10 reserved.
AT_RECORD = struct.Struct("<QII10I")
assert AT_RECORD.size == 56

#: Written into tot_value where the standalone .bin format carries no
#: time-over-threshold. It is a sentinel, not a measurement, and a page that
#: plots it draws a spike at -1 ns.
TOT_ABSENT = -1.0


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
    return hit


def decode_ad(blob: bytes) -> list[dict]:
    if len(blob) % AD_HIT_BYTES:
        raise ValueError(
            f"AD00 payload of {len(blob)} bytes is not a multiple of {AD_HIT_BYTES}; "
            "the bank layout and this decoder disagree")
    return [decode_hit(blob, i) for i in range(0, len(blob), AD_HIT_BYTES)]


def encode_at(timestamp_ns: int, nhits: int, nparents: int | None = None) -> bytes:
    return AT_RECORD.pack(int(timestamp_ns), int(nhits),
                          int(nhits if nparents is None else nparents), *([0] * 10))


def decode_at(blob: bytes) -> dict:
    if len(blob) < AT_RECORD.size:
        raise ValueError(f"AT00 payload is {len(blob)} bytes, expected {AT_RECORD.size}")
    ts, nhits, nparents, *_ = AT_RECORD.unpack_from(blob, 0)
    return {"timestamp_ns": ts, "nhits": nhits, "nparents": nparents}
