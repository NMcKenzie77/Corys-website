'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const errors = [];
const requireText = (file, text, message) => {
  if (!read(file).includes(text)) errors.push(`${file}: ${message}`);
};
const forbidText = (file, text, message) => {
  if (read(file).includes(text)) errors.push(`${file}: ${message}`);
};

const packageJson = JSON.parse(read('package.json'));
if (packageJson.scripts.start !== 'node retail-server.js') {
  errors.push('package.json: production start command must run retail-server.js');
}

[
  'retail-server.js',
  'retail-api.js',
  'retail-legal-controls.js',
  'retail-compliance-api.js',
  'views/retail/layout.html',
  'views/retail/pages/home.html',
  'views/retail/pages/menu.html',
  'views/retail/pages/pickup.html',
  'views/retail/pages/privacy.html',
  'views/retail/pages/terms.html',
  'views/retail/admin.html',
  'public/js/retail-site.js',
  'public/js/retail-menu.js',
  'public/js/retail-pickup.js',
  'public/js/retail-admin.js'
].forEach((file) => {
  if (!fs.existsSync(path.join(root, file))) errors.push(`${file}: required retail file is missing`);
});

forbidText('retail-server.js', 'registerCommerce(', 'wholesale commerce routes must not be registered');
forbidText('retail-server.js', 'registerCrm(', 'retailer-account CRM must not be registered');
forbidText('retail-server.js', 'registerMarketing(', 'wholesale marketing must not be registered');
requireText('retail-server.js', "mode: 'WASHINGTON_RETAIL_PICKUP_ONLY'", 'health check must identify pickup-only retail mode');
requireText('retail-server.js', "app.get('/menu'", 'public menu route is required');
requireText('retail-server.js', "app.get('/pickup'", 'pickup reservation route is required');
requireText('retail-server.js', 'Disallow: /pickup', 'pickup checkout must stay out of the sitemap/index');

const layout = read('views/retail/layout.html');
[
  'This product has intoxicating effects and may be habit forming.',
  'Cannabis can impair concentration, coordination, and judgment.',
  'There may be health risks associated with consumption of this product.',
  'For use only by adults 21 and older. Keep out of the reach of children.'
].forEach((warning) => {
  if (!layout.includes(warning)) errors.push(`views/retail/layout.html: missing required warning: ${warning}`);
});
requireText('views/retail/layout.html', 'data-age-gate', '21+ age gate is required');
requireText('views/retail/layout.html', 'data-age-exit', 'age gate must provide an explicit exit action');
requireText('views/retail/layout.html', 'aria-describedby="age-description age-legal"', 'age gate must expose its explanation to assistive technology');
requireText('views/retail/layout.html', 'data-site-shell inert aria-hidden="true"', 'public content must start inaccessible until the gate passes');
requireText('views/retail/layout.html', 'Entering this website does not verify your identity or age for pickup.', 'age gate must distinguish browsing access from in-store verification');
requireText('views/retail/layout.html', 'No online cannabis payment, shipping, or delivery', 'pickup-only limitation must be prominent');
requireText('public/js/retail-site.js', "sessionStorage.getItem(AGE_KEY)", 'age approval must be scoped to the browser tab session');
requireText('public/js/retail-site.js', "sessionStorage.setItem(AGE_KEY, 'yes')", 'age approval must be recorded only for the browser tab session');
requireText('public/js/retail-site.js', 'trapGateFocus', 'age gate must contain keyboard focus while open');
forbidText('public/js/retail-site.js', "localStorage.setItem(AGE_KEY", 'age approval must not persist indefinitely in local storage');
forbidText('public/js/retail-site.js', "localStorage.getItem(AGE_KEY", 'age approval must not be read from indefinite local storage');

const pickup = read('views/retail/pages/pickup.html');
requireText('views/retail/pages/pickup.html', 'name="ageConfirmed"', 'age confirmation is required');
requireText('views/retail/pages/pickup.html', 'entering this website did not verify my age or identity', 'pickup must explicitly reconfirm age separately from the entry gate');
requireText('cory-core/reservations.js', "if (!bool(body.ageConfirmed))", 'reservation API must reject missing 21+ attestation');
requireText('views/retail/pages/pickup.html', 'name="privacyAccepted"', 'privacy acceptance is required');
requireText('views/retail/pages/pickup.html', 'name="marketingConsent"', 'marketing consent must be separate and optional');
requireText('views/retail/pages/pickup.html', 'Submit pickup request', 'submission must be labeled as a pickup request');
requireText('views/retail/pages/pickup.html', 'No sale, payment, ownership transfer, or guaranteed pickup is created online.', 'pickup submission must state the legal boundary');
requireText('public/js/retail-menu.js', 'Add to pickup request', 'menu actions must not look like online purchase buttons');
requireText('public/js/retail-pickup.js', 'Pickup request ', 'confirmation must identify the submission as a request');
requireText('public/js/retail-pickup.js', 'This is not a completed cannabis sale.', 'confirmation must state that no online sale occurred');
requireText('public/js/retail-pickup.js', "result.body.transactionType !== 'PICKUP_RESERVATION_REQUEST'", 'browser must verify the API transaction type');
requireText('public/js/retail-pickup.js', "result.body.saleCompleted !== false", 'browser must verify the API sale boundary');
requireText('cory-core/reservations.js', "transactionType: 'PICKUP_RESERVATION_REQUEST'", 'API response must identify a reservation request');
requireText('cory-core/reservations.js', 'saleCompleted: false', 'API response must state that no sale was completed');
requireText('cory-core/reservations.js', "paymentDue: 'IN_STORE'", 'API response must keep payment in store');
requireText('cory-core/reservations.js', "idVerification: 'IN_STORE_REQUIRED'", 'API response must keep ID verification in store');
requireText('cory-core/reservations.js', 'customerShouldWaitForReadyNotice: true', 'API must tell the customer to wait for store readiness');
['address1', 'postalCode', 'cardNumber', 'paymentToken', 'deliveryAddress', 'shippingAddress'].forEach((field) => {
  if (pickup.includes(`name="${field}"`)) errors.push(`views/retail/pages/pickup.html: forbidden online sale/shipping field ${field}`);
});

