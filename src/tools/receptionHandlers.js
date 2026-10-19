/**
 * What the receptionist can DO about what somebody wants.
 *
 * Two things: put them through to a person, or write down what they said. Both
 * are deliberately blunt — a receptionist who negotiates is a salesperson, and
 * a receptionist who promises is a liability.
 */
const config = require('../config');
const md = require('./meraDhandaClient');
const transferer = require('../telephony/transfer');
const log = require('../util/log').make('reception');

/** Hours as the shop keeps them, in IST wherever the container runs. */
function istHourDecimal(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now).split(':');
  return Number(parts[0]) + Number(parts[1]) / 60;
}

function isOpen(now = new Date()) {
  const h = istHourDecimal(now);
  return h >= config.meraDhanda.openHour && h < config.meraDhanda.closeHour;
}

module.exports = {
  /**
   * Put the caller through.
   *
   * Every failure is a DIFFERENT sentence on a phone call, so each comes back
   * named rather than as a bare false: "there is no Rahul here" and "Akshay has
   * no number on file" and "we are closed" are three different things to say,
   * and a receptionist that says the wrong one sounds broken.
   */
  async transfer_to_staff(args, ctx) {
    const asked = String(args.name || '').trim();
    if (!asked) return { ok: false, reason: 'no name given' };

    if (!isOpen()) {
      return {
        ok: false,
        reason: 'closed',
        note: 'The shop is shut (' + config.meraDhanda.openHour + ':00-'
          + config.meraDhanda.closeHour + ':00). Take a message instead.',
      };
    }

    const found = await md.lookup(asked);

    if (found.status === 'ambiguous') {
      return {
        ok: false, reason: 'ambiguous', candidates: found.candidates,
        note: 'Ask WHICH one: ' + (found.candidates || []).join(', '),
      };
    }
    if (found.status === 'no_number') {
      return { ok: false, reason: 'no_number', name: found.name,
        note: 'They exist but there is no number to ring. Take a message.' };
    }
    if (found.status !== 'found') {
      return { ok: false, reason: 'not_found',
        note: 'Nobody here by that name. Ask who they meant, or take a message.' };
    }

    const r = await transferer.transfer({
      callUuid: ctx.callId,
      toPhone: found.phone,
      publicUrl: config.publicUrl || process.env.PUBLIC_URL || '',
      // The CUSTOMER's number, so the staff member can ring back if the line
      // drops. The office number would make every transfer look the same.
      callerId: ctx.phone,
    });

    if (!r.ok) {
      log.warn('could not transfer to ' + found.name + ': ' + r.reason);
      return { ok: false, reason: 'transfer_failed', name: found.name,
        note: 'The transfer did not go through. Take a message instead.' };
    }

    // From here the caller is Plivo's problem: either the staff member answers,
    // or the <Dial> rings out and the Redirect brings them back to us.
    return { ok: true, connecting: found.name,
      note: 'Say you are connecting them, then stop talking.' };
  },

  /** Write down what they wanted, so somebody rings them back. */
  async take_message(args, ctx) {
    const r = await md.message({
      callerName: args.callerName,
      callerPhone: ctx.phone,
      forWhom: args.forWhom,
      message: args.message,
      jobNo: args.jobNo,
      urgent: args.urgent,
      callId: ctx.callId,
    });
    if (!r.ok) {
      // The caller is about to be told their message was taken. If it was not,
      // that has to be visible somewhere other than this return value.
      log.error('a message was promised to ' + (ctx.phone || 'a caller') + ' and NOT saved');
      return { ok: false, note: 'Not saved. Ask them to call back, or offer to connect them.' };
    }
    return { ok: true, assignedTo: r.assignedTo || null };
  },

  isOpen,
  istHourDecimal,
};
