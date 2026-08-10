# Washington Dispensary Launch Checklist

This application supports an online menu and pickup reservations. It does not complete cannabis sales online, accept cannabis payment online, ship cannabis, or deliver cannabis to customers.

## 1. Production configuration

1. Add Railway PostgreSQL and expose `DATABASE_URL` to the web service.
2. Confirm the start command is `npm start` and `package.json` starts `retail-server.js`.
3. Add every production value from `.env.example`.
4. Use the verified dispensary trade name, physical licensed address, telephone, email, store hours, and Washington retail license number.
5. Set a final HTTPS `SITE_URL`.
6. Keep `ENABLE_INDEXING=false` through production testing.
7. Confirm `/healthz` reports:
   - `mode: WASHINGTON_RETAIL_PICKUP_ONLY`;
   - `database: true`;
   - `publicReady: true` before indexing.

## 2. Administrator security

1. Set `ADMIN_EMAIL`.
2. Generate a bcrypt password hash and set `ADMIN_PASSWORD_HASH`.
3. Set a random `SESSION_SECRET` containing at least 32 characters.
4. Do not use `ADMIN_PASSWORD` after launch.
5. Confirm `/admin` requires authentication.
6. Confirm admin and API responses include `X-Robots-Tag: noindex, nofollow, noarchive` and `Cache-Control: no-store`.

Generate a password hash:

```bash
node -e "console.log(require('bcryptjs').hashSync('REPLACE_WITH_PASSWORD', 12))"
```

## 3. Menu product setup

For every active product:

1. Enter the exact product and brand name.
2. Select the correct category and package format.
3. Copy cannabinoid information from the compliant package or approved source without adding health claims.
4. Upload accurate adult-oriented product imagery.
5. Confirm the image and copy do not use children, toys, cartoons, mascots, youth themes, or curative and therapeutic claims.
6. Check the advertising-review acknowledgment before making the product active.
7. Add each package SKU and barcode.
8. Record current acquisition cost.
9. Set regular and optional sale price at or above acquisition cost.
10. Add products and packages in Menu products, then record opening quantities and subsequent changes through the Inventory screen.
11. Assign the correct purchase-limit category and amount per package:
    - usable cannabis grams;
    - concentrate grams;
    - infused solid ounces;
    - infused liquid ounces; or
    - qualifying low-dose liquid THC milligrams.
12. Confirm the public menu displays only intended products and packages.

## 4. Pickup reservation test

1. Open `/menu` as a customer.
2. Confirm the 21+ gate appears in a fresh browser session.
3. Add products to the reservation.
4. Confirm no shipping address, delivery method, payment card, payment token, or online checkout field exists.
5. Attempt a quantity above a configured Washington purchase limit and confirm the reservation is rejected.
6. Submit a lawful test reservation.
7. Confirm inventory is reserved immediately.
8. Confirm the customer receives a reservation notice when Resend is configured.
9. Confirm staff sees the reservation in `/admin`.
10. Move the reservation through `NEW`, `CONFIRMED`, `PICKING`, and `READY`.
11. Confirm the ready notice instructs the customer to bring ID and pay in store.
12. Cancel a second test reservation and confirm inventory is restored.
13. Expire an unclaimed test reservation and confirm inventory is restored.
14. Receive stock, correct a physical count, and record damaged stock through the Inventory screen; confirm every change appears in the inventory ledger and audit log.
15. Attempt to reduce on-hand quantity below active pickup holds and confirm the update is rejected.
16. Confirm each package displays only `AVAILABLE` or `LOW STOCK` using the configured threshold.

## 5. In-store completion procedure

A reservation must not be marked `COMPLETED` until staff has:

1. Confirmed the customer is physically present at the licensed premises.
2. Inspected an acceptable, unexpired government-issued ID.
3. Confirmed the customer is legally eligible to purchase.
4. Rechecked purchase quantities in the authoritative POS and traceability workflow.
5. Collected payment in store through cash, Safe Harbor-supported payment, or another approved in-store provider.
6. Completed the authoritative POS and required traceability records.
7. Entered the POS receipt number in the website admin.
8. Checked the in-person ID-verification box.
9. Recorded the in-store payment provider.
10. Marked the reservation `COMPLETED` only during lawful Washington retail sales hours and actual store operating hours.

