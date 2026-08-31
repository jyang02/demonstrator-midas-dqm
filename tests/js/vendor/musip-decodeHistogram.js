//
// VERBATIM COPY -- do not edit.
//
// musip/custom/onlineDQM.js @ 6445ced, decodeHistogram() only.
//
// This is here so our encoder can be checked against the decoder it claims
// compatibility with, rather than against our own Python mirror of it. A test
// that decodes our bytes with our own decoder proves only that we are
// self-consistent; this one proves musip's page could drive our analyzer.
//
// Re-extract with the snippet in tests/test_vendor.py if musip's copy moves on.
//

/** Decodes a histogram encoded in binary as an arraybuffer. */
function decodeHistogram(arraybuffer) {
    let alignTo = function(byteIndex, alignment) {
        let remainder = byteIndex % alignment;
        if(remainder == 0) return byteIndex; // Already at the requested alignment
        else return byteIndex + (alignment - remainder); // Add on the amount required to align properly
    }

    let dataView = new DataView(arraybuffer);

    const little_endian = true;
    let currentByte = 0;
    let version = dataView.getUint8(currentByte++, little_endian);

    if(version != 1) throw new Error("Don't know how to decode a histogram with version " + version);

    let histogram = {};

    // histogramType is the index into the C++ mu3e::dqm::PlotCollection::object_type variant. There's
    // quite a lot of redundant information in the format (dimensions and type sizes) but this is the
    // only place where it says if the bin content is an integer or floating point type.
    // Possible values are:
    //  * 0: Histogram1DF - 1D 32 bit float histogram
    //  * 1: Histogram1DD - 1D 64 bit float histogram
    //  * 2: Histogram2DF - 2D 32 bit float histogram
    //  * 3: Histogram1DI - 1D 32 bit unsigned int histogram
    //  * 4: Histogram2DI - 2D 32 bit unsigned int histogram
    //  * 5: RollingHistogram2DF - this is the same as Histogram2DF by the time it gets here
    //  * 6: Histogram2DD - 2D 64 bit float histogram
    let histogramType = dataView.getUint8(currentByte++, little_endian);
    const isIntegerType = (histogramType == 3 || histogramType == 4);
    let dimensions = dataView.getUint8(currentByte++, little_endian);

    let abscissaSizes = [];
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        abscissaSizes[dimension] = dataView.getUint8(currentByte++, little_endian);
    }

    let ordinateSize = dataView.getUint8(currentByte++, little_endian);

    currentByte = alignTo(currentByte, 4); // bin sizes are Uint32 and aligned on that boundary

    histogram.numberOfBins = [];
    let totalBins = 1;
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        histogram.numberOfBins[dimension] = dataView.getUint32(currentByte, little_endian);
        currentByte += 4;
        totalBins *= (histogram.numberOfBins[dimension] + 2); // `+2` for under and overflow bins
    }

    // It's easier to read a datatype given its size rather than use the function name
    let readFloat = function(size, offset, endianness) {
        if(size == 4) return dataView.getFloat32(offset, endianness)
        else if(size == 8) return dataView.getFloat64(offset, endianness)
        else throw new Error("Can't decode histogram because a float of size " + size + " was requested.");
    }

    histogram.lowEdge = []
    histogram.highEdge = []
    for(let dimension = 0; dimension < dimensions; ++dimension) {
        let size = abscissaSizes[dimension];
        currentByte = alignTo(currentByte, size);
        histogram.lowEdge[dimension] = readFloat(size, currentByte, little_endian);
        currentByte += size;
        histogram.highEdge[dimension] = readFloat(size, currentByte, little_endian);
        currentByte += size;
    }

    currentByte = alignTo(currentByte, 8); // entries is a Uint64 and aligned on that boundary
    histogram.entries = dataView.getBigUint64(currentByte, little_endian);
    currentByte += 8;

    currentByte = alignTo(currentByte, ordinateSize); // data will be aligned to its size
    if(ordinateSize == 4 && !isIntegerType) histogram.data = new Float32Array(arraybuffer, currentByte, totalBins);
    else if(ordinateSize == 4 && isIntegerType) histogram.data = new Uint32Array(arraybuffer, currentByte, totalBins);
    else if(ordinateSize == 8) histogram.data = new Float64Array(arraybuffer, currentByte, totalBins);
    else throw new Error("Don't know how to decode a histogram with ordinate size " + ordinateSize);

    return histogram;
}

module.exports = { decodeHistogram };