const legal = read('retail-legal-controls.js');
[
  'USABLE_CANNABIS_GRAMS: 28.3495',
  'CONCENTRATE_GRAMS: 7',
  'INFUSED_SOLID_OUNCES: 16',
  'INFUSED_LIQUID_OUNCES: 72',
  'INFUSED_LIQUID_LOW_DOSE_THC_MG: 200',
  'cannot be priced below its current acquisition cost',
  'Verify an acceptable, unexpired government-issued ID',
  'Record the in-store transaction or receipt reference before completing the pickup.',
  'Shipping, delivery, and online cannabis payment are not available',
  "marketingState, 2).toUpperCase() !== 'WA'",
  'OVERCONSUMPTION_PATTERN',
  'ASSOCIATION_PATTERN',
  'FALSE_ENDORSEMENT_PATTERN',
  'MISLEADING_PATTERN',
  "validateAdvertisingCopy(combined, 'Public cannabis product copy')",
  "validateAdvertisingCopy(copy, 'Campaign copy')",
  "if (!bool(body.advertisingReviewed))"
].forEach((control) => {
  if (!legal.includes(control)) errors.push(`retail-legal-controls.js: missing control ${control}`);
});

requireText('views/retail/layout.html', 'This website and its advertising are intended only for Washington adults 21+', 'every public page must carry a prominent 21+ advertising notice');
requireText('views/retail/layout.html', 'aria-label="Adults only and pickup-only notice"', 'sitewide advertising notice must be exposed to assistive technology');
requireText('views/retail/admin.html', 'name="advertisingReviewed"', 'staff must approve advertising compliance before activation');
requireText('views/retail/admin.html', 'name="advertisingReviewed" required><span>I reviewed the campaign', 'campaign drafts require a separate advertising review attestation');
requireText('views/retail/admin.html', 'do not encourage overconsumption', 'staff review language must cover overconsumption');
requireText('views/retail/admin.html', 'government endorsement', 'staff review language must cover false government endorsement');
requireText('views/retail/admin.html', 'alcohol, tobacco, nicotine, or unsafe driving', 'staff review language must cover prohibited associations');
requireText('public/js/retail-admin.js', 'data-v="acquisitionCost"', 'staff must record acquisition cost');
requireText('public/js/retail-admin.js', 'data-v="limitCategory"', 'staff must assign purchase-limit category');
requireText('views/retail/admin.html', 'name="idVerified"', 'staff completion form must record in-person ID verification');
requireText('views/retail/admin.html', 'name="posReceiptNumber"', 'staff completion form must record POS receipt');
requireText('views/retail/admin.html', 'data-admin-panel="inventory"', 'staff inventory screen is required');
requireText('views/retail/admin.html', 'data-inventory-form', 'staff inventory adjustment form is required');
requireText('public/js/retail-admin.js', '/api/admin/cory/inventory/', 'inventory updates must use the Cory inventory ledger API');
requireText('cory-core/inventory.js', 'assertAdjustmentRespectsHolds', 'inventory adjustments must protect active pickup holds');
requireText('cory-core/inventory.js', "'LOW STOCK'", 'inventory must expose the locked LOW STOCK status');
requireText('public/js/retail-menu.js', 'variant.status', 'the public menu must use the locked inventory status labels');
forbidText('public/js/retail-menu.js', "Number(variant.inventoryQty || 0) + ' available'", 'the public menu must not expose exact inventory counts');
forbidText('retail-api.js', 'inventory_qty=EXCLUDED.inventory_qty', 'product editing must not overwrite existing on-hand inventory');

const home = read('views/retail/pages/home.html');
forbidText('views/retail/pages/home.html', 'producer-processor', 'homepage must not describe a dispensary as a producer-processor');
forbidText('views/retail/pages/home.html', 'wholesale catalog', 'homepage must not contain wholesale calls to action');
requireText('views/retail/pages/home.html', 'No shipping. No delivery. No online cannabis payment.', 'homepage must state the retail boundary');

if (errors.length) {
  console.error('\nRetail validation failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log('Retail pickup, advertising, CRM, and compliance structure validated.');
