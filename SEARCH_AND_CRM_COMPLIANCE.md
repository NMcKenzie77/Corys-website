# Dispensary Search, Customer CRM, and Privacy Guide

## Scope

This guide covers:

- Google organic-search readiness for a licensed Washington dispensary;
- customer CRM, consent, privacy, and security controls;
- the separation between an online pickup reservation and an in-store cannabis sale;
- the distinction between organic search and paid Google advertising.

This is an implementation guide, not a legal opinion. The licensee remains responsible for current Washington requirements, local rules, verified license information, POS and traceability records, staff procedures, marketing review, and professional legal or compliance advice.

## Organic Google search

The retail server includes:

- unique titles and descriptions for the homepage, menu, privacy, terms, and accessibility pages;
- canonical URLs;
- Store, WebSite, WebPage, and CollectionPage structured data;
- environment-controlled robots.txt and sitemap.xml;
- Search Console verification support;
- no-index controls for pickup checkout, staff administration, APIs, health checks, and error pages;
- an indexing lock that prevents placeholder business data from becoming public;
- CI validation for age-gate, warnings, pickup boundaries, consent controls, and production entry point.

### Indexing lock

`ENABLE_INDEXING=true` does not enable indexing by itself. The server also requires:

- verified `SITE_NAME`;
- HTTPS `SITE_URL`;
- `BUSINESS_EMAIL`;
- `BUSINESS_PHONE`;
- physical licensed `BUSINESS_ADDRESS`;
- verified `BUSINESS_LICENSE_NUMBER`;
- `STORE_HOURS`;
- `PRIVACY_EMAIL` or `ADMIN_EMAIL`.

### Search Console launch sequence

1. Configure the final HTTPS domain.
2. Enter verified public store and license information.
3. Set `GOOGLE_SITE_VERIFICATION`.
4. Keep `ENABLE_INDEXING=false` during live testing.
5. Confirm the homepage and `/menu` display accurate store information, products, prices, warnings, and pickup limitations.
6. Confirm `/pickup`, `/admin`, `/api/`, and `/healthz` remain excluded.
7. Confirm structured data, canonical URLs, robots.txt, and sitemap.xml use the final domain.
8. Set `ENABLE_INDEXING=true` only after `/admin#compliance` and `/healthz` show readiness.
9. Submit `/sitemap.xml` in Search Console.
10. Inspect `/` and `/menu` and monitor indexing, security, manual actions, and structured-data reports.

## Paid Google Ads limitation

Organic search and Google Ads are separate. Technical search readiness does not make marijuana advertising eligible for Google Ads. Do not describe the dispensary or website as Google Ads approved. Review every advertising channel separately under its current cannabis policies and Washington law.

## Public advertising controls

The website includes:

- a 21+ age gate;
- a prominent pickup-only and pay-in-store disclosure;
- the four Washington cannabis warnings on every public page;
- warning text sized above 10 percent of the largest advertising type;
- copy controls blocking obvious curative or therapeutic claims;
- copy controls blocking obvious youth-targeting language;
- staff acknowledgment that product names, descriptions, and images were reviewed;
- Washington-focused content and Washington-resident marketing consent;
- acquisition-cost controls preventing menu prices and sale prices below recorded acquisition cost.

Automated text checks cannot determine whether every image, design, product name, promotion, or context is legally acceptable. Staff must review each active product and campaign.

## Online reservation boundary

The website:

- displays a menu;
- accepts pickup reservations;
- reserves website inventory;
- sends reservation and ready notices;
- requires a customer age confirmation;
- requires privacy acceptance;
- checks configured package equivalencies against purchase limits.

The website does not:

- complete a cannabis sale;
- accept online cannabis payment;
- collect payment-card credentials;
- ship cannabis;
- deliver cannabis;
- replace in-store ID verification;
- replace the store's POS or required traceability workflow.

Staff completion requires an in-person ID-verification confirmation and POS receipt number. The system stores the verification timestamp, not an ID image or ID number.

## Customer CRM controls

The customer CRM contains:

- name, email, and telephone;
- pickup reservation and completed-order history;
- internal customer-service notes;
- order count, spend total, and last-order date;
- optional marketing consent;
- documented Washington marketing state;
- unsubscribe suppression;
- privacy-request records.

The CRM is not a list of licensed shops and does not import the statewide retailer database. It is a customer relationship system for people who interact with this dispensary.

## Marketing consent

- Marketing consent is optional and separate from pickup reservation acceptance.
- A customer may reserve products without joining marketing.
- Marketing opt-in is limited to documented Washington residents.
- Unsubscribed customers remain suppressed.
- Transactional pickup messages may still be sent after marketing opt-out.
- Automation may create drafts but never sends bulk marketing automatically.
- Staff must approve each campaign and its audience.

## Privacy and security controls

The platform includes:

- privacy acceptance on pickup reservations;
- versioned consent records;
- hashed request fingerprints rather than raw IP storage in consent records;
- access, correction, deletion, marketing-opt-out, and other request intake;
- identity verification and resolution notes for privacy requests;
- no-store caching and no-index headers for staff and API surfaces;
- secure, HTTP-only administrator sessions;
- password-hash support;
- rate limiting;
- Content Security Policy, HSTS in production, and restricted browser permissions;
- no online payment-card collection;
- instructions not to submit government-ID images, passwords, payment data, or unnecessary health information.

## Privacy request process

1. A person submits a request through `/privacy`.
2. The system creates a reference number.
3. The privacy contact receives an internal notice when email is configured.
4. Staff verifies identity and authority before disclosure, correction, or deletion.
5. Staff moves the request through `OPEN`, `VERIFYING`, `IN_PROGRESS`, and `COMPLETED` or `DENIED`.
6. Verification and resolution notes are retained.
7. Records required for completed sales, POS reconciliation, licensing, tax, audit, security, fraud prevention, or legal obligations may be retained.

## Required environment values

```text
SITE_NAME
SITE_URL
OG_IMAGE
GOOGLE_SITE_VERIFICATION
ENABLE_INDEXING
BUSINESS_EMAIL
BUSINESS_PHONE
BUSINESS_ADDRESS
BUSINESS_LICENSE_NUMBER
BUSINESS_POSTAL_ADDRESS
STORE_HOURS
PICKUP_WINDOWS
PICKUP_INSTRUCTIONS
PRIVACY_EMAIL
DATABASE_URL
ADMIN_EMAIL
ADMIN_PASSWORD_HASH
SESSION_SECRET
RESEND_API_KEY
EMAIL_FROM
AUTOMATION_ALERT_EMAIL
AUTOMATION_TIME_ZONE
```

## Production tests

- Confirm `/healthz` reports `mode: WASHINGTON_RETAIL_PICKUP_ONLY` and `publicReady: true`.
- Confirm pages remain `noindex` while `ENABLE_INDEXING=false`.
- Confirm indexing remains blocked when any required public store value is absent.
- Confirm `/sitemap.xml` excludes `/pickup`, admin, API, and error pages.
- Confirm the 21+ gate and four warnings appear.
- Confirm pickup submission has no address, delivery, shipping, card, or online-payment field.
- Confirm over-limit reservations are rejected.
- Confirm active product pricing cannot fall below recorded acquisition cost.
- Confirm order completion fails without in-store ID verification and a POS receipt number.
- Confirm marketing remains optional and Washington-only.
- Confirm unsubscribe suppression.
- Confirm a privacy request appears under `/admin#compliance` and can be processed.
- Confirm the `Validate dispensary retail platform` workflow passes.
