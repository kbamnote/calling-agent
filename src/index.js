/**
 * Entry point. Picks a transport; everything else is shared.
 *
 *   node src/index.js --transport=text        terminal, no keys needed
 *   node src/index.js --transport=web         browser mic tester, no keys needed
 *   node src/index.js --transport=telephony   real calls (needs a provider)
 */
const config = require('./config');
const log = require('./util/log').make('boot');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
}

async function main() {
  const transport = arg('transport', 'web');

  log.info('Tapify voice agent starting — transport=' + transport + ' env=' + config.env);

  if (transport === 'text') {
    await require('./transport/text').run({
      phone: arg('phone', ''),
      direction: arg('direction', 'outbound'),
    });
    return;
  }
  if (transport === 'web') {
    require('./transport/web').run();
    return;
  }
  if (transport === 'telephony') {
    require('./transport/telephony').run();
    return;
  }

  console.error('Unknown transport "' + transport + '". Use text, web or telephony.');
  process.exit(1);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
