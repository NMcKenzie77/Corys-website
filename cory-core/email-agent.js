'use strict';

const { pool, withTransaction } = require('../db');
const { text } = require('./identity');
const { createEmailReservationFromProposal } = require('./reservations');
const { STORE_TIME_ZONE, storeDateKey } = require('./scheduling');

const AUTOMATION_CONFIDENCE = 0.82;

function firstNonemptyLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function explicitConfirmation(value) {
  const line = firstNonemptyLine(value);
  return /^(?:CONFIRM|YES[ ,]+CONFIRM|I CONFIRM|I AM 21\+ AND CONFIRM)[.!]?$/i.test(line);
}

function explicitAgeAttestation(value) {
  const raw = String(value || '');
  if (/\b(?:not|under)\s+(?:yet\s+)?21\b/i.test(raw)) return false;
  return /\b(?:I\s+AM\s+)?21\s*(?:\+|OR\s+OLDER|YEARS?\s+OLD)\b/i.test(raw);
}

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const get = (type) => Number((parts.find((part) => part.type === type) || {}).value || 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function zoneOffsetMinutes(date) {
  const p = zonedParts(date);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((localAsUtc - date.getTime()) / 60000);
}

function storeLocalTimeToUtc(dateKey, hour, minute) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = new Date(localAsUtc);
  for (let i = 0; i < 2; i += 1) {
    guess = new Date(localAsUtc - zoneOffsetMinutes(guess) * 60 * 1000);
  }
  return guess;
}

function parseExplicitStorePickupTime(value, now = new Date()) {
  const match = String(value || '').match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(AM|PM)\b/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === 'PM') hour += 12;
  const pickupAt = storeLocalTimeToUtc(storeDateKey(now), hour, Number(match[2] || 0));
  return pickupAt.getTime() > now.getTime() ? pickupAt : null;
}

function tokens(value) {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g) || [])].filter((token) => token.length > 1);
}

async function catalogCandidates(queryText) {
  const result = await pool.query(`
    SELECT v.id AS variant_id,v.sku,v.label AS variant_label,v.inventory_qty,v.price_cents,v.sale_price_cents,
           p.name AS product_name,p.brand,
           COALESCE((
             SELECT SUM(h.quantity)::int FROM retail_inventory_holds h
             JOIN retail_locations l ON l.id=h.location_id
             WHERE l.location_key='primary' AND h.variant_id=v.id AND h.state='ACTIVE'
           ),0) AS held_qty
    FROM product_variants v
    JOIN products p ON p.id=v.product_id
    WHERE v.active=TRUE AND p.active=TRUE
    ORDER BY p.name,v.label,v.id
    LIMIT 1000
  `);
  const queryTokens = tokens(queryText);
  return result.rows.map((row) => {
    const haystack = `${row.product_name} ${row.brand || ''} ${row.variant_label} ${row.sku}`.toLowerCase();
    const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    return {
      variantId: Number(row.variant_id),
      sku: row.sku,
      productName: row.product_name,
      variantLabel: row.variant_label,
      brand: row.brand || undefined,
      availableQty: Math.max(0, Number(row.inventory_qty) - Number(row.held_qty || 0)),
      score
    };
  }).sort((a, b) => b.score - a.score || a.productName.localeCompare(b.productName)).slice(0, 80)
    .map(({ score, ...item }) => item);
}

async function callPlatformInterpreter(input) {
  const platformUrl = text(process.env.ARKON_PLATFORM_URL, 500).replace(/\/+$/, '');
  const serviceKey = text(process.env.ARKON_PLATFORM_SERVICE_KEY, 1000);
  const runtimeKey = text(process.env.CORY_RUNTIME_KEY, 100);
  const clientCompanyId = text(process.env.CORY_PLATFORM_CLIENT_COMPANY_ID, 160);
  if (!platformUrl || !serviceKey || !runtimeKey || !clientCompanyId) {
    throw new Error('Platform AI interpretation is not configured.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${platformUrl}/api/internal/ai/cory-reservation-intent`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'x-arkon-runtime-key': runtimeKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        clientCompanyId,
        subject: text(input.subject, 500),
        message: text(input.message, 10000),
        reservationCode: input.reservationCode || undefined,
        pendingProposal: input.pendingProposal || null,
        catalog: input.catalog
      })
    });
    const responseText = await response.text();
    let data = null;
    try { data = JSON.parse(responseText); } catch (_error) {}
    if (!response.ok || !data || data.ok !== true || !data.data) {
      throw new Error(`Platform AI ${response.status}: ${text(data && data.error ? data.error : responseText, 600)}`);
    }
    return data.data;
  } finally {
    clearTimeout(timer);
  }
}

