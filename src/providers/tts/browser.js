/**
 * Client-side TTS — the browser speaks with the Web Speech API. Free, no key.
 *
 * Returns no audio: the transport forwards the TEXT and the page calls
 * speechSynthesis. Same limitation as the browser STT driver — unusable on a real
 * phone line, ideal for testing.
 */
module.exports = {
  create() {
    return {
      name: 'browser',
      clientSide: true,
      async synth({ text }) {
        return { audio: null, mime: null, chars: (text || '').length };
      },
    };
  },
};
