/**
 * No speech at all — the agent's turns are printed, not spoken. What
 * `npm run chat` uses, so the conversation logic can be iterated on in a terminal
 * with no audio stack involved.
 */
module.exports = {
  create() {
    return {
      name: 'none',
      clientSide: false,
      textOnly: true,
      async synth({ text }) {
        return { audio: null, mime: null, chars: (text || '').length };
      },
    };
  },
};
