/**
 * Hear a voice, and find out what it costs in latency.
 *
 * "Confident" is a judgement nobody can make from a spec sheet, and the only
 * reason not to use a voice is the time it adds before the first word of every
 * turn. So this does both at once: writes a .wav you can play, and reports time
 * to first audio — the number the caller actually experiences.
 *
 *   npm run audition                      # whatever TTS_PROVIDER is set to
 *   npm run audition -- rumik
 *   npm run audition -- sarvam ritu
 *   npm run audition -- sarvam_stream priya
 *   npm run audition -- rumik zoya "a female 30s indian voice, confident, clear"
 *
 * Costs real money on every run — around 0.08 to 0.20 rupees.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const LINE = process.env.AUDITION_TEXT
  || 'Namaste Kunal ji! Main Tapify se bol rahi hoon, aapka feedback lena tha.'
  + ' Kya aapse do minute baat ho sakti hai?';

const DRIVERS = {
  rumik: '../providers/tts/rumik',
  sarvam: '../providers/tts/sarvam',
  sarvam_stream: '../providers/tts/sarvamStream',
  elevenlabs: '../providers/tts/elevenlabs',
};

/** PCM16 mono wrapped so it will simply play. */
function wav(pcm, rate) {
  const b = Buffer.alloc(44 + pcm.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length, 40);
  pcm.copy(b, 44);
  return b;
}

(async () => {
  const provider = (process.argv[2] || process.env.TTS_PROVIDER || 'rumik').toLowerCase();
  const voice = process.argv[3] || '';
  const description = process.argv[4] || '';

  if (!DRIVERS[provider]) {
    console.log('\nUnknown provider "' + provider + '". One of: ' + Object.keys(DRIVERS).join(', ') + '\n');
    process.exit(1);
  }

  // Set before the driver reads them — each takes its voice from a different place.
  if (voice) {
    process.env.TTS_VOICE = voice;              // sarvam, elevenlabs
    process.env.RUMIK_SPEAKER = voice;          // rumik mulberry
  }
  if (description) process.env.RUMIK_DESCRIPTION = description;
  delete require.cache[require.resolve('../config')];
  const config = require('../config');

  const driver = require(DRIVERS[provider]).create(config);
  console.log('\n  provider    :', driver.name);
  console.log('  voice       :', driver.voiceId || voice || '(driver default)');
  if (description) console.log('  description :', description);

  const SAMPLE_RATE = 16000;
  const t0 = Date.now();
  let firstAt = 0;
  let res;
  try {
    res = await driver.synth({
      text: LINE,
      language: config.stt.language,
      sampleRate: SAMPLE_RATE,
      onChunk: () => { if (!firstAt) firstAt = Date.now(); },
    });
  } catch (e) {
    console.log('\nFAILED  ' + e.message);
    console.log('        Check the API key for ' + provider + ', and that the voice name is one');
    console.log('        the current model version still accepts.\n');
    process.exit(1);
  }
  const total = Date.now() - t0;
  const first = firstAt ? firstAt - t0 : total;

  const name = 'audition-' + provider + (voice ? '-' + voice : '') + (description ? '-described' : '') + '.wav';
  const out = path.join(process.cwd(), name);
  fs.writeFileSync(out, wav(res.audio, res.sampleRate || SAMPLE_RATE));

  console.log('\n  FIRST AUDIO :', first + 'ms   <-- what the caller waits, every turn');
  console.log('  total       :', total + 'ms');
  console.log('  audio       :', (res.audio.length / (SAMPLE_RATE * 2)).toFixed(1) + 's at '
    + (res.sampleRate || SAMPLE_RATE) + 'Hz');
  console.log('  saved       :', out);
  if (first > 1500) {
    console.log('\n  Slow. Rumik mulberry measured 780-860ms in production, and every turn');
    console.log('  pays this before the first word.');
  }
  console.log('');
})().catch((e) => { console.error('\nFAILED:', e.message, '\n'); process.exit(1); });
