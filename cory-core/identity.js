'use strict';

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeEmail(value) {
  const normalized = text(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

function normalizePhone(value) {
  const digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return '';
}

function httpError(message, status = 400, code = '') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function upsertIdentity(client, kind, normalized, provider = '') {
  const result = await client.query(`
    INSERT INTO retail_channel_identities(identity_kind,address_normalized,provider,last_seen_at)
    VALUES($1,$2,$3,NOW())
    ON CONFLICT(identity_kind,address_normalized,provider)
    DO UPDATE SET last_seen_at=NOW()
    RETURNING *
  `, [kind, normalized, provider]);
  return result.rows[0];
}

async function linkedCustomerIds(client, identityIds) {
  if (!identityIds.length) return [];
  const result = await client.query(`
    SELECT DISTINCT customer_id
    FROM retail_customer_identity_links
    WHERE identity_id=ANY($1::bigint[]) AND status='ACTIVE'
  `, [identityIds]);
  return result.rows.map((row) => Number(row.customer_id));
}

async function resolveCustomer(client, input) {
  const firstName = text(input.firstName, 100);
  const lastName = text(input.lastName, 100);
  const normalizedEmail = normalizeEmail(input.email);
  const normalizedPhone = normalizePhone(input.phone);

  if (!firstName || !lastName) throw httpError('First and last name are required.');
  if (!normalizedEmail && !normalizedPhone) throw httpError('A valid email address or phone number is required.');

  const identities = [];
  if (normalizedEmail) identities.push(await upsertIdentity(client, 'EMAIL', normalizedEmail));
  if (normalizedPhone) identities.push(await upsertIdentity(client, 'PHONE', normalizedPhone));

  const customerIds = await linkedCustomerIds(client, identities.map((item) => Number(item.id)));
  if (customerIds.length > 1) {
    throw httpError(
      'Those contact details match more than one customer profile. Staff review is required before changing a reservation.',
      409,
      'IDENTITY_AMBIGUOUS'
    );
  }

  let customer;
  if (customerIds.length === 1) {
    const result = await client.query(`
      UPDATE retail_customers SET
        first_name=$1,
        last_name=$2,
        email=COALESCE($3,email),
        phone=CASE WHEN $4<>'' THEN $4 ELSE phone END,
        primary_location_id=COALESCE(primary_location_id,$5),
        updated_at=NOW()
      WHERE id=$6
      RETURNING *
    `, [firstName, lastName, normalizedEmail || null, normalizedPhone, input.locationId, customerIds[0]]);
    customer = result.rows[0];
  } else {
    const result = await client.query(`
      INSERT INTO retail_customers(first_name,last_name,email,phone,source,primary_location_id)
      VALUES($1,$2,$3,$4,$5,$6)
      RETURNING *
    `, [firstName, lastName, normalizedEmail || null, normalizedPhone, text(input.source || 'omnichannel', 80), input.locationId]);
    customer = result.rows[0];
  }

  for (const identity of identities) {
    await client.query(`
      INSERT INTO retail_customer_identity_links(customer_id,identity_id,status,confidence)
      VALUES($1,$2,'ACTIVE','UNVERIFIED')
      ON CONFLICT(customer_id,identity_id) DO UPDATE SET status='ACTIVE'
    `, [customer.id, identity.id]);
  }

  return {
    customer,
    identities,
    email: normalizedEmail,
    phone: normalizedPhone
  };
}

module.exports = {
  httpError,
  normalizeEmail,
  normalizePhone,
  resolveCustomer,
  text
};
