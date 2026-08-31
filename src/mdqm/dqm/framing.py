"""The binary wire format between the analyzer and the browser.

Deliberately byte-compatible with musip's DQM, whose JavaScript decoder
(``musip/custom/onlineDQM.js``) this was written against. That costs nothing --
the format is fully specified by the decoder we would have had to read anyway --
and buys two things: musip's page can drive our analyzer unmodified, and our
generic browser page can drive theirs.

Everything is little-endian.

Envelope
--------
Every reply is an 8-byte header followed by a payload::

    u32  total size, including these 8 bytes
    char tag[4]                      e.g. b"hist", b"list", b"json"

Eight bytes precisely so the payload starts 8-aligned and a ``float64`` in it
cannot be misaligned.

    A trap worth knowing: musip's C++ enum stores ``hist`` as 0x74736968 while
    its JavaScript reads the four bytes big-endian and compares 0x68697374. Same
    bytes, opposite integer conventions. Write ``b"hist"`` and never think about
    it in integers.

Histogram payload
-----------------
::

    u8   version = 1
    u8   type                    index into musip's object_type variant
    u8   dimensions
    u8   abscissa_size[dimensions]   float width of the axis edges, 4 or 8
    u8   ordinate_size               bin content width, 4 or 8
    <align 4>
    u32  n_bins[dimensions]          NOT counting under/overflow
    <align abscissa_size, per axis>
    f    low_edge, high_edge         per axis
    <align 8>
    u64  entries
    <align ordinate_size>
    data[prod(n_bins[d] + 2)]        under- and overflow included, x fastest

The alignment is relative to the start of the *payload*, because the page slices
the envelope off (``rpc.slice(8)``) before handing the rest to a typed-array
constructor, which throws on a misaligned offset.
"""

from __future__ import annotations

import struct

import numpy as np

HEADER = struct.Struct("<I4s")
HEADER_SIZE = HEADER.size

# Tags. The first three are musip's; the rest are ours.
TAG_LIST = b"list"
TAG_HIST = b"hist"
TAG_META = b"meta"
TAG_JSON = b"json"
TAG_SCOPE = b"scop"
TAG_ERROR = b"err "

#: Index into musip's ``PlotCollection::object_type`` variant. Only the ones we
#: emit are named; the numbering is theirs and must not be renumbered.
TYPE_1D_F32 = 0
TYPE_1D_F64 = 1
TYPE_2D_F32 = 2
TYPE_1D_U32 = 3
TYPE_2D_U32 = 4
TYPE_2D_F64 = 6

_DTYPE_FOR_TYPE = {
    TYPE_1D_F32: np.float32,
    TYPE_1D_F64: np.float64,
    TYPE_2D_F32: np.float32,
    TYPE_1D_U32: np.uint32,
    TYPE_2D_U32: np.uint32,
    TYPE_2D_F64: np.float64,
}


def _align(buf: bytearray, alignment: int) -> None:
    """Pad to the next multiple of `alignment`, counting from the payload start."""
    remainder = len(buf) % alignment
    if remainder:
        buf.extend(b"\x00" * (alignment - remainder))


def envelope(tag: bytes, payload: bytes) -> bytes:
    """Wrap a payload in the 8-byte header the page expects."""
    if len(tag) != 4:
        raise ValueError(f"tag must be exactly 4 bytes, got {tag!r}")
    return HEADER.pack(HEADER_SIZE + len(payload), tag) + payload


def parse_envelope(blob: bytes) -> tuple[int, bytes, bytes]:
    """Inverse of `envelope`, for tests and for talking to another analyzer."""
    if len(blob) < HEADER_SIZE:
        raise ValueError(f"short read: {len(blob)} bytes cannot hold an 8-byte header")
    size, tag = HEADER.unpack_from(blob, 0)
    return size, tag, blob[HEADER_SIZE:size]


