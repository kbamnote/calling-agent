/**
 * Deepgram streaming STT.
 *
 * Real-time, interim results included, which is what makes barge-in feel natural:
 * the pipeline can stop the agent talking the moment ANY interim word arrives,
 * without waiting for a final transcript.
 *
 * NOT YET EXERCISED AGAINST A LIVE KEY — written to the documented protocol. The
 * first engineer with a Deepgram account should run `npm run doctor` and then a
 * browser-mic call before trusting it on a phone line.
 */
const WebSocket = require('ws');
const log = require('../../util/log').make('stt:deepgram');

const ENDPOINT = 'wss://api.deepgram.com/v1/listen';

function create(config) {
  const key = config.stt.deepgramKey;

  return {
    name: 'deepgram',
    clientSide: false,

    /**
     * @param {Object} o
     * @param {string} [o.language]      BCP-47, e.g. 'hi' / 'en-IN'
     * @param {number} [o.sampleRate]    PCM sample rate of the frames we write
     * @param {Function} o.onPartial     (text) => void — interim, use for barge-in
     * @param {Function} o.onFinal       (text) => void — settled utterance
     * @param {Function} [o.onError]
     */
    createStream({ language, sampleRate = 8000, onPartial, onFinal, onError }) {
      if (!key) throw new Error('DEEPGRAM_API_KEY is not set');

      const params = new URLSearchParams({
        model: 'nova-2',
        // 'multi' handles Hindi/English code-switching mid-sentence, which is
        // the normal case on these calls — a single-language model transcribes
        // Hinglish badly in both directions.
        language: language || 'multi',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        channels: '1',
        interim_results: 'true',
        // Deepgram closes the utterance itself, so the pipeline's own VAD is only
        // needed for the connect gate and barge-in, not for segmentation.
        endpointing: '300',
        punctuate: 'true',
        smart_format: 'true',
      });

      const ws = new WebSocket(ENDPOINT + '?' + params.toString(), {
        headers: { Authorization: 'Token ' + key },
      });

      // Frames that arrive before the socket opens must be buffered, not dropped:
      // the first 200ms of an utterance is where the greeting response lives.
      const pending = [];
      let open = false;
      let closed = false;

      ws.on('open', () => {
        open = true;
        while (pending.length) ws.send(pending.shift());
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        if (!alt || !alt.transcript) return;
        if (msg.is_final) onFinal && onFinal(alt.transcript);
        else onPartial && onPartial(alt.transcript);
      });

      ws.on('error', (e) => {
        log.error('socket error:', e.message);
        onError && onError(e);
      });
      ws.on('close', () => { closed = true; });

      return {
        write(pcm) {
          if (closed) return;
          if (open) ws.send(pcm);
          else pending.push(pcm);
        },
        end() {
          if (closed) return;
          // Tells Deepgram to flush and finalise rather than truncating the tail.
          try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* already gone */ }
        },
        close() {
          closed = true;
          try { ws.close(); } catch (e) { /* already gone */ }
        },
      };
    },
  };
}

module.exports = { create };
