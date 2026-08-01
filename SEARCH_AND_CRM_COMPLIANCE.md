# Google Search and CRM Compliance Guide

## Scope

This guide covers:

- technical eligibility and readiness for Google organic search;
- privacy, consent, security, and operating controls for the retailer CRM;
- the distinction between organic search and paid Google Ads.

It is an implementation guide, not a legal opinion. Cory remains responsible for verified business and license information, lawful data sources, regulatory recordkeeping, and current Washington cannabis requirements.

## Google organic search

The application now includes:

- unique page titles and descriptions;
- canonical URLs;
- robots meta controls;
- an environment-controlled robots.txt file;
- an XML sitemap containing only indexable pages;
- Organization, WebSite, WebPage, and CollectionPage JSON-LD;
- a Google Search Console verification variable;
- HTTPS-only launch readiness;
- crawl protection for admin, API, health, cart, and error pages;
- legal, privacy, and accessibility pages linked from the footer;
- a CI check for missing metadata, launch placeholders, legal links, and consent controls.

### Indexing lock

`ENABLE_INDEXING=true` is not enough by itself. The server keeps the entire public site `noindex` unless all of the following are configured:

- `SITE_NAME`
- `SITE_URL` using HTTPS
- `BUSINESS_EMAIL`
- `BUSINESS_PHONE`
- `BUSINESS_ADDRESS`
- `BUSINESS_LICENSE_NUMBER`
- `PRIVACY_EMAIL` or `ADMIN_EMAIL`

This prevents Google from indexing placeholder branding, contact information, or license data.

### Search Console launch sequence

1. Configure the final HTTPS domain.
2. Replace all business and license environment values with verified information.
3. Add the Search Console verification value to `GOOGLE_SITE_VERIFICATION`.
4. Keep `ENABLE_INDEXING=false` during production testing.
5. Test the public pages, robots.txt, sitemap.xml, canonical URLs, and structured data.
6. Set `ENABLE_INDEXING=true` only after the Compliance Center shows all readiness items complete.
7. Submit `/sitemap.xml` in Google Search Console.
8. Inspect the homepage and `/shop` with URL Inspection.
9. Monitor indexing, security, manual actions, and structured-data reports.

## Google Ads limitation

Google organic search and Google Ads are separate products. A technically sound, indexable cannabis website is not automatically eligible for paid advertising.

Google Ads generally prohibits ads for marijuana, substances that induce a recreational high, cannabis shops, and services that facilitate recreational drug purchases in the United States. Do not represent this platform as Google Ads approved. Organic SEO, direct retailer outreach, consented email, industry directories, events, and compliant social strategies require separate channel review.

## CRM privacy and consent controls

The platform now includes:

- separate CRM account coverage and marketing consent;
- source name, source URL, source date, and commercial-use basis on imports;
- do-not-contact and unsubscribe suppression;
- required privacy acceptance for inquiries and wholesale orders;
- separate optional marketing consent;
- immutable consent records with notice version, timestamp, source path, and hashed request fingerprint;
- privacy access, correction, deletion, opt-out, and other request intake;
- an administrator Compliance Center for verification, processing, and resolution notes;
- admin/API no-index headers and no-store caching;
- secure cookies, password hashing support, rate limits, security headers, CSP, HSTS in production, and restricted browser permissions;
- no payment-card collection;
- language directing users not to submit passwords, payment data, or sensitive health information.

## Privacy request process

1. A person submits a request through `/privacy`.
2. The system stores the request and issues a reference number.
3. The privacy contact receives an internal notification when Resend is configured.
4. Cory verifies identity and authority before disclosing, correcting, or deleting records.
5. The request is moved through `OPEN`, `VERIFYING`, `IN_PROGRESS`, and `COMPLETED` or `DENIED`.
6. Verification and resolution notes are retained in the Compliance Center.
7. Records required for orders, licensing, taxes, audit, security, fraud prevention, or regulatory obligations are not deleted merely because a request was submitted.

## Required Railway variables

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
PRIVACY_EMAIL
DATABASE_URL
ADMIN_EMAIL
ADMIN_PASSWORD_HASH
SESSION_SECRET
RESEND_API_KEY
EMAIL_FROM
BUSINESS_POSTAL_ADDRESS
```

## Production tests

- Confirm `/healthz` reports `publicReady: true`.
- Confirm public pages remain `noindex` while `ENABLE_INDEXING=false`.
- Confirm indexing remains blocked when one required public business variable is removed.
- Confirm `/robots.txt` blocks all crawling before launch.
- Confirm the live robots.txt allows public pages and disallows `/admin`, `/api/`, and `/healthz` after launch.
- Confirm `/sitemap.xml` excludes `/cart` and 404 pages.
- Confirm public pages have one canonical URL and valid JSON-LD.
- Confirm inquiry and order submission fail without privacy acceptance.
- Confirm successful submissions create consent records.
- Confirm marketing remains optional and unsubscribe suppression works.
- Confirm a privacy request appears in `/admin/compliance` and can be updated.
- Confirm admin and API responses include `X-Robots-Tag: noindex, nofollow, noarchive`.
- Confirm the GitHub `Validate wholesale platform` workflow passes.
