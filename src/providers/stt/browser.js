/**
 * Client-side STT — the browser transcribes with the Web Speech API and sends us
 * text. Free, no key, no account, and usable Hindi on Chrome and Edge.
 *
 * This is the zero-cost testing path. It CANNOT serve real phone calls: there is
 * no browser on a phone line, so a telephony transport must pick a server-side
 * driver (deepgram / sarvam). The pipeline reads `clientSide` and skips opening a
 * server stream entirely.
 */
module.exports = {
  create() {
    return {
      name: 'browser',
      clientSide: true,
      // Present so the pipeline can call it uniformly; it is never used, because
      // final text arrives straight off the transport.
      createStream() {
        throw new Error('The browser STT driver transcribes client-side; no server stream exists.');
      },
    };
  },
};
