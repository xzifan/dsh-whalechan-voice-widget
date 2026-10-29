// Inspect encoded audio only; unknown/truncated formats stay unknown, never text estimates.
export function audioDurationSeconds(data) {
  if (!Buffer.isBuffer(data)) return null
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE') {
    let rate = 0, bytes = 0
    for (let at = 12; at + 8 <= data.length;) {
      const kind = data.toString('ascii', at, at + 4), size = data.readUInt32LE(at + 4), start = at + 8
      if (start + size > data.length) return null
      if (kind === 'fmt ' && size >= 16) {
        const format = data.readUInt16LE(start)
        // PCM, IEEE float, or their extensible container.
        if (![1, 3, 65534].includes(format)) return null
        rate = data.readUInt32LE(start + 8)
      }
      if (kind === 'data') bytes += size
      at = start + size + (size % 2)
    }
    return rate > 0 ? bytes / rate : null
  }
  if (data.length >= 42 && data.toString('ascii', 0, 4) === 'fLaC' && (data[4] & 127) === 0 && data.readUIntBE(5, 3) === 34) {
    const packed = data.readBigUInt64BE(18), rate = Number(packed >> 44n), samples = Number(packed & 0xfffffffffn)
    return rate && samples ? samples / rate : null
  }
  if (data.length >= 27 && data.toString('ascii', 0, 4) === 'OggS') {
    let at = 0, serial, rate, preSkip = 0, last = null, ended = false
    while (at + 27 <= data.length) {
      if (data.toString('ascii', at, at + 4) !== 'OggS') return null
      const stream = data.readUInt32LE(at + 14), count = data[at + 26]
      if (serial !== undefined && serial !== stream) return null // chained/multiplexed streams need a decoder
      serial = stream
      if (at + 27 + count > data.length) return null
      let size = 0
      for (let i = 0; i < count; i++) size += data[at + 27 + i]
      const start = at + 27 + count
      if (start + size > data.length) return null
      if (rate === undefined) {
        if (size >= 19 && data.toString('ascii', start, start + 8) === 'OpusHead') { rate = 48000; preSkip = data.readUInt16LE(start + 10) }
        else if (size >= 16 && data[start] === 1 && data.toString('ascii', start + 1, start + 7) === 'vorbis') rate = data.readUInt32LE(start + 12)
        else return null
      }
      const granule = data.readBigUInt64LE(at + 6)
      if (granule !== 0xffffffffffffffffn) last = Number(granule)
      ended = !!(data[at + 5] & 4)
      at = start + size
    }
    return ended && at === data.length && rate > 0 && last !== null && last >= preSkip ? (last - preSkip) / rate : null
  }
  // MPEG Layer III: sum frame sample counts (including VBR), never file-size/bitrate estimates.
  let at = 0, seconds = 0, frames = 0
  if (data.length >= 10 && data.toString('ascii', 0, 3) === 'ID3') {
    if ([...data.subarray(6, 10)].some(byte => byte & 128)) return null
    at = 10 + (data[6] * 2097152 + data[7] * 16384 + data[8] * 128 + data[9]) + ((data[5] & 16) ? 10 : 0)
  }
  while (at + 4 <= data.length) {
    if (data.length - at === 128 && data.toString('ascii', at, at + 3) === 'TAG') { at += 128; break }
    const h = data.readUInt32BE(at), version = (h >>> 19) & 3, layer = (h >>> 17) & 3
    if ((h >>> 21) !== 2047 || version === 1 || layer !== 1) return null
    const bitrateIndex = (h >>> 12) & 15, rateIndex = (h >>> 10) & 3
    const rates = [44100, 48000, 32000]
    const bitrates = version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160]
    const bitrate = bitrates[bitrateIndex], rate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    if (!bitrate || !rate) return null
    const size = Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / rate) + ((h >>> 9) & 1)
    if (at + size > data.length) return null
    seconds += (version === 3 ? 1152 : 576) / rate; frames++; at += size
  }
  return frames && at === data.length ? seconds : null
}
