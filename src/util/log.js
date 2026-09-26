/**
 * Tiny levelled logger with a call-scoped prefix.
 *
 * Voice debugging is chronological — you read a transcript, not a tree — so
 * output stays single-line and prefixed with the call id.
 */
const config = require('../config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] !== undefined ? LEVELS[config.logLevel] : LEVELS.info;

const COLOR = {
  error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m', reset: '\x1b[0m',
};

function emit(level, scope, args) {
  if (LEVELS[level] > threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tag = scope ? '[' + scope + ']' : '';
  console.log(COLOR[level] + ts + ' ' + level.toUpperCase().padEnd(5) + COLOR.reset + ' ' + tag, ...args);
}

function make(scope) {
  return {
    error: (...a) => emit('error', scope, a),
    warn: (...a) => emit('warn', scope, a),
    info: (...a) => emit('info', scope, a),
    debug: (...a) => emit('debug', scope, a),
    child: (sub) => make(scope ? scope + ':' + sub : sub),
  };
}

module.exports = make('');
module.exports.make = make;
