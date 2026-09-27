/**
 * WAV container helpers.
 *
 * Several TTS vendors return a WAV file, but every telephony provider wants RAW
 * PCM samples on the wire. Sending the container through means the 44-byte RIFF
 * header is played as audio — a click, then noise — and when a long turn is
 * synthesised in several pieces you get a header in the MIDDLE of the speech too.
 *
 * It presents as "the call connects but there is no voice", which is a
 * frustrating thing to debug from the outside, so the stripping happens here,
 * once, for every driver.
 */

/**
 * Returns the raw PCM inside a WAV buffer, plus what the header claims about it.
 * A buffer that is not WAV is passed through untouched — callers may legitimately
 * hand this raw PCM already.
 *
 * Walks the RIFF chunk list rather than assuming the data starts at byte 44:
 * headers carrying LIST/INFO metadata are common and would otherwise leave
 * metadata bytes at the front of the audio.
 *
 * @returns {{pcm: Buffer, sampleRate: number|null, channels: number|null, bits: number|null, wasWav: boolean}}
 */
function stripWavHeader(buf) {
  const none = { pcm: buf, sampleRate: null, channels: null, bits: null, wasWav: false };
  if (!buf || buf.length < 12) return none;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return none;

  let offset = 12;
  let sampleRate = null;
  let channels = null;
  let bits = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A streamed WAV can declare size 0 or 0xFFFFFFFF; trust the buffer then.
      const end = (size > 0 && body + size <= buf.length) ? body + size : buf.length;
      return { pcm: buf.subarray(body, end), sampleRate, channels, bits, wasWav: true };
    }

    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  return none;
}

/**
 * Concatenates TTS pieces into one raw PCM buffer, stripping a header from each.
 *
 * @returns {{pcm: Buffer, sampleRate: number|null}}
 */
function joinPcm(buffers) {
  const parts = [];
  let sampleRate = null;
  for (const b of buffers) {
    const { pcm, sampleRate: sr } = stripWavHeader(b);
    if (sr && !sampleRate) sampleRate = sr;
    parts.push(pcm);
  }
  return { pcm: Buffer.concat(parts), sampleRate };
}

module.exports = { stripWavHeader, joinPcm };
