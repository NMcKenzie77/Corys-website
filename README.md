# Cory — Washington Retail Pickup Platform

Cory is a Washington cannabis retail pickup-reservation platform. It is not an online cannabis checkout, shipping service, delivery service, or POS. Customers reserve products online and complete ID verification, payment, and the final transaction inside the licensed store.

The active application entrypoint is `retail-server.js` (`npm start`). `server.js` is only a compatibility shim for older deployment configurations.

## Core architecture

The application is a modular Node/Express + PostgreSQL monolith. The `cory-core/` modules own the new omnichannel foundation:

- `schema.js` — canonical retail locations, channel identities, conversations/messages, reservation extensions, inventory holds/ledger, consent, idempotency, outbox, escalations, staff roles, audit, and integration health.
- `identity.js` — email/phone normalization and ambiguity-safe customer resolution. Contact identity is not legal-ID verification.
- `reservations.js` — pickup reservation creation, lifecycle transitions, explicit holds, migration protection for pre-core reservations, and append-only audit events.
- `inventory.js` — physical on-hand inventory, atomic reservation holds, releases, completion, receiving/adjustment events, and expiration worker.
- `channels.js` — durable notification outbox and channel capability gates.
- `adapter-contract.js` — replaceable inbound/outbound channel contract.
- `maps.js` — Google Places autocomplete and traffic-aware Google Routes estimates without persisting the customer's origin.
- `api.js` — public reservation/drive-time APIs plus staff operations and Platform-owned Super Admin access.\n- `platform.js` — one-time ARKON Platform Super Admin handoff exchange; Cory does not own Super Admin credentials.\n- `inbound.js` — Platform-authenticated email ingress, idempotency, redaction, and identity/thread correlation.
- `email-agent.js` — bounded Platform AI interpretation plus deterministic clarification, explicit confirmation, 21+ attestation, and safe human fallback. AI never writes inventory or reservations.

## Canonical retail model

All new customer/reservation work belongs to `retail_*` tables. The old wholesale `customers`, `orders`, `order_items`, and related prototype tables are not dropped, but new deployments no longer create or write that competing domain through `db.js`.

Reservation lifecycle:

`NEW -> NEEDS_CLARIFICATION -> CONFIRMED -> PICKING -> READY -> COMPLETED`

Terminal exits are `CANCELLED`, `EXPIRED`, and `REJECTED`.

An ASAP confirmed reservation holds inventory for two hours. Scheduled pickup is same-day only in the store's Pacific time zone, and a scheduled reservation holds inventory until one hour after the promised pickup time. Scheduled requests without an exact pickup time go to `NEEDS_CLARIFICATION`; Cory does not invent a hold deadline.

## Inventory semantics

`product_variants.inventory_qty` is physical on-hand quantity. New reservations do not subtract it. Available-to-reserve quantity is:

`physical on-hand - active Cory holds`

Creating, releasing, consuming, receiving, damaging, or adjusting inventory writes an inventory event. Concurrent holds lock the SKU row so two customers cannot reserve the last unit.

## Omnichannel status

- Website: enabled.
- Email: inbound Platform events enter `/api/internal/provider-events/email`; outbound replies stay on ARKON Platform. Known, unambiguous customers can describe a basket in free text. Platform AI may only return a typed interpretation against Cory's live catalog. Cory asks targeted clarification, sends an exact basket summary, requires explicit `CONFIRM` plus a deterministic 21+ attestation, then rechecks stock under database locks before creating the hold. Unknown/ambiguous identities, low-confidence interpretations, sensitive data, and non-create requests go to staff.
- Voice: adapter boundary is ready; provider configuration is not enabled yet.
- SMS: policy-gated off until a US cannabis-permitted provider gives written approval and documented real-time inbound API/webhook support.
- WhatsApp: policy-gated off because current WhatsApp Business policy prohibits facilitating recreational-drug transactions.

All future channels normalize into the same conversation/customer/reservation engine. AI may interpret customer language, but it must not directly mutate inventory or bypass deterministic reservation rules.

## Google drive-time estimates

The pickup page can accept a starting address or optional browser geolocation. Address suggestions use Places API (New), and drive estimates use Routes API Compute Routes with traffic-aware routing. The starting location is sent to Google for the lookup and is not stored with the reservation.

Required variables:

```txt
GOOGLE_MAPS_API_KEY=
GOOGLE_STORE_PLACE_ID=        # recommended; BUSINESS_ADDRESS is fallback
```

Restrict the Google key to only the required Maps Platform APIs and to the production server environment.

## Required environment

```txt
DATABASE_URL=
SESSION_SECRET=               # at least 32 characters

SITE_NAME=
SITE_URL=
BUSINESS_ADDRESS=
BUSINESS_PHONE=
BUSINESS_EMAIL=
BUSINESS_LICENSE_NUMBER=
STORE_HOURS=

ADMIN_EMAIL=                 # local Store Admin only
ADMIN_PASSWORD_HASH=          # preferred over plaintext ADMIN_PASSWORD
STORE_ADMIN_NAME=

ARKON_PLATFORM_URL=https://platform.arkonsysai.com
ARKON_PLATFORM_SERVICE_KEY=
CORY_RUNTIME_KEY=cannabis-retail-shared
CORY_PLATFORM_CLIENT_COMPANY_ID=

GOOGLE_MAPS_API_KEY=
GOOGLE_STORE_PLACE_ID=
```

`ADMIN_EMAIL` is seeded only as `STORE_ADMIN`. Super Admin is never a Cory-owned account: an authenticated ARKON Platform operator enters through a short-lived Platform handoff, which Cory exchanges server-to-server before issuing a one-hour Cory admin session. Store Admin MFA enforcement still must be enabled before production.

## Run and validate

```bash
npm install
npm run check
npm start
```

The server initializes the base product schema, compliance schema, retail schema, legal controls, and Cory core schema in that order before accepting traffic.

## Production gates still required

Do not treat this branch as production-ready until these gates are completed:

1. PostgreSQL migration/restore test against a copy of production data.
2. Platform Super Admin MFA enforcement plus individual Store Admin/staff login flow.
3. Concurrency tests for last-unit holds, cancel/expire, and legacy-order migration.
4. Bind the Platform inbound EMAIL route to Cory `/api/internal/provider-events/email`, then complete first-time email-customer onboarding and automated email change/cancel/status flows. Voice provider configuration remains a separate gate.
5. Written/provider validation before any cannabis SMS integration; WhatsApp stays disabled under current policy.
6. Google Maps billing/API restrictions and production key configuration.
7. Backup/PITR, monitoring, retention, and alerting verification in the hosting environment.

## Legal boundary

The code intentionally blocks shipping/delivery fields and online cannabis payment. Cory records a pickup reservation and may store an in-store transaction/receipt reference at completion; it does not become the store's regulated POS in this version.