async function queueReply(options) {
  return withTransaction(async (client) => {
    const body = text(options.body, 8000);
    const outbound = await client.query(`
      INSERT INTO retail_messages(conversation_id,channel,direction,normalized_body,reply_to_message_id,intent,entities_json,confidence)
      VALUES($1,'EMAIL','OUTBOUND',$2,$3,$4,$5::jsonb,1.0)
      RETURNING id
    `, [
      options.conversationId,
      body,
      options.sourceMessageId || null,
      options.intent || 'HELP',
      JSON.stringify({ automated: Boolean(options.automated), kind: options.kind })
    ]);

    await client.query(`
      INSERT INTO retail_outbox(conversation_id,channel,recipient_identity_id,event_type,payload,idempotency_key)
      VALUES($1,'EMAIL',$2,$3,$4::jsonb,$5)
      ON CONFLICT(idempotency_key) DO NOTHING
    `, [
      options.conversationId,
      options.identityId,
      options.kind,
      JSON.stringify({ to: options.to, subject: text(options.subject, 500), text: body }),
      `email-agent:${options.sourceMessageId}:${options.kind}`
    ]);

    await client.query(`
      UPDATE retail_conversations SET
        state=$1,
        ai_paused_at=$2,
        context_json=context_json || $3::jsonb,
        last_activity_at=NOW(),updated_at=NOW()
      WHERE id=$4
    `, [
      options.automated ? 'WAITING_CUSTOMER' : 'HUMAN',
      options.automated ? null : new Date(),
      JSON.stringify(options.contextPatch || {}),
      options.conversationId
    ]);

    if (options.automated) {
      if (options.sourceMessageId) {
        await client.query(`
          UPDATE retail_channel_events SET status='PROCESSED',processed_at=NOW()
          WHERE id=(SELECT channel_event_id FROM retail_messages WHERE id=$1)
        `, [options.sourceMessageId]);
      }
      await client.query(`
        UPDATE retail_escalations SET state='RESOLVED',resolved_at=NOW()
        WHERE conversation_id=$1 AND reason='EMAIL_RESERVATION_REVIEW' AND state IN ('OPEN','CLAIMED')
      `, [options.conversationId]);
    }
    return Number(outbound.rows[0].id);
  });
}

function clarificationText(question) {
  return `${text(question, 500)}\n\nPlease do not email payment card information or ID images/numbers. Payment and final ID verification happen in the store.`;
}

function proposalSummary(proposal, catalog) {
  const byId = new Map(catalog.map((item) => [Number(item.variantId), item]));
  const lines = proposal.items.map((item) => {
    const found = byId.get(Number(item.variantId));
    return `- ${item.quantity} x ${found.productName}${found.variantLabel ? ` — ${found.variantLabel}` : ''}`;
  });
  const pickup = proposal.pickupWindow === 'ASAP'
    ? 'ASAP (inventory hold lasts 2 hours after confirmation)'
    : `${proposal.pickupWindow} today`;
  return [
    'Here is the pickup reservation I can place:',
    '',
    ...lines,
    '',
    `Pickup: ${pickup}`,
    '',
    'Nothing is held yet. To place this reservation, reply exactly: CONFIRM',
    'If you have not already told us you are 21 or older, reply exactly: I AM 21+ AND CONFIRM',
    '',
    'Payment and final ID verification happen in the store.'
  ].join('\n');
}

async function humanAcknowledgement(input, kind, message) {
  if (!input.identityId || !input.email.from) return { status: 'HUMAN', reason: kind };
  await queueReply({
    conversationId: input.conversationId,
    identityId: input.identityId,
    to: input.email.from,
    subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
    body: message,
    sourceMessageId: input.messageId,
    kind,
    automated: false,
    intent: input.intent
  });
  return { status: 'HUMAN', reason: kind };
}

