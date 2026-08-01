# Wholesale Commerce Launch Checklist

## Railway

1. Add a PostgreSQL service and expose `DATABASE_URL` to the web service.
2. Set the service start command to `npm start`.
3. Add every required variable from `.env.example`.
4. Keep `ENABLE_INDEXING=false` until the live domain, products, license information, contact information, and marketing footer have been verified.
5. Confirm `/healthz` returns `{ "ok": true, "database": true }`.

## Admin access

1. Set `ADMIN_EMAIL`.
2. Generate a bcrypt password hash and set `ADMIN_PASSWORD_HASH`.
3. Set a random `SESSION_SECRET` of at least 32 characters.
4. Open `/admin` and verify login.
5. Open `/admin/crm` and verify the same login works.
6. Open `/admin/marketing` and verify the same login works.

Generate a password hash locally:

```bash
node -e "console.log(require('bcryptjs').hashSync('REPLACE_WITH_PASSWORD', 12))"
```

## Product images

Set the three Cloudinary variables so Cory can upload images from the product editor. Without Cloudinary, the admin can still paste a hosted image URL.

## Transactional and marketing email

1. Set `RESEND_API_KEY`, `EMAIL_FROM`, and `SALES_EMAIL`.
2. Verify the sending domain in Resend.
3. Set `BUSINESS_POSTAL_ADDRESS` to the valid business street address, registered PO box, or qualifying commercial mailbox used in every marketing email.
4. Confirm `SITE_URL` is the final HTTPS domain so unsubscribe links work.
5. Confirm `/admin/marketing` shows email delivery as configured.

## Retailer CRM test

1. Open `/admin/crm`.
2. Add one shop manually with a Washington cannabis retail license number.
3. Add a primary buyer or general-manager contact.
4. Log a call, email, visit, or meeting.
5. Add a dated follow-up and confirm it appears on the Follow-ups screen when due.
6. Move the account through UNCONTACTED, CONTACTED, FOLLOW_UP, SAMPLE_REQUESTED, NEGOTIATING, and CUSTOMER as appropriate.
7. Confirm an existing wholesale order with the same license number appears in the account's Orders tab.
8. Export the CRM CSV and confirm the shop, stage, source, and next action are present.
9. Test a small CSV import using a source that is documented as lawful for commercial outreach.
10. Confirm the import records the source name, URL, source date, usage basis, inserted rows, updated rows, and rejected rows.
11. Confirm `Active` and `Pending (Issued)` records are treated as active license statuses.
12. Confirm license refreshes do not overwrite Cory's sales stage, notes, contacts, activity, or tasks.
13. Do not automatically add CRM accounts to bulk campaigns. Add a contact to campaigns only after explicit, documented marketing consent.

## CRM source controls

The LCB license list can be used to verify whether an individual business appears licensed and whether its privilege status is active. The LCB public-records page warns that records received through the Public Records Act may not be used for commercial purposes and currently warns of possible list errors. Before importing any statewide list for outreach:

- document the source and source date;
- document why the source may lawfully be used for commercial outreach;
- retain the source URL and import batch;
- verify important license records individually before relying on them;
- keep license verification separate from bulk-email consent;
- preserve do-not-contact and unsubscribe records.

## Product and order test

1. Create a product with at least one package variant, SKU, price, and inventory quantity.
2. Verify the product appears at `/shop`.
3. Add the product to the cart and submit a test order using a Washington business address.
4. Confirm inventory decreases.
5. Confirm the order appears in `/admin` with the buyer, products, quantities, destination, license number, and total.
6. Update the order through APPROVED, PACKING, READY_FOR_CARRIER, SHIPPED, and DELIVERED.
7. Confirm carrier, tracking/route, and manifest fields persist.
8. Submit a second test order and cancel it. Confirm inventory is restored.

## Marketing campaign test

1. Submit a test checkout with the marketing opt-in selected.
2. Confirm the retailer appears in `/admin/marketing` as subscribed.
3. Add one additional lawful Washington test contact manually.
4. Create a draft using the New Product, Restock, or Availability template.
5. Count the audience and confirm only subscribed Washington contacts are included.
6. Send the campaign to the test audience.
7. Confirm the email includes:
   - accurate sender and subject information;
   - a clear advertisement disclosure;
   - a visible 21+ notice;
   - all four Washington cannabis warnings;
   - the valid physical postal address;
   - a working unsubscribe link.
8. Use the unsubscribe link and confirm the contact changes to UNSUBSCRIBED.
9. Confirm a later campaign excludes that contact.
10. Test CSV import only with contacts whose marketing status and Washington business location are documented.

## Marketing content restrictions

Before sending, review every campaign for the current Washington rules. Do not publish content that:

- is false or misleading;
- promotes overconsumption;
- makes curative or therapeutic claims;
- depicts alcohol, tobacco, nicotine, motor vehicles, youth, toys, cartoons, or youth-oriented imagery;
- specifically targets people outside Washington;
- advertises a product below lawful cost restrictions;
- advertises prohibited giveaways.

The platform inserts required warnings and unsubscribe controls, but Cory remains responsible for the campaign subject, copy, audience source, images, pricing claims, and license compliance.

## Compliance boundary

The system is configured for licensed Washington business-to-business orders. It does not accept online payment and rejects delivery destinations outside Washington. Product fulfillment must still follow Cory's license privileges, Washington traceability requirements, and authorized transportation procedures.

## Before enabling indexing

- Replace `YOUR BRAND` and all contact placeholders.
- Publish real license and business information only after verification.
- Add real product photography and descriptions.
- Confirm cannabis warnings in the age gate and footer.
- Confirm privacy and terms content.
- Test desktop and mobile ordering.
- Test CRM account import, outreach history, tasks, orders, and source controls.
- Test campaign creation, delivery, and unsubscribe behavior.
- Set `ENABLE_INDEXING=true` only after final approval.
