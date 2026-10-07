/**
 * Does the recordings Cloudinary account actually accept an upload?
 *
 * Runs the SAME code path a finished call uses — encode, sign, POST — so a pass
 * here means recordings will store, and a failure names which of the three
 * things is wrong rather than leaving you to infer it from a call that already
 * hung up.
 *
 *   node src/scripts/testRecordingUpload.js
 */
require('dotenv').config();
const recorder = require('../telephony/recorder');
const store = require('../telephony/recordingStore');

const mask = (v) => (v ? v.slice(0, 4) + '…' + v.slice(-4) + ' (' + v.length + ' chars)' : '(not set)');

(async () => {
  console.log('\nRecordings Cloudinary account');
  console.log('  cloud name :', process.env.RECORDING_CLOUDINARY_CLOUD_NAME || '(not set)');
  console.log('  api key    :', mask(process.env.RECORDING_CLOUDINARY_API_KEY));
  console.log('  api secret :', mask(process.env.RECORDING_CLOUDINARY_API_SECRET));
  console.log('  preset     :', process.env.RECORDING_CLOUDINARY_UPLOAD_PRESET || '(not set)');
  console.log('  folder     :', store.FOLDER);
  console.log('  mode       :', process.env.RECORDING_CLOUDINARY_API_KEY && process.env.RECORDING_CLOUDINARY_API_SECRET
    ? 'SIGNED' : (process.env.RECORDING_CLOUDINARY_UPLOAD_PRESET ? 'unsigned preset' : 'none'));

  if (!store.configured()) {
    console.log('\nFAIL  Not configured. Set the cloud name plus EITHER the key and secret, OR a preset.');
    process.exit(1);
  }

  // A real two-second recording, through the real encoder.
  const sr = 16000;
  const tape = recorder.create({ callId: 'upload-test', sampleRate: sr });
  const tone = (hz, ms) => {
    const n = (sr * ms) / 1000;
    const b = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * hz * i) / sr)), i * 2);
    return b;
  };
  tape.customer(tone(300, 500));
  await new Promise((r) => setTimeout(r, 700));
  tape.agent(tone(600, 500));
  await new Promise((r) => setTimeout(r, 700));
  tape.customer(tone(300, 300));

  const mp3 = await tape.finish();
  if (!mp3) { console.log('\nFAIL  The encoder produced nothing.'); process.exit(1); }
  console.log('\n  encoded    :', Math.round(mp3.length / 1024), 'KB');

  try {
    const url = await store.upload(mp3, 'upload-test-' + Date.now());
    console.log('\nPASS  Uploaded. Recordings will store.');
    console.log('      ' + url + '\n');
  } catch (e) {
    console.log('\nFAIL  Cloudinary refused it:\n      ' + e.message + '\n');
    if (/missing permissions|forbidden/i.test(e.message)) {
      console.log('      That is authorisation, not authentication — the credentials were accepted');
      console.log('      and then refused. Either the API key is scoped without asset-create rights,');
      console.log('      or it belongs to a different product environment than the cloud name.\n');
    } else if (/signature/i.test(e.message)) {
      console.log('      A signature problem, so the secret is wrong or has whitespace around it.\n');
    } else if (/preset/i.test(e.message)) {
      console.log('      The preset name is wrong, or it is not set to UNSIGNED in Cloudinary.\n');
    }
    process.exit(1);
  }
})().catch((e) => { console.error('\nFAIL ', e.message, '\n'); process.exit(1); });