async function handleInboundEmail(input) {
  if (!input || input.duplicate) return { status: 'DUPLICATE' };
  if (input.sensitiveRedacted) {
    return humanAcknowledgement(input, 'EMAIL_SENSITIVE_DATA_HANDOFF', 'We received your message, but please do not email payment card information or ID images/numbers. A store team member will review the safe portion of your request. Payment and final ID verification happen in the store.');
  }
  if (!input.customerId || input.identityAmbiguous || input.identityMismatch) {
    return humanAcknowledgement(input, 'EMAIL_IDENTITY_HANDOFF', 'We received your pickup request. A store team member will review it because we need to safely match the request to a customer profile before reserving inventory.');
  }

  const stateResult = await pool.query(`
    SELECT c.context_json,rc.phone
    FROM retail_conversations c
    JOIN retail_customers rc ON rc.id=c.customer_id
    WHERE c.id=$1 AND c.customer_id=$2
    LIMIT 1
  `, [input.conversationId, input.customerId]);
  if (!stateResult.rowCount || !text(stateResult.rows[0].phone, 80)) {
    return humanAcknowledgement(input, 'EMAIL_PROFILE_HANDOFF', 'We received your pickup request. A store team member will help because your customer profile needs a phone contact before an email reservation can be confirmed.');
  }

  const context = stateResult.rows[0].context_json || {};
  const pending = context.pendingEmailProposal && typeof context.pendingEmailProposal === 'object'
    ? context.pendingEmailProposal
    : null;
  const incomingText = `${input.email.subject || ''}\n${input.email.bodyText || ''}`;

  if (explicitConfirmation(input.email.bodyText) && pending && pending.type === 'CREATE_RESERVATION') {
    const ageAttested = Boolean(pending.ageAttested) || explicitAgeAttestation(input.email.bodyText);
    if (!ageAttested) {
      await queueReply({
        conversationId: input.conversationId,
        identityId: input.identityId,
        to: input.email.from,
        subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
        body: 'Before I place the hold, please reply exactly: I AM 21+ AND CONFIRM\n\nPayment and final ID verification happen in the store.',
        sourceMessageId: input.messageId,
        kind: 'EMAIL_AGE_CONFIRMATION_REQUIRED',
        automated: true,
        intent: 'CREATE_RESERVATION'
      });
      return { status: 'WAITING_CUSTOMER', reason: 'AGE_ATTESTATION_REQUIRED' };
    }

    try {
      const reservation = await createEmailReservationFromProposal({
        conversationId: input.conversationId,
        customerId: input.customerId,
        identityId: input.identityId,
        messageId: input.messageId,
        eventId: input.eventId,
        ageAttested
      });
      return { status: 'CONFIRMED', reservationCode: reservation.reservationCode };
    } catch (error) {
      console.error('Email reservation confirmation requires staff review', { conversationId: input.conversationId, error: error.message });
      return humanAcknowledgement(input, 'EMAIL_CONFIRMATION_CONFLICT', 'I could not safely place that hold because inventory or reservation details changed. A store team member will review it. No reservation was created.');
    }
  }

  if (explicitConfirmation(input.email.bodyText) && !pending) {
    return humanAcknowledgement(input, 'EMAIL_CONFIRMATION_WITHOUT_PROPOSAL', 'I received your confirmation, but there is no exact pending basket I can safely confirm. A store team member will review your message.');
  }

  let catalog;
  let interpretation;
  try {
    catalog = await catalogCandidates(incomingText);
    if (!catalog.length) throw new Error('No active catalog variants are available.');
    interpretation = await callPlatformInterpreter({
      subject: input.email.subject,
      message: input.email.bodyText || input.email.subject,
      reservationCode: input.reservationCode,
      pendingProposal: pending,
      catalog
    });
  } catch (error) {
    console.error('Email reservation interpretation requires staff review', { conversationId: input.conversationId, error: error.message });
    return humanAcknowledgement(input, 'EMAIL_AI_UNAVAILABLE', 'We received your pickup request. A store team member will review it because automated interpretation is unavailable right now.');
  }

  if (Number(interpretation.confidence) < AUTOMATION_CONFIDENCE) {
    return humanAcknowledgement(input, 'EMAIL_LOW_CONFIDENCE', 'We received your pickup request. A store team member will review it because I am not confident enough to interpret every detail safely.');
  }
  if (interpretation.intent !== 'CREATE_RESERVATION') {
    return humanAcknowledgement(input, 'EMAIL_NON_CREATE_HANDOFF', 'We received your message. A store team member will handle this request; automated email changes, cancellations, and status requests are not enabled yet.');
  }

  const unresolved = !Array.isArray(interpretation.items)
    || !interpretation.items.length
    || interpretation.items.some((item) => item.variantId == null);
  if (unresolved || interpretation.needsClarification) {
    const question = text(interpretation.clarificationQuestion, 500)
      || (unresolved ? 'Which exact product and quantity would you like reserved?' : 'What should I clarify before I prepare the reservation?');
    await queueReply({
      conversationId: input.conversationId,
      identityId: input.identityId,
      to: input.email.from,
      subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
      body: clarificationText(question),
      sourceMessageId: input.messageId,
      kind: 'EMAIL_RESERVATION_CLARIFICATION',
      automated: true,
      intent: 'CREATE_RESERVATION',
      contextPatch: {
        pendingEmailProposal: {
          type: 'CREATE_RESERVATION',
          items: Array.isArray(interpretation.items) ? interpretation.items : [],
          pickupMode: interpretation.pickupMode,
          ageAttested: explicitAgeAttestation(input.email.bodyText),
          interpretationId: interpretation.interpretationId || null
        }
      }
    });
    return { status: 'WAITING_CUSTOMER', reason: 'CLARIFICATION_REQUIRED' };
  }

  const byId = new Map(catalog.map((item) => [Number(item.variantId), item]));
  for (const item of interpretation.items) {
    const found = byId.get(Number(item.variantId));
    if (!found || found.availableQty < Number(item.quantity)) {
      await queueReply({
        conversationId: input.conversationId,
        identityId: input.identityId,
        to: input.email.from,
        subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
        body: clarificationText('One of those items is no longer available in the requested quantity. What would you like instead?'),
        sourceMessageId: input.messageId,
        kind: 'EMAIL_STOCK_CLARIFICATION',
        automated: true,
        intent: 'CREATE_RESERVATION'
      });
      return { status: 'WAITING_CUSTOMER', reason: 'STOCK_CLARIFICATION_REQUIRED' };
    }
  }

  let pickupWindow = 'ASAP';
  let pickupAt = null;
  if (interpretation.pickupMode === 'SCHEDULED') {
    pickupAt = parseExplicitStorePickupTime(input.email.bodyText);
    if (!pickupAt) {
      await queueReply({
        conversationId: input.conversationId,
        identityId: input.identityId,
        to: input.email.from,
        subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
        body: clarificationText('What exact time today will you pick up? Please include AM or PM, for example 5:30 PM.'),
        sourceMessageId: input.messageId,
        kind: 'EMAIL_PICKUP_TIME_CLARIFICATION',
        automated: true,
        intent: 'CREATE_RESERVATION',
        contextPatch: {
          pendingEmailProposal: {
            type: 'CREATE_RESERVATION',
            items: interpretation.items,
            pickupMode: 'SCHEDULED',
            ageAttested: explicitAgeAttestation(input.email.bodyText),
            interpretationId: interpretation.interpretationId || null
          }
        }
      });
      return { status: 'WAITING_CUSTOMER', reason: 'PICKUP_TIME_REQUIRED' };
    }
    pickupWindow = new Intl.DateTimeFormat('en-US', { timeZone: STORE_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(pickupAt);
  } else if (interpretation.pickupMode !== 'ASAP') {
    await queueReply({
      conversationId: input.conversationId,
      identityId: input.identityId,
      to: input.email.from,
      subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
      body: clarificationText('Would you like pickup ASAP, or at what exact time today? Please include AM or PM.'),
      sourceMessageId: input.messageId,
      kind: 'EMAIL_PICKUP_MODE_CLARIFICATION',
      automated: true,
      intent: 'CREATE_RESERVATION',
      contextPatch: {
        pendingEmailProposal: {
          type: 'CREATE_RESERVATION',
          items: interpretation.items,
          pickupMode: 'UNKNOWN',
          ageAttested: explicitAgeAttestation(input.email.bodyText),
          interpretationId: interpretation.interpretationId || null
        }
      }
    });
    return { status: 'WAITING_CUSTOMER', reason: 'PICKUP_MODE_REQUIRED' };
  }

  const proposal = {
    type: 'CREATE_RESERVATION',
    items: interpretation.items.map((item) => ({ variantId: Number(item.variantId), quantity: Number(item.quantity) })),
    pickupMode: interpretation.pickupMode,
    pickupWindow,
    pickupAt: pickupAt ? pickupAt.toISOString() : null,
    ageAttested: explicitAgeAttestation(input.email.bodyText),
    interpretationId: interpretation.interpretationId || null,
    proposedAt: new Date().toISOString()
  };
  await queueReply({
    conversationId: input.conversationId,
    identityId: input.identityId,
    to: input.email.from,
    subject: `Re: ${input.email.subject || 'Pickup reservation'}`,
    body: proposalSummary(proposal, catalog),
    sourceMessageId: input.messageId,
    kind: 'EMAIL_RESERVATION_PROPOSAL',
    automated: true,
    intent: 'CREATE_RESERVATION',
    contextPatch: { pendingEmailProposal: proposal }
  });
  return { status: 'WAITING_CUSTOMER', reason: 'EXPLICIT_CONFIRMATION_REQUIRED' };
}

module.exports = {
  AUTOMATION_CONFIDENCE,
  catalogCandidates,
  explicitAgeAttestation,
  explicitConfirmation,
  handleInboundEmail,
  parseExplicitStorePickupTime
};
