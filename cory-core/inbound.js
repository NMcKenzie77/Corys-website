'use strict';

const crypto = require('crypto');
const { withTransaction } = require('../db');
const { normalizeEmail, text } = require('./identity');

function objects(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function platformServiceAuthorized(req) {
  const configuredKey = text(process.env.ARKON_PLATFORM_SERVICE_KEY, 1000);
  const configuredRuntime = text(process.env.CORY_RUNTIME_KEY, 100);
  if (!configuredKey || !configuredRuntime) return { configured: false, authorized: false };

  const auth = text(req.get('Authorization'), 1200);
  const suppliedKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const suppliedRuntime = text(req.get('x-arkon-runtime-key'), 100);

  return {
    configured: true,
    authorized: safeEqual(configuredKey, suppliedKey) && safeEqual(configuredRuntime, suppliedRuntime)
  };
}

function emailAddress(value) {
  if (value && typeof value === 'object') {
    return normalizeEmail(first(value.email, value.address, value.value));
  }
  const raw = text(value, 500);
  const bracketed = raw.match(/<([^<>]+)>\s*$/);
  return normalizeEmail(bracketed ? bracketed[1] : raw);
}

function redactSensitiveText(value, max = 10000) {
  let result = text(value, max);
  result = result.replace(/(?:\d[ -]?){13,19}/g, (candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 13 && digits.length <= 19 ? '[PAYMENT DATA REDACTED]' : candidate;
  });
  result = result.replace(
    /\b((?:driver'?s?|state)\s+(?:license|id)\s*(?:number|#|no\.?)[\s:=-]*)[A-Za-z0-9-]{4,30}\b/gi,
    '$1[ID DATA REDACTED]'
  );
  return result;
}

function containsSensitiveData(value) {
  const raw = text(value, 12000);
  return /(?:\d[ -]?){13,19}/.test(raw)
    || /\b(?:cvv|cvc|credit\s*card|debit\s*card|driver'?s?\s+license\s+(?:number|#|no\.?))\b/i.test(raw);
}

function extractReservationCode(value) {
  return (text(value, 12000).match(/\bCRY-\d{8}-[A-F0-9]{6}\b/i) || [''])[0].toUpperCase();
}

function inferIntent(body, reservationCode) {
  const value = text(body, 12000).toLowerCase();
  if (reservationCode) {
    if (/\b(cancel|never\s*mind|do\s*not\s*hold)\b/.test(value)) return 'CANCEL_RESERVATION';
    if (/\b(change|modify|add|remove|replace|instead|different|quantity|pickup\s*time)\b/.test(value)) return 'CHANGE_RESERVATION';
    return 'STATUS';
  }
  return 'CREATE_RESERVATION';
}

function normalizeInboundEmail(body) {
  const root = objects(body);
  const nested = objects(first(root.email, root.message, root.data));
  const source = Object.keys(nested).length ? nested : root;

  const from = emailAddress(first(source.fromEmail, source.from, source.sender, root.fromEmail, root.from));
  const providerEventId = text(first(
    source.providerEventId,
    source.providerMessageId,
    source.messageId,
    source.emailId,
    source.id,
    root.providerEventId,
    root.eventId,
    root.id
  ), 300);
  const providerThreadId = text(first(
    source.providerThreadId,
    source.threadId,
    source.thread_id,
    source.inReplyTo,
    root.providerThreadId,
    root.threadId
  ), 300);
  const provider = text(first(source.provider, root.provider, 'ARKON_PLATFORM'), 80).toUpperCase().replace(/[^A-Z0-9_-]/g, '_');
  const subject = redactSensitiveText(first(source.subject, root.subject), 500);
  const bodyText = redactSensitiveText(first(
    source.text,
    source.bodyText,
    source.textBody,
    source.body,
    root.text,
    root.bodyText,
    root.body
  ), 10000);
  const rawForSensitivity = [
    first(source.subject, root.subject),
    first(source.text, source.bodyText, source.textBody, source.body, root.text, root.bodyText, root.body)
  ].join('\n');

  return {
    provider: provider || 'ARKON_PLATFORM',
    providerEventId,
    providerThreadId,
    from,
    to: emailAddress(first(source.to, source.toEmail, root.to, root.toEmail)),
    subject,
    bodyText,
    sensitive: containsSensitiveData(rawForSensitivity),
    attachmentCount: Array.isArray(source.attachments) ? source.attachments.length : 0
  };
}

async function primaryLocation(client) {
  const result = await client.query(`SELECT id FROM retail_locations WHERE location_key='primary' LIMIT 1`);
  if (!result.rowCount) throw new Error('Cory primary retail location is not configured.');
  return Number(result.rows[0].id);
}

async function resolveEmailIdentity(client, email) {
  const identity = await client.query(`
    INSERT INTO retail_channel_identities(identity_kind,address_normalized,provider,last_seen_at)
    VALUES('EMAIL',$1,'',NOW())
    ON CONFLICT(identity_kind,address_normalized,provider)
    DO UPDATE SET last_seen_at=NOW()
    RETURNING id
  `, [email]);

  const links = await client.query(`
    SELECT DISTINCT customer_id
    FROM retail_customer_identity_links
    WHERE identity_id=$1 AND status='ACTIVE'
    ORDER BY customer_id
  `, [identity.rows[0].id]);

  const customerIds = links.rows.map((row) => Number(row.customer_id));
  return {
    identityId: Number(identity.rows[0].id),
    customerId: customerIds.length === 1 ? customerIds[0] : null,
    ambiguous: customerIds.length > 1
  };
}

async function findOrCreateConversation(client, input) {
  let conversation = null;

  if (input.providerThreadId) {
    const thread = await client.query(`
      SELECT *
      FROM retail_conversations
      WHERE source_channel='EMAIL'
        AND state<>'CLOSED'
        AND context_json->>'providerThreadId'=$1
        AND (
          ($2::bigint IS NULL AND customer_id IS NULL)
          OR customer_id=$2
          OR customer_id IS NULL
        )
      ORDER BY last_activity_at DESC,id DESC
      LIMIT 1
    `, [input.providerThreadId, input.customerId]);
    conversation = thread.rows[0] || null;
  }

  if (!conversation && input.customerId) {
    const customer = await client.query(`
      SELECT *
      FROM retail_conversations
      WHERE source_channel='EMAIL'
        AND state<>'CLOSED'
        AND customer_id=$1
      ORDER BY last_activity_at DESC,id DESC
      LIMIT 1
    `, [input.customerId]);
    conversation = customer.rows[0] || null;
  }

  if (conversation) {
    const updated = await client.query(`
      UPDATE retail_conversations SET
        customer_id=COALESCE(customer_id,$1),
        state='HUMAN',
        ai_paused_at=NOW(),
        last_activity_at=NOW(),
        updated_at=NOW(),
        context_json=context_json || $2::jsonb
      WHERE id=$3
      RETURNING *
    `, [
      input.customerId,
      JSON.stringify(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
      conversation.id
    ]);
    return updated.rows[0];
  }

  const created = await client.query(`
    INSERT INTO retail_conversations(customer_id,location_id,source_channel,state,ai_paused_at,context_json)
    VALUES($1,$2,'EMAIL','HUMAN',NOW(),$3::jsonb)
    RETURNING *
  `, [
    input.customerId,
    input.locationId,
    JSON.stringify(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {})
  ]);
  return created.rows[0];
}

async function receiveEmail(email) {
  if (!email.providerEventId) {
    const error = new Error('Inbound email requires a stable provider event/message ID.');
    error.status = 400;
    throw error;
  }
  if (!email.from) {
    const error = new Error('Inbound email sender is missing or invalid.');
    error.status = 400;
    throw error;
  }
  if (!email.bodyText && !email.subject) {
    const error = new Error('Inbound email contains no usable text.');
    error.status = 400;
    throw error;
  }

  return withTransaction(async (client) => {
    const locationId = await primaryLocation(client);
    const traceId = crypto.randomUUID();
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify({
      provider: email.provider,
      providerEventId: email.providerEventId,
      providerThreadId: email.providerThreadId,
      from: email.from,
      subject: email.subject,
      bodyText: email.bodyText
    })).digest('hex');

    const event = await client.query(`
      INSERT INTO retail_channel_events(
        trace_id,channel,provider,provider_event_id,provider_thread_id,location_id,payload_hash,safe_metadata,status
      ) VALUES($1,'EMAIL',$2,$3,$4,$5,$6,$7::jsonb,'RECEIVED')
      ON CONFLICT(provider,channel,provider_event_id) DO NOTHING
      RETURNING *
    `, [
      traceId,
      email.provider,
      email.providerEventId,
      email.providerThreadId,
      locationId,
      payloadHash,
      JSON.stringify({
        from: email.from,
        to: email.to || null,
        subject: email.subject,
        attachmentCount: email.attachmentCount,
        attachmentsPersisted: false
      })
    ]);

    if (!event.rowCount) {
      return { ok: true, accepted: true, duplicate: true };
    }

    const identity = await resolveEmailIdentity(client, email.from);
    const conversation = await findOrCreateConversation(client, {
      customerId: identity.customerId,
      locationId,
      providerThreadId: email.providerThreadId
    });

    const reservationCode = extractReservationCode(`${email.subject}\n${email.bodyText}`);
    const intent = inferIntent(email.bodyText, reservationCode);
    const message = await client.query(`
      INSERT INTO retail_messages(
        conversation_id,channel_event_id,channel,direction,normalized_body,intent,entities_json,confidence,sensitive_redacted
      ) VALUES($1,$2,'EMAIL','INBOUND',$3,$4,$5::jsonb,$6,$7)
      RETURNING *
    `, [
      conversation.id,
      event.rows[0].id,
      email.bodyText || email.subject,
      intent,
      JSON.stringify({ subject: email.subject, reservationCode: reservationCode || null }),
      reservationCode ? 0.95 : 0.7,
      email.sensitive
    ]);

    let order = null;
    let identityMismatch = false;
    if (reservationCode) {
      const orderResult = await client.query(
        'SELECT id,customer_id,status,reservation_code FROM retail_orders WHERE reservation_code=$1 LIMIT 1',
        [reservationCode]
      );
      order = orderResult.rows[0] || null;

      if (order && identity.customerId && Number(order.customer_id) === identity.customerId) {
        const relationship = intent === 'STATUS' ? 'STATUS' : 'CHANGE';
        await client.query(`
          INSERT INTO retail_conversation_orders(conversation_id,order_id,relationship)
          VALUES($1,$2,$3)
          ON CONFLICT(conversation_id,order_id,relationship) DO NOTHING
        `, [conversation.id, order.id, relationship]);
      } else {
        identityMismatch = true;
      }
    }

    let reason = 'EMAIL_RESERVATION_REVIEW';
    let priority = 'NORMAL';
    if (email.sensitive) {
      reason = 'SENSITIVE_DATA_RECEIVED';
      priority = 'HIGH';
    } else if (identity.ambiguous) {
      reason = 'IDENTITY_AMBIGUOUS';
      priority = 'HIGH';
    } else if (!identity.customerId) {
      reason = 'UNRESOLVED_EMAIL_IDENTITY';
    } else if (identityMismatch) {
      reason = 'RESERVATION_IDENTITY_MISMATCH';
      priority = 'HIGH';
    }

    await client.query(`
      INSERT INTO retail_escalations(conversation_id,order_id,reason,details,priority,state)
      VALUES($1,$2,$3,$4,$5,'OPEN')
    `, [
      conversation.id,
      order && !identityMismatch ? order.id : null,
      reason,
      text(`Inbound email from ${email.from}: ${email.subject || '(no subject)'}. Exact product/quantity confirmation is required before Cory may reserve or modify inventory.`, 1000),
      priority
    ]);

    await client.query(`
      UPDATE retail_channel_events
      SET status='NEEDS_STAFF',processed_at=NOW()
      WHERE id=$1
    `, [event.rows[0].id]);

    await client.query(`
      INSERT INTO retail_audit_events(
        trace_id,actor_type,actor_ref,action,entity_type,entity_id,after_json,reference,policy_version
      ) VALUES($1,'CUSTOMER',$2,'INBOUND_EMAIL_ACCEPTED','CONVERSATION',$3,$4::jsonb,$5,'CORY_EMAIL_INGRESS_V1')
    `, [
      traceId,
      email.from,
      String(conversation.id),
      JSON.stringify({
        channelEventId: Number(event.rows[0].id),
        messageId: Number(message.rows[0].id),
        intent,
        reservationCode: reservationCode || null,
        sensitiveRedacted: email.sensitive
      }),
      email.providerEventId
    ]);

    return {
      ok: true,
      accepted: true,
      duplicate: false,
      conversationId: Number(conversation.id),
      eventId: Number(event.rows[0].id),
      needsStaff: true,
      intent,
      reservationCode: reservationCode || null,
      sensitiveRedacted: email.sensitive
    };
  });
}

async function receivePlatformEmail(req, res, next) {
  try {
    const auth = platformServiceAuthorized(req);
    if (!auth.configured) {
      return res.status(503).json({ ok: false, error: 'ARKON Platform service authentication is not configured.' });
    }
    if (!auth.authorized) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const email = normalizeInboundEmail(req.body || {});
    const result = await receiveEmail(email);
    return res.status(result.duplicate ? 200 : 202).json(result);
  } catch (error) {
    if (error && error.status) return res.status(error.status).json({ ok: false, error: error.message });
    next(error);
  }
}

module.exports = {
  containsSensitiveData,
  extractReservationCode,
  inferIntent,
  normalizeInboundEmail,
  platformServiceAuthorized,
  receivePlatformEmail,
  redactSensitiveText
};
