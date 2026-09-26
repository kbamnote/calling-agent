/**
 * Terminal transport — type at the agent, read what it would say.
 *
 *   npm run chat                                    interactive
 *   printf 'haan\nrestaurant hai\n' | npm run chat  scripted
 *
 * No audio stack, no browser, no keys needed if LLM_PROVIDER=mock. This is where
 * conversation logic, tool wiring and the refusal paths get iterated on, because
 * the feedback loop is a keypress rather than a phone call.
 *
 * ── TWO MODES, DELIBERATELY ──────────────────────────────────────────────────
 * Interactive and piped stdin are different problems, and one readline interface
 * cannot serve both: piped input reaches EOF while turns are still in flight, and
 * readline's 'close' then races the conversation — dropping turns and, worse, the
 * outcome write. So a TTY gets readline, and a pipe is drained up front and
 * replayed one line at a time. Both drive the identical session object.
 */
const readline = require('readline');
const config = require('../config');
const { createSession } = require('../pipeline/conversation');
const providers = require('../providers');
const log = require('../util/log').make('text');

const C = {
  agent: '\x1b[36m', you: '\x1b[32m', tool: '\x1b[90m',
  warn: '\x1b[33m', dim: '\x1b[90m', reset: '\x1b[0m', bold: '\x1b[1m',
};

function banner() {
  config.warnings().forEach((w) => console.log(C.warn + '  ! ' + w + C.reset));
  console.log('');
  console.log(C.bold + '  Tapify AI Sales Agent — terminal mode' + C.reset);
  console.log(C.dim + '  llm=' + config.llm.provider + '  crm=' + (config.crm.enabled ? 'live' : 'stubs')
    + '  turn budget=' + config.limits.maxTurns + C.reset);
  console.log(C.dim + '  Type what the customer says. /quit to hang up, /cost for the ledger.' + C.reset);
  console.log('');
}

/** Shared session wiring for both modes. */
function build({ phone, direction, onEnd }) {
  return createSession({
    phone,
    direction,
    onAgentText: (text) => console.log('\n' + C.agent + '  AGENT  ' + C.reset + text + '\n'),
    onEvent: (type, data) => {
      if (type === 'tool') {
        const mark = data.result.ok ? '' : ' FAILED';
        console.log(C.tool + '  · ' + data.name + '(' + JSON.stringify(data.args).slice(0, 120) + ')'
          + mark + ' ' + data.ms + 'ms' + C.reset);
        if (!data.result.ok && data.result.error) {
          console.log(C.tool + '    -> ' + data.result.error + C.reset);
        }
      }
      if (type === 'engaged') console.log(C.dim + '  · AI session opened (connect gate passed)' + C.reset);
      if (type === 'interrupt') console.log(C.dim + '  · barge-in' + C.reset);
    },
    onEnd,
  });
}

function summarise(session, reason, disposition) {
  console.log('');
  console.log(C.bold + '  Call ended' + C.reset + C.dim + ' — ' + reason + C.reset);
  console.log('  disposition: ' + C.bold + disposition + C.reset);
  console.log(C.dim + '  ' + session.ledger.line() + C.reset);
  console.log('');
}

/**
 * Slash commands both modes share.
 * @returns true when the line was a command and needs no conversation turn.
 */
function command(said, session) {
  if (said === '/cost') {
    console.log(C.dim + '  ' + session.ledger.line() + C.reset);
    return true;
  }
  if (said === '/transcript') {
    session.transcript().forEach((t) => console.log(C.dim + '  ' + t.role.padEnd(9) + C.reset + t.text));
    return true;
  }
  return false;
}

/** Piped stdin: drain it all, then replay line by line. No race to lose. */
async function runScripted({ phone, direction }) {
  const input = await new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
  });

  let done = false;
  const session = build({
    phone,
    direction,
    onEnd: ({ reason, disposition }) => { done = true; summarise(session, reason, disposition); },
  });

  await session.start();

  for (const raw of input.split(/\r?\n/)) {
    const said = raw.trim();
    if (!said || done || session.ended) continue;
    if (said === '/quit' || said === '/q') { await session.end('user quit'); break; }
    if (command(said, session)) continue;

    console.log(C.you + '  YOU    ' + C.reset + said);
    await session.customerSaid(said);
  }

  // The script running out is not a hangup the agent chose — end it explicitly,
  // so the outcome is still written.
  if (!session.ended) await session.end('script finished');
}

/** A real terminal: readline, one turn at a time. */
async function runInteractive({ phone, direction }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let done = false;

  const session = build({
    phone,
    direction,
    onEnd: ({ reason, disposition }) => {
      done = true;
      summarise(session, reason, disposition);
      rl.close();
    },
  });

  const prompt = () => { if (!done) process.stdout.write(C.you + '  YOU    ' + C.reset); };

  rl.on('line', async (line) => {
    const said = line.trim();
    if (done) return;

    if (said === '/quit' || said === '/q') { await session.end('user quit'); return; }
    if (!said || command(said, session)) { prompt(); return; }

    rl.pause();
    try {
      await session.customerSaid(said);
    } catch (e) {
      log.error('turn failed:', e.stack || e.message);
    }
    if (!done) { rl.resume(); prompt(); }
  });

  rl.on('close', async () => {
    if (!done) {
      try { await session.end('input closed'); } catch (e) { /* already ending */ }
    }
  });

  await session.start();
  prompt();
}

async function run({ phone = '', direction = 'outbound' } = {}) {
  // A terminal cannot play audio, and asking a paid TTS vendor to synthesise into
  // nothing is a bill for nothing.
  process.env.TTS_PROVIDER = 'none';
  providers.reset();

  banner();

  if (process.stdin.isTTY) await runInteractive({ phone, direction });
  else await runScripted({ phone, direction });
}

module.exports = { run };
