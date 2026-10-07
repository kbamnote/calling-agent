/**
 * Puts a finished call recording somewhere it can be played from.
 *
 * Cloudinary, on its own account — not the one serving product images. Call
 * recordings are personal data with a retention clock on them, and the day
 * somebody wants every recording older than ninety days deleted, that has to be
 * a thing you can do without touching anything a customer's website depends on.
 *
 * Audio goes under resource_type `video`; Cloudinary has no separate audio type.
 */
const crypto = require('crypto');
const log = require('../util/log').make('rec');

const CLOUD = process.env.RECORDING_CLOUDINARY_CLOUD_NAME || '';
const KEY = process.env.RECORDING_CLOUDINARY_API_KEY || '';
const SECRET = process.env.RECORDING_CLOUDINARY_API_SECRET || '';
const PRESET = process.env.RECORDING_CLOUDINARY_UPLOAD_PRESET || '';
const FOLDER = process.env.RECORDING_CLOUDINARY_FOLDER || 'tapify-ai-calls';

function configured() {
  return Boolean(CLOUD && ((KEY && SECRET) || PRESET));
}

/**
 * Cloudinary's signature: every signed parameter except file/api_key, sorted,
 * joined as a query string, with the secret appended, SHA-1'd.
 */
function sign(params) {
  const base = Object.keys(params).sort().map((k) => k + '=' + params[k]).join('&');
  return crypto.createHash('sha1').update(base + SECRET).digest('hex');
}

/**
 * @param {Buffer} mp3
 * @param {string} callId   becomes the public_id, so a recording can be found
 *                          from a call log row without a lookup table
 * @returns {Promise<string|null>} the playable URL, or null if not configured
 */
async function upload(mp3, callId) {
  if (!configured()) return null;
  if (!mp3 || !mp3.length) return null;

  const form = new URLSearchParams();
  form.append('file', 'data:audio/mpeg;base64,' + mp3.toString('base64'));

  if (KEY && SECRET) {
    const params = {
      folder: FOLDER,
      public_id: String(callId || Date.now()),
      timestamp: Math.floor(Date.now() / 1000),
    };
    for (const [k, v] of Object.entries(params)) form.append(k, String(v));
    form.append('api_key', KEY);
    form.append('signature', sign(params));
  } else {
    // Unsigned works, but anyone who learns the preset name can upload to the
    // account. Fine for a trial, not for a recording archive.
    form.append('upload_preset', PRESET);
    form.append('folder', FOLDER);
    form.append('public_id', String(callId || Date.now()));
  }

  const res = await fetch('https://api.cloudinary.com/v1_1/' + CLOUD + '/video/upload', {
    method: 'POST',
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.secure_url) {
    throw new Error((data && data.error && data.error.message) || 'Cloudinary HTTP ' + res.status);
  }
  log.info('uploaded ' + Math.round(mp3.length / 1024) + ' KB for call ' + callId);
  return data.secure_url;
}

module.exports = { upload, configured, FOLDER };
