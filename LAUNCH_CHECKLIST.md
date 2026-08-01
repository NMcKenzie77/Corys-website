# Wholesale Commerce Launch Checklist

## Railway

1. Add a PostgreSQL service and expose `DATABASE_URL` to the web service.
2. Set the service start command to `npm start`.
3. Add every required variable from `.env.example`.
4. Keep `ENABLE_INDEXING=false` until the live domain, products, license information, and contact information have been verified.
5. Confirm `/healthz` returns `{ "ok": true, "database": true }`.

## Admin access

1. Set `ADMIN_EMAIL`.
2. Generate a bcrypt password hash and set `ADMIN_PASSWORD_HASH`.
3. Set a random `SESSION_SECRET` of at least 32 characters.
4. Open `/admin` and verify login.

Generate a password hash locally:

```bash
node -e "console.log(require('bcryptjs').hashSync('REPLACE_WITH_PASSWORD', 12))"
```

## Product images

Set the three Cloudinary variables so Cory can upload images from the product editor. Without Cloudinary, the admin can still paste a hosted image URL.

## Email

Set `RESEND_API_KEY`, `EMAIL_FROM`, and `SALES_EMAIL`. Verify the sending domain in Resend before launch.

## Product and order test

1. Create a product with at least one package variant, SKU, price, and inventory quantity.
2. Verify the product appears at `/shop`.
3. Add the product to the cart and submit a test order using a Washington business address.
4. Confirm inventory decreases.
5. Confirm the order appears in `/admin` with the buyer, products, quantities, destination, license number, and total.
6. Update the order through APPROVED, PACKING, READY_FOR_CARRIER, SHIPPED, and DELIVERED.
7. Confirm carrier, tracking/route, and manifest fields persist.
8. Submit a second test order and cancel it. Confirm inventory is restored.

## Compliance boundary

The system is configured for licensed Washington business-to-business orders. It does not accept online payment and rejects delivery destinations outside Washington. Product fulfillment must still follow Cory's license privileges, Washington traceability requirements, and authorized transportation procedures.

## Before enabling indexing

- Replace `YOUR BRAND` and all contact placeholders.
- Publish real license and business information only after verification.
- Add real product photography and descriptions.
- Confirm cannabis warnings in the age gate and footer.
- Confirm privacy and terms content.
- Test desktop and mobile ordering.
- Set `ENABLE_INDEXING=true` only after final approval.