The website stores only the ID-verification timestamp. Do not upload, photograph, scan, or type government-ID numbers into the website.

## 6. POS and traceability boundary

The website is not the regulatory system of record. Before launch:

1. Identify the authoritative cannabis POS and Washington traceability workflow used by the store.
2. Create a written reconciliation procedure between web reservations, reserved inventory, completed POS receipts, cancellations, expirations, returns, recalls, and adjustments.
3. Confirm staff knows that the website's inventory is customer-facing availability, not a replacement for required traceability records.
4. Confirm recalled, quarantined, expired, or otherwise restricted products are immediately removed from the public menu.
5. Confirm all completed reservations have a matching POS receipt and lawful traceability record.

## 7. Customer CRM and privacy

1. Submit a reservation without marketing consent and confirm the customer is not opted in.
2. Submit a reservation with the separate Washington-resident marketing consent and confirm the customer is marked `WA` and opted in.
3. Confirm staff cannot enable marketing without documenting Washington residency.
4. Confirm unsubscribe suppresses future marketing.
5. Confirm transactional pickup messages can still be sent after marketing opt-out.
6. Submit access, correction, deletion, and marketing-opt-out requests through `/privacy`.
7. Confirm requests appear under `/admin#compliance`.
8. Verify identity before disclosing, correcting, or deleting information.
9. Retain records required for licensing, transactions, tax, audit, security, fraud prevention, and legal obligations.
10. Never store payment-card numbers, passwords, government-ID images, or unnecessary health information.

## 8. Marketing campaign test

1. Configure `RESEND_API_KEY`, `EMAIL_FROM`, `BUSINESS_POSTAL_ADDRESS`, and the final `SITE_URL`.
2. Verify the sending domain.
3. Create a draft campaign.
4. Confirm campaign creation blocks obvious curative or therapeutic claims and youth-targeting language.
5. Confirm the audience contains only opted-in Washington contacts who have not unsubscribed.
6. Send only to controlled test contacts first.
7. Confirm every email contains:
   - accurate sender and subject information;
   - an advertising and 21+ disclosure;
   - all four Washington cannabis warnings;
   - the valid postal address;
   - a working unsubscribe link.
8. Confirm bulk marketing is never sent automatically by the automation worker.
9. Review every image, price, statement, audience, promotion, and offer before approval.

Do not publish content that is false or misleading, promotes overconsumption, claims curative or therapeutic effects, depicts alcohol, tobacco, nicotine, motor vehicles, youth, toys, cartoons, or youth-oriented themes, targets people outside Washington, prices cannabis below acquisition cost, or offers prohibited giveaways.

## 9. Automation test

1. Lower one package below the configured threshold and confirm a low-inventory alert appears.
2. Restore inventory and confirm the alert resolves.
3. Age a test reservation and confirm the stalled-order alert appears.
4. Mark a test order ready and age it beyond the threshold to confirm the unclaimed-order alert.
5. Confirm lapsed-customer automation creates a campaign draft only and never sends it.
6. Configure `AUTOMATION_ALERT_EMAIL` and test the daily internal digest.
7. Confirm automation run history and errors are visible.

## 10. Public website and search

1. Confirm the homepage, menu, privacy, terms, accessibility, and 404 pages render on desktop and mobile.
2. Confirm all four required Washington cannabis warnings appear visibly on every public page.
3. Confirm warning text is at least 10 percent of the largest advertising type.
4. Confirm the site states 21+ and does not target people outside Washington.
5. Confirm the menu has no medical or therapeutic claims.
6. Confirm `/pickup`, `/admin`, `/api/`, and `/healthz` are not indexed.
7. Confirm canonical URLs, structured data, robots.txt, and sitemap.xml use the final HTTPS domain.
8. Add `GOOGLE_SITE_VERIFICATION` and verify Search Console.
9. Set `ENABLE_INDEXING=true` only after every compliance and readiness metric is clear.
10. Submit `/sitemap.xml` and inspect `/` and `/menu` in Search Console.

## 11. Final approval

Before opening the reservation system to customers, obtain review from the store's Washington cannabis compliance professional or attorney for the final store-specific configuration, local rules, payment setup, promotions, privacy notice, marketing practices, POS workflow, and traceability procedure.
