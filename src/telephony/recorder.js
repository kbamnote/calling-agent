/**
 * Records a call as stereo MP3: the customer on the left, the agent on the right.
 *
 * ── WHY STEREO, NOT A MIX ────────────────────────────────────────────────────
 * The two halves arrive from different places — the customer's audio comes in
 * over the media socket, the agent's is what we hand out to be played — so they
 * were never mixed to begin with. Keeping them apart costs nothing and makes the
 * recording answer the question it is usually opened for: who was talking over
 * whom. A mixed mono track of an agent and a caller both speaking is exactly as
 * hard to review as the live call was.
 *
 * ── WHY A WALL CLOCK ─────────────────────────────────────────────────────────
 * Neither side arrives at a steady rate. Inbound frames stop while nobody is
 * speaking; an entire agent utterance arrives in ONE buffer and is then played
 * out over several seconds. So a chunk is written at the position its wall-clock
 * arrival implies, and the gap before it is filled with silence. Appending
 * instead would slide the two tracks out of step a little more on every pause,
 * and by the end of a 90-second call they would be describing different
 * conversations.
 *
 * Audio is held in memory for the length of the call — about 4 MB for a
 * 68-second call at 16 kHz — and encoded once, at the end.
 */
const log = require('../util/log').make('rec');

// A ceiling on what one call can hold, so a line that never hangs up cannot eat
// the container. At 16 kHz stereo this is about 19 MB.
const MAX_SECONDS = Number(process.env.RECORDING_MAX_SECONDS) || 300;

// 32 kbps stereo is ~277 KB for a 68-second call. Speech at 16 kHz does not get
// meaningfully better above this, and storage is billed per call for ever.
const BITRATE = Number(process.env.RECORDING_BITRATE_KBPS) || 32;

/** Int16 PCM, grown in blocks rather than reallocated per chunk. */
function track(capacity) {
  return { buf: new Int16Array(capacity), len: 0 };
}

function writeAt(t, samples, atSample, cap) {
  const end = Math.min(atSample + samples.length, cap);
  if (atSample >= cap) return;
  // The gap since whatever was written last is silence, which Int16Array
  // already is — so only `len` has to move.
  for (let i = atSample, j = 0; i < end; i += 1, j += 1) t.buf[i] = samples[j];
  if (end > t.len) t.len = end;
}

/**
 * @param {number} o.sampleRate  the transport's rate; both tracks share it
 */
function create({ callId = '', sampleRate = 16000 } = {}) {
  const cap = sampleRate * MAX_SECONDS;
  const left = track(cap);          // the customer
  const right = track(cap);         // the agent
  const startedAt = Date.now();
  let overflowed = false;

  const positionNow = () => Math.floor(((Date.now() - startedAt) / 1000) * sampleRate);

  /** PCM16LE straight off the wire or out of the synthesiser. */
  const add = (t, buf) => {
    if (!buf || !buf.length) return;
    const at = positionNow();
    if (at >= cap) {
      if (!overflowed) {
        overflowed = true;
        log.warn(callId + ': past ' + MAX_SECONDS + 's — the rest is not being recorded');
      }
      return;
    }
    // Int16Array over the SAME memory, not a copy. byteOffset matters: Node
    // pools small Buffers, so a Buffer rarely starts at offset 0 of its pool.
    const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    writeAt(t, samples, at, cap);
  };

  return {
    /** Inbound audio — what the customer said. */
    customer: (buf) => add(left, buf),
    /**
     * Outbound audio — what the agent was given to say.
     *
     * Written at the moment it is HANDED OVER, which is when playback starts, so
     * it lands in the right place on the timeline. A barge-in that cuts playback
     * short still leaves the whole utterance here: the recording then holds a
     * second or two the caller never heard. Worth knowing when reviewing one.
     */
    agent: (buf) => add(right, buf),

    seconds: () => Math.max(left.len, right.len) / sampleRate,

    /** Encodes both tracks to one stereo MP3. Returns null if nothing was heard. */
    async finish() {
      const n = Math.max(left.len, right.len);
      if (n < sampleRate) return null;          // under a second is not a call

      // ESM-only package, and this service is CommonJS. Imported here rather
      // than at module load so a call that is not being recorded never pays for
      // it, and a broken install cannot stop the service booting.
      const m = await import('@breezystack/lamejs');
      const lame = m.default || m;
      const enc = new lame.Mp3Encoder(2, sampleRate, BITRATE);

      const out = [];
      const BLOCK = 1152;                        // one MP3 frame
      for (let i = 0; i < n; i += BLOCK) {
        const chunk = enc.encodeBuffer(
          left.buf.subarray(i, Math.min(i + BLOCK, n)),
          right.buf.subarray(i, Math.min(i + BLOCK, n)),
        );
        if (chunk.length) out.push(Buffer.from(chunk));
      }
      const tail = enc.flush();
      if (tail.length) out.push(Buffer.from(tail));

      const mp3 = Buffer.concat(out);
      log.info(callId + ': ' + (n / sampleRate).toFixed(1) + 's -> '
        + Math.round(mp3.length / 1024) + ' KB');
      return mp3;
    },
  };
}

module.exports = { create, MAX_SECONDS, BITRATE };
