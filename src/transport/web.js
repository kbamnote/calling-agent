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
const dialer = require('../telephony/dialer');
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
  // Set below, after the speech drivers are checked. Read inside request
  // handlers, which only run once startup has finished.
  let telephonyLive = false;
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Unauthenticated on purpose: the platform's health check has no token, and it
  // reveals nothing a port scan would not.
  app.get('/health', (req, res) => res.json({
    ok: true,
    ts: new Date(),
    llm: config.llm.provider,
    telephony: telephonyLive ? config.telephony.provider : 'none',
    outbound: dialer.isConfigured() ? 'ready' : 'not configured',
    crm: config.crm.enabled ? 'live' : 'stubs',
  }));

  // MOUNTED BEFORE THE TESTER GATE, deliberately. The gate below is a catch-all
  // `app.use`, so anything registered after it inherits the token check — and a
  // provider webhook that gets a 401 is a phone call that fails to connect.
  // These are specific paths, so Express matches them here and never reaches the
  // catch-all.
  if (telephony.enabled()) {
    try {
      // Checked here rather than on the first call, so a misconfiguration is
      // visible in the deploy log instead of mid-conversation with a customer.
      telephony.assertReady();
      telephony.mountHttp(app);
      telephonyLive = true;
    } catch (e) {
      // Loud, but NOT fatal. Killing the process would take the health check and
      // the tester down with it and leave the platform restart-looping — a
      // telephony misconfiguration should disable telephony, not the service.
      log.error('TELEPHONY DISABLED — ' + e.message);
    }
  }

  // Without this, a request to /telephony/* while telephony is off falls through
  // to the tester gate and answers "add ?t=<TESTER_TOKEN>", which sends whoever
  // is debugging a dead phone line off in entirely the wrong direction.
  app.all('/telephony/*', (req, res) => res.status(503).type('text/plain').send(
    'Telephony is not active on this deployment.\n\n'
    + 'TELEPHONY_PROVIDER=' + (config.telephony.provider || 'none')
    + '  STT_PROVIDER=' + config.stt.provider
    + '  TTS_PROVIDER=' + config.tts.provider + '\n\n'
    + 'Set TELEPHONY_PROVIDER=plivo and server-side speech drivers '
    + '(STT_PROVIDER=sarvam, TTS_PROVIDER=sarvam), then redeploy.\n',
  ));

  /**
   * Outbound calling.
   *
   * Guarded by the SAME service key the CRM uses, never the tester token: these
   * endpoints place real calls to real customers and cost real money. A tester
   * token is a convenience gate on a dev page; this needs the shared secret.
   */
  const requireServiceKey = (req, res, next) => {
    const expected = config.crm.serviceKey;
    if (!expected) return res.status(503).json({ error: 'AGENT_SERVICE_KEY is not set — outbound calling is disabled' });
    if (req.headers['x-service-key'] !== expected) return res.status(401).json({ error: 'Bad service key' });
    next();
  };

  /** POST /calls/outbound  { phone, campaign?, name?, force?, tapifyUserId? } — one call. */
  app.post('/calls/outbound', requireServiceKey, async (req, res) => {
    if (!telephonyLive) return res.status(503).json({ error: 'Telephony is not active on this deployment' });
    try {
      const r = await dialer.placeCall({
        phone: req.body.phone,
        name: req.body.name,
        campaign: req.body.campaign || 'sales',
        force: Boolean(req.body.force),
        clientId: req.body.tapifyUserId,
        publicUrl: telephony.publicOrigin(req),
      });
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) {
      log.error('outbound dial failed:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * POST /calls/campaign  { campaign, limit?, health?, appInstalled?, gapMs?, dryRun? }
   *
   * Pulls the call list from the CRM and works it. Returns immediately with the
   * list — the calls then run in the background, spaced out — because a campaign
   * takes minutes and nothing useful can be said in an HTTP response that waits
   * for it.
   *
   * dryRun returns exactly who WOULD be called and dials nobody. Use it first,
   * every time: this is the one endpoint in the service that can annoy every
   * customer you have.
   */
  app.post('/calls/campaign', requireServiceKey, async (req, res) => {
    if (!telephonyLive) return res.status(503).json({ error: 'Telephony is not active on this deployment' });
    if (!config.crm.enabled) return res.status(400).json({ error: 'CRM_ENABLED=false — there is no client list to call' });

    const campaign = req.body.campaign || 'client_feedback';
    // A deliberately small ceiling. Raising it is a decision someone should make
    // on purpose, not something a typo in a request body can do.
    const limit = Math.min(Number(req.body.limit) || 10, Number(process.env.CAMPAIGN_MAX || 50));

    try {
      const qs = new URLSearchParams({ campaign, limit: String(limit) });
      if (req.body.health) qs.set('health', req.body.health);
      if (req.body.appInstalled === false) qs.set('appInstalled', 'false');
      if (req.body.quietDays) qs.set('quietDays', String(req.body.quietDays));

      const listRes = await fetch(config.crm.baseUrl + '/api/agent/campaign/clients?' + qs.toString(), {
        headers: { 'X-Service-Key': config.crm.serviceKey },
      });
      if (!listRes.ok) throw new Error('CRM returned HTTP ' + listRes.status);
      const { clients = [], total = 0 } = await listRes.json();

      const targets = clients.map((c) => ({ phone: c.phone, name: c.name }));

      if (req.body.dryRun) {
        return res.json({
          ok: true,
          dryRun: true,
          campaign,
          wouldCall: clients.length,
          matching: total,
          withinCallingHours: dialer.withinCallingHours(),
          clients: clients.map((c) => ({
            name: c.name, phone: c.phone, health: c.health,
            appInstalled: c.appInstalled, reasons: c.reasons,
          })),
        });
      }

      if (!dialer.withinCallingHours()) {
        return res.status(409).json({
          ok: false,
          error: 'Outside calling hours (' + dialer.CALL_START_HOUR + ':00-' + dialer.CALL_END_HOUR + ':00 IST)',
          istHour: dialer.istHour(),
        });
      }

      const publicUrl = telephony.publicOrigin(req);
      // Fire and forget: the response is the plan, the log is the progress.
      dialer.runCampaign({
        targets,
        campaign,
        publicUrl,
        gapMs: req.body.gapMs,
        onProgress: (p) => log.info('campaign ' + p.index + '/' + p.total + ' ' + p.phone
          + ' -> ' + (p.result.ok ? 'dialled' : 'skipped: ' + p.result.reason)),
      }).catch((e) => log.error('campaign failed:', e.message));

      res.json({ ok: true, campaign, started: targets.length, matching: total });
    } catch (e) {
      log.error('campaign failed to start:', e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  const gate = testerGate();

  /** Lets the tester page show what it is actually talking to. */
  app.get('/config', gate, (req, res) => {
    res.json({
      llm: config.llm.provider,
      llmModel: config.llm.model || '(default)',
      // Whether replies are streamed and synthesised a sentence at a time. Worth
      // surfacing: it is the difference between a ~2s and a ~3s reply, and if a
      // vendor quietly stops supporting it, this is where that shows.
      llmStreaming: config.llm.streaming && Boolean(providers.get().llm.supportsStreaming),
      stt: config.stt.provider,
      sttStreaming: Boolean(providers.get().stt.supportsPartials),
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

  /**
   * GET /diagnostics — `npm run doctor`, but from inside the deployment.
   *
   * The keys live on the platform, not on anyone's laptop, so "does this
   * credential actually work?" cannot be answered locally. This makes ONE real
   * request to each configured vendor and reports what came back. Finding a bad
   * key here costs a page refresh; finding it on a live call costs a customer.
   *
   * Gated with the tester token: it spends (a trivial amount of) vendor budget,
   * and the failure messages name provider internals.
   */
  app.get('/diagnostics', gate, async (req, res) => {
    const t = providers.get();
    const out = {
      env: config.env,
      config: {
        llm: config.llm.provider + (config.llm.model ? ' (' + config.llm.model + ')' : ''),
        stt: config.stt.provider,
        tts: config.tts.provider,
        language: config.stt.language,
        telephony: telephonyLive ? config.telephony.provider : 'none',
    outbound: dialer.isConfigured() ? 'ready' : 'not configured',
        crm: config.crm.enabled ? config.crm.baseUrl : 'stubs',
      },
      checks: {},
      warnings: config.warnings(),
    };
    const time = async (fn) => {
      const t0 = Date.now();
      try {
        const detail = await fn();
        return { ok: true, ms: Date.now() - t0, detail };
      } catch (e) {
        return { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 300) };
      }
    };

    out.checks.llm = config.llm.provider === 'mock'
      ? { ok: true, detail: 'mock — no key needed, scripted replies only' }
      : await time(async () => {
        // A generous budget on purpose: reasoning models spend output tokens
        // thinking before they write anything, so a tight cap makes a healthy
        // model look like it returns nothing.
        const r = await t.llm.chat({
          system: 'Reply with exactly the word: ready',
          messages: [{ role: 'user', content: 'ping' }],
          tools: [],
          maxTokens: Math.max(256, config.llm.maxTokens),
        });
        const meta = '(' + r.usage.in + ' in / ' + r.usage.out + ' out'
          + (r.finishReason ? ', finish=' + r.finishReason : '') + ')';
        if (!r.text) {
          // Reported as a FAILURE. An LLM that returns no text is dead air on a
          // live call, which is worse than an outright error because it looks
          // like the line dropped.
          throw new Error('connected but returned NO TEXT ' + meta
            + ' — the model likely spent the whole budget reasoning; raise LLM_MAX_TOKENS or change LLM_MODEL');
        }
        return 'replied "' + r.text.slice(0, 40) + '" ' + meta;
      });

    out.checks.tts = (t.tts.clientSide || t.tts.textOnly)
      ? { ok: true, detail: t.tts.name + ' — client-side, nothing to verify' }
      : await time(async () => {
        // Synthesise at the rate REAL CALLS will use, not a default. Testing
        // 8 kHz while the phone line runs at 16 kHz proves nothing about the
        // path that actually matters.
        const rate = telephonyLive
          ? (telephony.CODECS[config.telephony.provider] || telephony.CODECS.generic).sampleRate
          : 8000;
        // Exercised the way a CALL exercises it. Without an onChunk callback a
        // streaming driver quietly falls back to its batch path, so the number
        // reported here would be the one thing nobody is waiting on — and the
        // streaming path, and any resampling it does per chunk, would stay
        // unverified until a customer heard it.
        const started = Date.now();
        let firstChunkMs = null;
        let chunks = 0;
        const r = await t.tts.synth({
          text: 'Namaste, Tapify se baat kar rahe hain.',
          language: config.stt.language,
          sampleRate: rate,
          onChunk: (part) => {
            chunks += 1;
            if (firstChunkMs === null && part && part.audio && part.audio.length) {
              firstChunkMs = Date.now() - started;
            }
          },
        });
        if (!r.audio || !r.audio.length) throw new Error('returned no audio');
        if (r.sampleRate && r.sampleRate !== rate) {
          throw new Error('asked for ' + rate + 'Hz but got ' + r.sampleRate
            + 'Hz — the voice would play at the wrong speed');
        }
        // A WAV header here means the container is reaching the wire, which is
        // heard as a click then silence.
        const looksLikeWav = r.audio.length > 4 && r.audio.toString('ascii', 0, 4) === 'RIFF';
        if (looksLikeWav) throw new Error('driver returned a WAV container, not raw PCM');
        // First audio is the number that decides how a turn feels; total is
        // only what it costs. Reporting one without the other is how a driver
        // looks slow when it is fast, and fast when it is slow.
        const how = firstChunkMs === null
          ? 'not streamed — the whole utterance arrived at once'
          : 'first audio in ' + firstChunkMs + 'ms across ' + chunks + ' chunks';
        return r.audio.length + ' bytes of raw PCM @ ' + rate + 'Hz, ' + how;
      });

    /**
     * STT, exercised for real by speaking a phrase through TTS and transcribing
     * it back.
     *
     * "Needs real audio, proven on the first call" was a cop-out: a deprecated
     * STT model is a 400 on every utterance, and the call still looks healthy —
     * audio flows, the VAD fires, and the agent simply never hears anything. It
     * cost a live call to find. Now it is a round trip.
     *
     * Only whether a transcript comes back matters, not what it says: TTS and
     * STT are different models and the words will not match exactly.
     */
    out.checks.stt = t.stt.clientSide
      ? { ok: true, detail: t.stt.name + ' — client-side, cannot serve a phone line' }
      : await time(async () => {
        if (out.checks.tts.ok !== true) throw new Error('skipped — TTS must work first to produce test audio');
        const rate = telephonyLive
          ? (telephony.CODECS[config.telephony.provider] || telephony.CODECS.generic).sampleRate
          : 8000;
        const spoken = await t.tts.synth({ text: 'Namaste, aap kaise hain?', language: config.stt.language, sampleRate: rate });

        const transcript = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('no transcript within 20s')), 20000);
          let stream;
          try {
            stream = t.stt.createStream({
              language: config.stt.language,
              sampleRate: rate,
              onFinal: (text) => { clearTimeout(timer); resolve(text); },
              onError: (e) => { clearTimeout(timer); reject(e); },
            });
          } catch (e) { clearTimeout(timer); reject(e); return; }
          stream.write(spoken.audio);
          Promise.resolve(stream.end()).catch((e) => { clearTimeout(timer); reject(e); });
        });

        if (!transcript || !transcript.trim()) throw new Error('returned an empty transcript');
        return 'round trip ok — heard "' + transcript.slice(0, 60) + '"';
      });

    out.checks.crm = config.crm.enabled
      ? await time(async () => {
        const r = await fetch(config.crm.baseUrl + '/api/health');
        if (!r.ok) throw new Error('returned HTTP ' + r.status);
        return 'reachable' + (config.crm.serviceKey ? '' : ' — but AGENT_SERVICE_KEY is EMPTY, every tool call will be rejected');
      })
      : { ok: true, detail: 'disabled — tools answer from stubs with FAKE prices' };

    out.checks.telephony = telephonyLive
      ? { ok: true, detail: config.telephony.provider + ' — answer=/telephony/answer, media=ws /media' }
      : { ok: false, detail: 'not active. TELEPHONY_PROVIDER=' + (config.telephony.provider || 'none') };

    /**
     * Can the agent actually SELL anything?
     *
     * The catalogue ships priceless and inactive on purpose — prices come from
     * management, and the pricing engine refuses rather than inventing one. The
     * visible symptom is an agent that answers every product question with "let
     * me connect you to a senior", which reads as a broken bot rather than an
     * empty catalogue. So say it plainly here.
     */
    out.checks.outbound = dialer.isConfigured()
      ? await time(() => dialer.checkCredentials())
      : { ok: null, detail: 'not configured — inbound still works. Set PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN and PLIVO_FROM_NUMBER to place calls.' };

    out.checks.catalog = config.crm.enabled
      ? await time(async () => {
        const r = await fetch(config.crm.baseUrl + '/api/agent/catalog', {
          headers: { 'X-Service-Key': config.crm.serviceKey },
        });
        if (!r.ok) throw new Error('catalog request returned HTTP ' + r.status);
        const body = await r.json();
        const items = body.items || [];
        if (!items.length) {
          throw new Error('NO sellable items — the agent will escalate every product question. '
            + 'Run "npm run seed:catalog" in salescrm-pro/backend, enter prices, then set active + aiSellable. '
            + 'GET /api/catalog/unpriced lists what is missing.');
        }
        const quotable = items.filter((i) => i.quotable).length;
        return items.length + ' item(s) the agent can discuss, ' + quotable + ' it may quote: '
          + items.slice(0, 6).map((i) => i.code).join(', ');
      })
      : { ok: true, detail: 'CRM disabled — stub catalogue with FAKE prices' };

    const failed = Object.values(out.checks).some((c) => c.ok === false);
    res.status(failed ? 503 : 200).json(out);
  });

  app.get('/', gate, (req, res) => res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html')));
  // Static assets sit behind the gate too, so the page is not half-servable.
  app.use(gate, express.static(path.join(__dirname, '..', '..', 'public')));

  const server = http.createServer(app);

  // ── websockets ───────────────────────────────────────────────────────────
  const callWss = new WebSocketServer({ noServer: true });
  const mediaWss = telephonyLive ? new WebSocketServer({ noServer: true }) : null;

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

  // Pre-synthesise the lines spoken on EVERY call. Without this the first caller
  // after each deploy waits ~2s for Sarvam before hearing anything — which on a
  // phone line reads as a dead connection. Cached on disk, so it costs one
  // synthesis per deploy, not one per call.
  if (telephonyLive) {
    const persona = require('../pipeline/persona');
    const ttsCache = require('../pipeline/ttsCache');
    const rate = (telephony.CODECS[config.telephony.provider] || telephony.CODECS.generic).sampleRate;
    ttsCache.warm(
      ttsCache.wrap(providers.get().tts),
      [
        persona.greetingText({ direction: 'inbound' }),
        persona.greetingText({ direction: 'outbound' }),
        // The feedback persona has its own wording. Without these two, every
        // feedback call paid a live synthesis before its first word. A call that
        // knows the customer's name still misses — that one is pre-rendered
        // while the phone rings, in telephony/dialer.js.
        persona.greetingText({ direction: 'inbound', campaign: 'client_feedback' }),
        persona.greetingText({ direction: 'outbound', campaign: 'client_feedback' }),
        persona.thinkingText(),
        persona.priceUnavailableText(),
        persona.handoffText(),
        // Spoken when the model is rate-limited. It has to be instant — the
        // whole point is to cover a gap, not to add one.
        persona.busyLineText(),
        // Spoken on EVERY call that ends properly, and it was the only fixed
        // line nobody had cached — 2722ms of live synthesis measured while a
        // caller waited to be let off the phone.
        persona.closingText(),
      ],
      { language: config.stt.language, sampleRate: rate },
    ).catch((e) => log.warn('TTS warm-up failed (calls still work, just slower):', e.message));
  }

  // 0.0.0.0 because a container's health check and router reach it from outside.
  server.listen(config.port, '0.0.0.0', () => {
    log.info('listening on :' + config.port);
    log.info('  tester   GET /' + (config.testerToken ? '?t=<TESTER_TOKEN>' : '')
      + (!config.testerToken && config.env === 'production' ? '  (DISABLED — set TESTER_TOKEN)' : ''));
    log.info('  health   GET /health');
    if (telephonyLive) {
      log.info('  media    ws  /media           (provider: ' + config.telephony.provider + ')');
      log.info('  status   POST /telephony/status');
      log.info('  dial     POST /calls/outbound  |  POST /calls/campaign   (X-Service-Key)'
        + (dialer.isConfigured() ? '' : '  [PLIVO_* not set — outbound disabled]'));
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
