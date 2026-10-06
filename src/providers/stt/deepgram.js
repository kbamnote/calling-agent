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
    // Interim transcripts, so barge-in fires because the caller said a WORD
    // rather than because the line got loud. The energy VAD stays for the
    // connect gate only.
    supportsPartials: true,
    // Deepgram does its own endpointing on a live socket, so the transport
    // feeds it every frame instead of posting one utterance at a time.
    streamsContinuously: true,

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
        // nova-3 is the multilingual generation: Hindi is supported and it
        // code-switches mid-stream, which is the normal case on these calls.
        // Known gap: numeral formatting is unsupported for Hindi on nova-3
        // multilingual, so figures come back as words.
        model: process.env.DEEPGRAM_MODEL || 'nova-3',
        // 'multi' handles Hindi/English code-switching mid-sentence — a
        // single-language model transcribes Hinglish badly in both directions.
        language: process.env.DEEPGRAM_LANGUAGE || 'multi',
        encoding: 'linear16',
        sample_rate: String(sampleRate),
        channels: '1',
        interim_results: 'true',
        // Deepgram closes the utterance itself, so the pipeline's own VAD is only
        // needed for the connect gate and barge-in, not for segmentation.
        // Kept in step with the pipeline's own end-of-turn window so the two
        // do not disagree about when the caller finished.
        endpointing: String(Number(process.env.VAD_SILENCE_MS) || 380),
        punctuate: 'true',
      });

      const ws = new WebSocket(ENDPOINT + '?' + params.toString(), {
        headers: { Authorization: 'Token ' + key },
      });

      // Frames that arrive before the socket opens must be buffered, not dropped:
      // the first 200ms of an utterance is where the greeting response lives.
      const pending = [];
      let open = false;
      let closed = false;
      // end() can be called before the handshake finishes — the diagnostics
      // check writes its audio and closes within the same millisecond. Sending
      // CloseStream on a CONNECTING socket throws, and swallowing that throw
      // meant Deepgram was never told to finalise: it sat waiting for more
      // audio, no transcript ever arrived, and the only symptom was a timeout
      // twenty seconds later. So the close is QUEUED like the audio is.
      let finishWhenOpen = false;
      // Finalised pieces of the utterance in progress, joined when the caller
      // stops. See the message handler.
      const segments = [];
      const confidences = [];
      const languages = new Set();

      function sendClose() {
        try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {
          log.warn('could not ask Deepgram to finalise:', e.message);
        }
      }

      ws.on('open', () => {
        open = true;
        while (pending.length) ws.send(pending.shift());
        if (finishWhenOpen) sendClose();
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

        // Deepgram reports a bad parameter as a message, not an HTTP status.
        // Ignoring these is how an unsupported option turns into "no transcript"
        // with nothing anywhere saying why.
        if (msg.type === 'Error' || msg.error) {
          const detail = msg.description || msg.message || msg.error || JSON.stringify(msg).slice(0, 200);
          log.error('deepgram rejected the stream:', detail);
          onError && onError(new Error('Deepgram: ' + detail));
          return;
        }

        const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
        if (!alt || !alt.transcript) return;

        // Deepgram has TWO kinds of final, and they mean different things.
        //
        //   is_final     this piece of text will not change again
        //   speech_final the speaker has STOPPED — the turn is over
        //
        // A long sentence produces several is_final segments before anyone
        // stops talking. Treating each as a turn would send half a sentence to
        // the model and then interrupt it with the other half. So segments are
        // accumulated and handed over as one utterance when speech_final says
        // the caller is actually done.
        if (msg.is_final) {
          segments.push(alt.transcript);
          // Kept per segment so the WORST one decides. A turn is only as
          // trustworthy as its least certain piece, and averaging would let a
          // long confident stretch carry a garbled word into the conversation.
          if (typeof alt.confidence === 'number') confidences.push(alt.confidence);
          // Where nova-3 multilingual says what it thinks it heard. The field has
          // moved between response shapes, so every known spelling is checked and
          // anything found is reported; finding none is not an error, it just
          // means the language gate has nothing to act on.
          const lang = msg.channel.detected_language
            || (Array.isArray(alt.languages) && alt.languages[0])
            || (Array.isArray(alt.words) && alt.words[0] && alt.words[0].language);
          if (lang) languages.add(String(lang).toLowerCase());
          // `from_finalize` is Deepgram answering our Finalize nudge. It counts
          // as the end of a turn just as speech_final does — it is the backstop
          // for exactly the case where its own endpointing never fires.
          if (!msg.speech_final && !msg.from_finalize) return;
          const utterance = segments.join(' ').replace(/\s+/g, ' ').trim();
          const meta = {
            confidence: confidences.length ? Math.min(...confidences) : null,
            languages: [...languages],
          };
          segments.length = 0;
          confidences.length = 0;
          languages.clear();
          if (utterance) onFinal && onFinal(utterance, meta);
          return;
        }
        // Interim: enough to know the caller is talking, which is what cuts the
        // agent off. The text itself is still changing.
        onPartial && onPartial(alt.transcript);
      });

      ws.on('error', (e) => {
        log.error('socket error:', e.message);
        onError && onError(e);
      });

      // 1000 is a normal close. Anything else is Deepgram refusing the query
      // string, and the reason names the offending parameter.
      ws.on('close', (code, reason) => {
        closed = true;
        const why = reason ? reason.toString().slice(0, 200) : '';
        if (code && code !== 1000) {
          log.error('deepgram closed the socket: ' + code + (why ? ' ' + why : ''));
          onError && onError(new Error('Deepgram closed the stream: ' + code + (why ? ' — ' + why : '')));
        }
      });

      return {
        write(pcm) {
          if (closed) return;
          if (open) ws.send(pcm);
          else pending.push(pcm);
        },
        /**
         * Finalise what is buffered WITHOUT closing the stream.
         *
         * Deepgram endpoints on the audio it hears, and a phone line is never
         * truly silent — on one call its VAD stayed open through continuous
         * line noise, so a caller finished speaking, our own VAD saw it, and
         * Deepgram never sent speech_final. No turn fired and the call died on
         * the silence timer with the customer waiting.
         *
         * So our VAD nudges it. This is the one message that says "give me what
         * you have" without ending the conversation.
         */
        flush() {
          if (closed || !open) return;
          try { ws.send(JSON.stringify({ type: 'Finalize' })); } catch (e) {
            log.warn('could not finalise:', e.message);
          }
        },

        end() {
          if (closed) return;
          // CloseStream finalises AND CLOSES — only ever right at teardown.
          if (open) sendClose();
          else finishWhenOpen = true;
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