def encode_histogram(
    counts: np.ndarray,
    edges: list[tuple[float, float]],
    entries: int,
    *,
    ordinate_size: int = 4,
    abscissa_size: int = 8,
) -> bytes:
    """Encode a histogram, under/overflow bins included.

    `counts` has shape (nx+2,) or (ny+2, nx+2) -- the +2 per axis is the
    under/overflow pair, which the format carries and the page strips.
    """
    dims = counts.ndim
    if dims not in (1, 2):
        raise ValueError(f"only 1D and 2D histograms are encodable, got {dims}D")
    if len(edges) != dims:
        raise ValueError(f"{dims}D histogram needs {dims} edge pairs, got {len(edges)}")

    is_int = np.issubdtype(counts.dtype, np.integer)
    if dims == 1:
        htype = TYPE_1D_U32 if is_int else (TYPE_1D_F32 if ordinate_size == 4 else TYPE_1D_F64)
    else:
        htype = TYPE_2D_U32 if is_int else (TYPE_2D_F32 if ordinate_size == 4 else TYPE_2D_F64)
    if is_int and ordinate_size != 4:
        raise ValueError("integer histograms are u32; ordinate_size must be 4")

    # numberOfBins excludes under/overflow; counts includes it.
    n_bins = [n - 2 for n in reversed(counts.shape)]   # x first, as the format wants
    if any(n < 1 for n in n_bins):
        raise ValueError(f"counts shape {counts.shape} is too small for under/overflow")

    buf = bytearray()
    buf.append(1)                       # version
    buf.append(htype)
    buf.append(dims)
    for _ in range(dims):
        buf.append(abscissa_size)
    buf.append(ordinate_size)

    _align(buf, 4)
    for n in n_bins:
        buf.extend(struct.pack("<I", n))

    edge_fmt = "<d" if abscissa_size == 8 else "<f"
    for lo, hi in edges:
        _align(buf, abscissa_size)
        buf.extend(struct.pack(edge_fmt, float(lo)))
        buf.extend(struct.pack(edge_fmt, float(hi)))

    _align(buf, 8)
    buf.extend(struct.pack("<Q", int(entries)))

    _align(buf, ordinate_size)
    # Row-major with x fastest, which is what the page's
    # `zData[j + i*nx]` indexing expects and what C++ writes.
    buf.extend(np.ascontiguousarray(counts, dtype=_DTYPE_FOR_TYPE[htype]).tobytes())
    return bytes(buf)


def decode_histogram(payload: bytes) -> dict:
    """Decode `encode_histogram`'s output. A Python mirror of the JS decoder.

    Exists so the round trip can be asserted without a JavaScript engine; the
    cross-language test additionally checks the bytes against musip's own
    decoder, which is what makes the compatibility claim real rather than
    self-referential.
    """
    off = 0

    def align(to: int) -> None:
        nonlocal off
        rem = off % to
        if rem:
            off += to - rem

    version = payload[off]
    off += 1
    if version != 1:
        raise ValueError(f"unknown histogram version {version}")
    htype = payload[off]
    off += 1
    dims = payload[off]
    off += 1
    abscissa = [payload[off + i] for i in range(dims)]
    off += dims
    ordinate = payload[off]
    off += 1

    align(4)
    n_bins = list(struct.unpack_from(f"<{dims}I", payload, off))
    off += 4 * dims

    lo_edges, hi_edges = [], []
    for size in abscissa:
        align(size)
        fmt = "<d" if size == 8 else "<f"
        lo_edges.append(struct.unpack_from(fmt, payload, off)[0])
        off += size
        hi_edges.append(struct.unpack_from(fmt, payload, off)[0])
        off += size

    align(8)
    entries = struct.unpack_from("<Q", payload, off)[0]
    off += 8

    align(ordinate)
    total = 1
    for n in n_bins:
        total *= n + 2
    data = np.frombuffer(payload, dtype=_DTYPE_FOR_TYPE[htype], count=total, offset=off)
    shape = tuple(n + 2 for n in reversed(n_bins))
    return {
        "type": htype,
        "n_bins": n_bins,
        "low_edge": lo_edges,
        "high_edge": hi_edges,
        "entries": entries,
        "counts": data.reshape(shape),
    }


# ---------------------------------------------------------------------------
# Scope frames
# ---------------------------------------------------------------------------
#
# One triggered event: every channel's samples plus the quantities derived from
# *that* event, in a single reply.
#
# The single reply is the whole point. An event display exists to be pointed at
# -- "channel 3 looks odd on this one" -- so the traces on screen and the phase
# printed beside them have to come from the same event, and every screen has to
# be showing the same event as every other. Both are guaranteed by construction
# if there is one frame, and by nothing at all if the page assembles traces from
# one source and numbers from another.
#
# Samples travel as the native int16 they came off the wire as, with the volts
# scale in the channel header. That is 32 kB for sixteen channels against about
# 150 kB of JSON, and the browser does one multiply while copying into a
# Float32Array instead of parsing.

SCOPE_HEADER = struct.Struct("<IIQIIIIQffIIII")
"""64 bytes: version, nChannels, frameSeq, run, event, trigger, triggerType,
timestampTicks, boardTempC, nominalPs, flags, nDerived, boardId, reserved."""

CHANNEL_HEADER = struct.Struct("<HHHBBfI")
"""16 bytes: channel, firstBin, nSamples, encoding, decoded, scale, pad."""

DERIVED_ENTRY = struct.Struct("<16sd")
"""24 bytes: a NUL-padded name and a float64."""

