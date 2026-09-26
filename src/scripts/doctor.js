/**
 * Pre-flight check.
 *
 *   npm run doctor
 *
 * Says what is configured, what is missing, and — for anything with a key — makes
 * one real call to prove the credential works. Cheaper to find a bad key here
 * than three seconds into a customer conversation.
 */
const config = require('../config');
const providers = require('../providers');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[90m', X = '\x1b[0m', B = '\x1b[1m';
const ok = (m) => console.log('  ' + G + 'ok  ' + X + m);
const bad = (m) => console.log('  ' + R + 'FAIL' + X + ' ' + m);
const warn = (m) => console.log('  ' + Y + 'warn' + X + ' ' + m);
const info = (m) => console.log('  ' + D + '    ' + m + X);

async function main() {
  console.log('\n' + B + '  Tapify voice agent — doctor' + X + '\n');

  console.log(B + '  Config' + X);
  info('llm      ' + config.llm.provider + (config.llm.model ? ' (' + config.llm.model + ')' : ''));
  info('stt      ' + config.stt.provider);
  info('tts      ' + config.tts.provider);
  info('crm      ' + (config.crm.enabled ? config.crm.baseUrl : 'disabled (stubs)'));
  info('budget   ' + config.limits.maxTurns + ' turns / ' + config.limits.maxCallSeconds + 's');
  info('gate     greeting gate ' + (config.limits.greetingGate ? 'ON' : 'OFF'));
  console.log('');

  const warnings = config.warnings();
  if (warnings.length) {
    console.log(B + '  Warnings' + X);
    warnings.forEach(warn);
    console.log('');
  }

  console.log(B + '  Live checks' + X);
  const { llm } = providers.get();

  if (config.llm.provider === 'mock') {
    ok('llm: mock needs no key');
  } else {
    try {
      const r = await llm.chat({
        system: 'Reply with exactly the word: ready',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [],
        maxTokens: 10,
      });
      ok('llm: ' + llm.name + ' replied "' + (r.text || '').slice(0, 30) + '" (' + r.usage.in + ' in / ' + r.usage.out + ' out)');
    } catch (e) {
      bad('llm: ' + e.message);
    }
  }

  if (config.stt.provider === 'browser') ok('stt: browser (client-side, no key)');
  else if (config.stt.provider === 'deepgram' && !config.stt.deepgramKey) bad('stt: DEEPGRAM_API_KEY missing');
  else if (config.stt.provider === 'sarvam' && !config.stt.sarvamKey) bad('stt: SARVAM_API_KEY missing');
  else warn('stt: ' + config.stt.provider + ' key present but never exercised against a live call — verify with the web tester');

  if (config.tts.provider === 'browser' || config.tts.provider === 'none') {
    ok('tts: ' + config.tts.provider + ' (no key)');
  } else {
    const { tts } = providers.get();
    try {
      const r = await tts.synth({ text: 'Namaste, Tapify se baat kar rahe hain.', language: config.stt.language });
      ok('tts: ' + tts.name + ' returned ' + (r.audio ? r.audio.length + ' bytes' : 'no audio'));
    } catch (e) {
      bad('tts: ' + e.message);
    }
  }

  if (!config.crm.enabled) {
    warn('crm: disabled — tools answer from in-memory stubs with FAKE prices');
  } else {
    try {
      const res = await fetch(config.crm.baseUrl + '/api/health');
      if (res.ok) ok('crm: reachable at ' + config.crm.baseUrl);
      else bad('crm: ' + config.crm.baseUrl + ' returned ' + res.status);
    } catch (e) {
      bad('crm: ' + e.message);
    }
    if (!config.crm.serviceKey) bad('crm: AGENT_SERVICE_KEY is empty — every tool call will be rejected');
  }

  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
