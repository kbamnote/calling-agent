/**
 * The deployable server: browser tester AND the phone line, one process.
 *
 *   npm run web     ->   http://localhost:5010
 *   npm start       ->   same thing, what a deploy runs
 *
 * ── WHY ONE SERVER ───────────────────────────────────────────────────────────
 * A telephony provider needs a long-lived wss connection for media. That rules
 * out putting this behind the Vercel proxy the CRM uses — Vercel's serverless
 * functions cannot hold a websocket open. So this runs as one always-on service
 * with its own domain, serving:
 *
 *   GET  /                    the tester page (gated in production)
 *   GET  /health              for the platform's health check
 *   GET  /config              what the tester is talking to
 *   ws   /call                the browser tester's conversation socket
 *   ws   /media               the telephony media stream   (when configured)
 *   POST /telephony/status    the provider's status callback (when configured)
 *
 * Both websockets are `noServer` and routed by hand in one 'upgrade' handler.
 * Attaching two WebSocketServers with `path` to the same http server races —
 * whichever fires first destroys the socket the other wanted.
 *
 * ── THE TESTER COSTS MONEY ───────────────────────────────────────────────────
 * Every visit that starts a call spends LLM and TTS budget. Deployed publicly and
 * unguarded, that is someone else's bill to run up. So in production the tester
 * requires TESTER_TOKEN and is disabled without it. The phone line is unaffected.
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('../config');
const providers = require('../providers');
const { createSession } = require('../pipeline/conversation');
const telephony = require('./telephony');
const log = require('../util/log').make('web');

/**
 * Tester access.
 *   token set          -> must match
 *   no token, dev      -> open (localhost convenience)
 *   no token, prod     -> disabled, with an explanation
 * A low-value gate on a dev tool, not an auth system: it stops a stray visitor
 * or a crawler from starting calls, nothing more.
 */
function testerGate() {
  const token = config.testerToken;
  const isProd = config.env === 'production';

  return (req, res, next) => {
    if (!token) {
      if (!isProd) return next();
      return res.status(403).type('text/plain').send(
        'The browser tester is disabled in production because starting a call spends LLM and TTS budget.\n\n'
        + 'Set TESTER_TOKEN in the environment, then open this page as  /?t=<token>\n\n'
        + 'The phone line (/media) is unaffected by this.\n',
      );
    }
    const given = req.query.t || req.headers['x-tester-token'];
    if (given === token) return next();
    return res.status(401).type('text/plain').send('Add ?t=<TESTER_TOKEN> to the URL.\n');
  };
}

function run() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Unauthenticated on purpose: the platform's health check has no token, and it
  // reveals nothing a port scan would not.
  app.get('/health', (req, res) => res.json({
    ok: true,
    ts: new Date(),
    llm: config.llm.provider,
    telephony: telephony.enabled() ? config.telephony.provider : 'none',
    crm: config.crm.enabled ? 'live' : 'stubs',
  }));

  // MOUNTED BEFORE THE TESTER GATE, deliberately. The gate below is a catch-all
  // `app.use`, so anything registered after it inherits the token check — and a
  // provider webhook that gets a 401 is a phone call that fails to connect.
  // These are specific paths, so Express matches them here and never reaches the
  // catch-all.
  if (telephony.enabled()) {
    // Fails at boot rather than mid-call if the speech drivers cannot work on a
    // phone line.
    telephony.assertReady();
    telephony.mountHttp(app);
  }

  const gate = testerGate();

  /** Lets the tester page show what it is actually talking to. */
  app.get('/config', gate, (req, res) => {
    res.json({
      llm: config.llm.provider,
      llmModel: config.llm.model || '(default)',
      stt: config.stt.provider,
      tts: config.tts.provider,
      language: config.stt.language,
      crm: config.crm.enabled ? 'live' : 'stubs',
      maxTurns: config.limits.maxTurns,
      maxCallSeconds: config.limits.maxCallSeconds,
      greetingGate: config.limits.greetingGate,
      warnings: config.warnings(),
      available: providers.available,
    });
  });

  app.get('/', gate, (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html')));
  // Static assets sit behind the gate too, so the page is not half-servable.
  app.use(gate, express.static(path.join(__dirname, '..', '..', 'public')));

  const server = http.createServer(app);

  // ── websockets ───────────────────────────────────────────────────────────
  const callWss = new WebSocketServer({ noServer: true });
  const mediaWss = telephony.enabled() ? new WebSocketServer({ noServer: true }) : null;

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = ''; }

    if (pathname === '/call') {
      // The tester socket is gated the same way the page is — otherwise the token
      // on the page is decoration.
      const token = config.testerToken;
      if (token) {
        const given = new URL(req.url, 'http://localhost').searchParams.get('t');
        if (given !== token) { socket.destroy(); return; }
      } else if (config.env === 'production') {
        socket.destroy();
        return;
      }
      callWss.handleUpgrade(req, socket, head, (ws) => callWss.emit('connection', ws, req));
      return;
    }

    if (mediaWss && pathname === '/media') {
      mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit('connection', ws, req));
      return;
    }

    socket.destroy();
  });

  if (mediaWss) mediaWss.on('connection', telephony.handleMedia);

  callWss.on('connection', (ws) => {
    let session = null;
    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      try {
        if (msg.type === 'start') {
          if (session) return;
          session = createSession({
            phone: msg.phone || '',
            direction: msg.direction || 'outbound',
            campaignId: msg.campaignId,
            onAgentText: (text) => send({ type: 'say', text }),
            // Server-side TTS audio, when a real vendor is configured. The page
            // plays it instead of using the Web Speech API.
            onAgentAudio: (buf, mime) => send({ type: 'audio', mime, b64: buf.toString('base64') }),
            onEvent: (event, data) => send({ type: 'event', event, data }),
            onEnd: (summary) => send({ type: 'ended', ...summary }),
            hangup: () => { try { ws.close(); } catch (e) { /* gone */ } },
          });
          await session.start();
          return;
        }

        if (!session) return;

        if (msg.type === 'said') await session.customerSaid(msg.text);
        else if (msg.type === 'interrupt') session.interrupt();
        else if (msg.type === 'hangup') await session.end('customer hung up');
      } catch (e) {
        log.error('websocket handler failed:', e.stack || e.message);
        send({ type: 'error', error: e.message });
      }
    });

    ws.on('close', () => {
      // A closed tab is a dropped call: end the session so the outcome is still
      // recorded rather than the call leaking.
      if (session && !session.ended) session.end('websocket closed').catch(() => {});
    });
  });

  // 0.0.0.0 because a container's health check and router reach it from outside.
  server.listen(config.port, '0.0.0.0', () => {
    log.info('listening on :' + config.port);
    log.info('  tester   GET /' + (config.testerToken ? '?t=<TESTER_TOKEN>' : '')
      + (!config.testerToken && config.env === 'production' ? '  (DISABLED — set TESTER_TOKEN)' : ''));
    log.info('  health   GET /health');
    if (telephony.enabled()) {
      log.info('  media    ws  /media           (provider: ' + config.telephony.provider + ')');
      log.info('  status   POST /telephony/status');
      log.warn('the telephony transport has never run against a live line — verify frame format and sample rate with your provider');
    } else {
      log.info('  media    disabled (TELEPHONY_PROVIDER=none)');
    }
    config.warnings().forEach((w) => log.warn(w));
  });

  // Containers stop with SIGTERM. Closing cleanly lets in-flight calls finish
  // their outcome write instead of being killed mid-sentence.
  const shutdown = (sig) => {
    log.info(sig + ' received — closing');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

module.exports = { run };