SCOPE_VERSION = 1

#: `flags` bits.
SCOPE_HAVE_WIDTHS = 1 << 0
SCOPE_RUN_ACTIVE = 1 << 1
SCOPE_WIDTHS_CACHED = 1 << 2

VOLTS_SCALE = 1e-4
"""Encoding mode 0: sample * this = volts. Matches wdunpack's VOLTAGE_SCALE."""


def encode_scope_frame(
    channels: list[dict],
    *,
    frame_seq: int = 0,
    run_number: int = 0,
    event_number: int = 0,
    trigger_number: int = 0,
    trigger_type: int = 0,
    timestamp_ticks: int = 0,
    board_temp_c: float = 0.0,
    nominal_ps: float = 0.0,
    board_id: int = 0,
    have_widths: bool = False,
    widths_cached: bool = False,
    run_active: bool = False,
    derived: dict[str, float] | None = None,
) -> bytes:
    """Encode one event.

    Each entry of `channels` is
    ``{"channel", "first_bin", "samples" (int16 array or None), "encoding"}``;
    a `samples` of None means the channel could not be decoded, which is
    carried through rather than dropped so the page can grey that panel out
    instead of silently omitting it.
    """
    derived = derived or {}
    flags = 0
    if have_widths:
        flags |= SCOPE_HAVE_WIDTHS
    if run_active:
        flags |= SCOPE_RUN_ACTIVE
    if widths_cached:
        flags |= SCOPE_WIDTHS_CACHED

    buf = bytearray()
    buf.extend(SCOPE_HEADER.pack(
        SCOPE_VERSION, len(channels), int(frame_seq),
        int(run_number), int(event_number),
        int(trigger_number), int(trigger_type),
        int(timestamp_ticks),
        float(board_temp_c), float(nominal_ps),
        flags, len(derived), int(board_id), 0))

    for ch in channels:
        samples = ch.get("samples")
        decoded = samples is not None
        arr = np.ascontiguousarray(samples, dtype="<i2") if decoded else np.empty(0, "<i2")
        buf.extend(CHANNEL_HEADER.pack(
            int(ch["channel"]) & 0xFFFF,
            int(ch.get("first_bin", 0)) & 0xFFFF,
            int(arr.size) & 0xFFFF,
            int(ch.get("encoding", 0)) & 0xFF,
            1 if decoded else 0,
            float(ch.get("scale", VOLTS_SCALE)),
            0))
        buf.extend(arr.tobytes())
        _align(buf, 8)

    for name, value in derived.items():
        buf.extend(DERIVED_ENTRY.pack(name.encode()[:16], float(value)))

    return bytes(buf)


def decode_scope_frame(payload: bytes) -> dict:
    """Decode `encode_scope_frame`. A Python mirror, for tests and for reuse."""
    (version, n_channels, frame_seq, run_number, event_number,
     trigger_number, trigger_type, timestamp_ticks,
     board_temp_c, nominal_ps, flags, n_derived, board_id,
     _reserved) = SCOPE_HEADER.unpack_from(payload, 0)
    if version != SCOPE_VERSION:
        raise ValueError(f"unknown scope frame version {version}")

    off = SCOPE_HEADER.size
    channels = []
    for _ in range(n_channels):
        (channel, first_bin, n_samples, encoding, decoded, scale,
         _pad) = CHANNEL_HEADER.unpack_from(payload, off)
        off += CHANNEL_HEADER.size
        samples = None
        if decoded:
            samples = np.frombuffer(payload, dtype="<i2", count=n_samples, offset=off)
        off += n_samples * 2
        rem = off % 8
        if rem:
            off += 8 - rem
        channels.append({
            "channel": channel, "first_bin": first_bin, "encoding": encoding,
            "decoded": bool(decoded), "scale": scale, "samples": samples,
        })

    derived = {}
    for _ in range(n_derived):
        raw_name, value = DERIVED_ENTRY.unpack_from(payload, off)
        off += DERIVED_ENTRY.size
        derived[raw_name.rstrip(b"\x00").decode()] = value

    return {
        "frame_seq": frame_seq, "run_number": run_number,
        "event_number": event_number, "trigger_number": trigger_number,
        "trigger_type": trigger_type, "timestamp_ticks": timestamp_ticks,
        "board_temp_c": board_temp_c, "nominal_ps": nominal_ps,
        "board_id": board_id,
        "have_widths": bool(flags & SCOPE_HAVE_WIDTHS),
        "run_active": bool(flags & SCOPE_RUN_ACTIVE),
        "widths_cached": bool(flags & SCOPE_WIDTHS_CACHED),
        "channels": channels, "derived": derived,
    }
