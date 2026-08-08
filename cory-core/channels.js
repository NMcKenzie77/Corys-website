'use strict';

const { pool, withTransaction } = require('../db');
const { text } = require('./identity');

function platformEmailConfigured() {
  return Boolean(
    process.env.ARKON_PLATFORM_URL &&
    process.env.ARKON_PLATFORM_SERVICE_KEY &&
    process.env.CORY_RUNTIME_KEY
  );
}

function channelCapabilities() {
  const emailReady = platformEmailConfigured();
  return {
    WEB: { enabled: true, inbound: true, outbound: true, reason: 'Core website channel' },
    EMAIL: {
      enabled: emailReady,
      inbound: emailReady,
      outbound: emailReady,
      reason: emailReady ? 'Transactional email routed through ARKON Platform' : 'ARKON Platform email route is not configured'
    },
    VOICE: { enabled: false, inbound: false, outbound: false, reason: 'Voice adapter ready; provider configuration pending' },
    SMS: { enabled: false, inbound: false, outbound: false, reason: 'Cannabis-capable provider and inbound API require written verification before activation' },
    WHATSAPP: { enabled: false, inbound: false, outbound: false, reason: 'Policy-disabled for recreational drug transaction facilitation' }
  };
}

async function sendEmail(payload) {
  if (!platformEmailConfigured()) throw new Error('ARKON Platform email route is not configured.');
  const to = text(payload.to, 200).toLowerCase();
  if (!to) throw new Error('Email outbox item is missing a recipient.');

  const code = text(payload.reservationCode, 100);
  const needsClarification = payload.status === 'NEEDS_CLARIFICATION';
  const genericSubject = text(payload.subject, 500);
  const genericText = text(payload.text, 8000);
  const generic = Boolean(genericSubject && genericText);
  const subject = generic
    ? genericSubject
    : (needsClarification ? `Pickup reservation ${code} needs a pickup time` : `Pickup reservation ${code} confirmed`);
  const plainText = generic
    ? genericText
    : (needsClarification
      ? `Pickup reservation ${code}. We have your request, but we need an exact pickup time before inventory can be held. Payment and final sale happen inside the store.`
      : `Pickup reservation ${code} confirmed. Your items are reserved for pickup. Bring a valid government-issued photo ID. Payment and final sale happen inside the store.`);
  const html = generic
    ? undefined
    : (needsClarification
      ? `<h2>Pickup reservation ${code}</h2><p>We have your request, but we need an exact pickup time before inventory can be held.</p><p>Payment and final sale happen inside the store.</p>`
      : `<h2>Pickup reservation ${code} confirmed</h2><p>Your items are reserved for pickup.</p><p>Bring a valid government-issued photo ID. Payment and final sale happen inside the store.</p>`);

  const platformUrl = text(process.env.ARKON_PLATFORM_URL, 500).replace(/\/+$/, '');
  const runtimeKey = text(process.env.CORY_RUNTIME_KEY, 100);
  const response = await fetch(`${platformUrl}/api/internal/email/send-for-runtime`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ARKON_PLATFORM_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'x-arkon-runtime-key': runtimeKey
    },
    body: JSON.stringify({
      source: runtimeKey,
      to: [to],
      subject,
      text: plainText,
      ...(html ? { html } : {}),
      fromName: text(process.env.SITE_NAME, 120) || 'Cory'
    })
  });

  const responseText = await response.text();
  let receipt = null;
  try { receipt = JSON.parse(responseText); } catch (_error) {}
  if (!response.ok || !receipt || receipt.ok !== true) {
    const detail = receipt && receipt.error ? receipt.error : responseText;
    throw new Error(`ARKON Platform email ${response.status}: ${text(detail, 800)}`);
  }
  return receipt;
}

async function claimOutboxBatch() {
  return withTransaction(async (client) => {
    await client.query(`
      UPDATE retail_outbox SET status='PENDING',updated_at=NOW()
      WHERE status='SENDING' AND updated_at<NOW()-INTERVAL '10 minutes'
    `);
    const rows = await client.query(`
      SELECT * FROM retail_outbox
      WHERE status='PENDING' AND next_attempt_at<=NOW()
      ORDER BY id
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.rowCount) {
      await client.query(`UPDATE retail_outbox SET status='SENDING',updated_at=NOW() WHERE id=ANY($1::bigint[])`, [rows.rows.map((row) => row.id)]);
    }
    return rows.rows;
  });
}

async function failOutbox(row, error) {
  const attempts = Number(row.attempts || 0) + 1;
  const dead = attempts >= 5;
  const delayMinutes = Math.min(60, 2 ** attempts);
  await pool.query(`
    UPDATE retail_outbox SET
      status=$1,
      attempts=$2,
      last_error=$3,
      next_attempt_at=NOW()+($4||' minutes')::interval,
      updated_at=NOW()
    WHERE id=$5
  `, [dead ? 'DEAD_LETTER' : 'PENDING', attempts, text(error.message, 1000), delayMinutes, row.id]);
  if (dead) {
    await pool.query(`
      INSERT INTO retail_escalations(conversation_id,order_id,reason,details,priority)
      VALUES($1,$2,'OUTBOUND_DELIVERY_FAILED',$3,'HIGH')
    `, [row.conversation_id, row.order_id, text(error.message, 1000)]);
  }
}

async function processOutbox() {
  if (!process.env.DATABASE_URL) return { processed: 0 };
  const rows = await claimOutboxBatch();
  let processed = 0;
  for (const row of rows) {
    try {
      let receipt;
      if (row.channel === 'EMAIL') receipt = await sendEmail(row.payload || {});
      else throw new Error(`${row.channel} outbound adapter is not enabled.`);
      await pool.query(`
        UPDATE retail_outbox SET status='SENT',attempts=attempts+1,provider_message_id=$1,sent_at=NOW(),updated_at=NOW()
        WHERE id=$2
      `, [text(receipt && (receipt.messageId || receipt.id), 300), row.id]);
      processed += 1;
    } catch (error) {
      await failOutbox(row, error);
    }
  }
  return { processed };
}

module.exports = {
  channelCapabilities,
  processOutbox
};
