/**
 * Hear a voice, and find out what it costs in latency.
 *
 * "Confident" is a judgement nobody can make from a spec sheet, and the only
 * reason not to steer the voice with a description is the time it adds to the
 * FIRST reply of every turn. So this does both at once: writes the audio where
 * you can play it, and reports time to first audio.
 *
 *   node src/scripts/auditionVoice.js
 *   node src/scripts/auditionVoice.js zoya
 *   node src/scripts/auditionVoice.js zoya "a female 30s indian voice, confident, clear, assertive"
 *
 * Costs real money — about 0.08 rupees per run at mulberry's rate.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LINE = process.env.AUDITION_TEXT
  || 'Namaste Kunal ji! Main Tapify se bol rahi hoon, aapka feedback lena tha.'
  + ' Kya aapse do minute baat ho sakti hai?';

(async () => {
  const speaker = process.argv[2] || process.env.RUMIK_SPEAKER || 'siya';
  const description = process.argv[3] || process.env.RUMIK_DESCRIPTION || '';

  // Set before the driver reads them.
  process.env.RUMIK_SPEAKER = speaker;
  process.env.RUMIK_DESCRIPTION = description;
  delete require.cache[require.resolve('../config')];
  const config = require('../config');
  if (!config.tts.rumikKey) {
    console.log('\nRUMIK_API_KEY is not set.\n');
    process.exit(1);
  }

  const driver = require('../providers/tts/rumik').create(config);
  console.log('\n  voiceId     :', driver.voiceId);
  console.log('  description :', description || '(none — preset speaker only)');
  console.log('  text        :', LINE.slice(0, 60) + '…');

  const t0 = Date.now();
  let firstAt = 0;
  const res = await driver.synth({
    text: LINE,
    language: config.stt.language,
    sampleRate: 16000,
    onChunk: () => { if (!firstAt) firstAt = Date.now(); },
  });
  const total = Date.now() - t0;
  const first = firstAt ? firstAt - t0 : total;

  // PCM16 mono out of the driver, wrapped so it will just play.
  const pcm = res.audio;
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);

  const out = path.join(process.cwd(), 'audition-' + speaker + (description ? '-described' : '') + '.wav');
  fs.writeFileSync(out, wav);

  console.log('\n  FIRST AUDIO :', first + 'ms   <-- this is what the caller waits');
  console.log('  total       :', total + 'ms');
  console.log('  saved       :', out);
  if (first > 1500) {
    console.log('\n  Too slow for a live call. Every turn pays this before the first word.');
    console.log('  A preset speaker with no description measured 780-860ms in production.');
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
