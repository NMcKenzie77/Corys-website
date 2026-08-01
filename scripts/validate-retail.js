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
requireText('retail-server.js', "Disallow: /pickup", 'pickup checkout must stay out of the sitemap/index');

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
requireText('views/retail/layout.html', 'No online cannabis payment, shipping, or delivery', 'pickup-only limitation must be prominent');

const pickup = read('views/retail/pages/pickup.html');
requireText('views/retail/pages/pickup.html', 'name="ageConfirmed"', 'age confirmation is required');
requireText('views/retail/pages/pickup.html', 'name="privacyAccepted"', 'privacy acceptance is required');
requireText('views/retail/pages/pickup.html', 'name="marketingConsent"', 'marketing consent must be separate and optional');
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
  'Record the in-store POS receipt number',
  'Shipping, delivery, and online cannabis payment are not available',
  "marketingState, 2).toUpperCase() !== 'WA'"
].forEach((control) => {
  if (!legal.includes(control)) errors.push(`retail-legal-controls.js: missing control ${control}`);
});

requireText('views/retail/admin.html', 'name="advertisingReviewed"', 'staff must approve advertising compliance before activation');
requireText('views/retail/admin.html', 'data-v="acquisitionCost"', 'staff must record acquisition cost');
requireText('views/retail/admin.html', 'data-v="limitCategory"', 'staff must assign purchase-limit category');
requireText('views/retail/admin.html', 'name="idVerified"', 'staff completion form must record in-person ID verification');
requireText('views/retail/admin.html', 'name="posReceiptNumber"', 'staff completion form must record POS receipt');

const home = read('views/retail/pages/home.html');
forbidText('views/retail/pages/home.html', 'producer-processor', 'homepage must not describe a dispensary as a producer-processor');
forbidText('views/retail/pages/home.html', 'wholesale catalog', 'homepage must not contain wholesale calls to action');
requireText('views/retail/pages/home.html', 'No shipping. No delivery. No online cannabis payment.', 'homepage must state the retail boundary');

if (errors.length) {
  console.error('\nRetail validation failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log('Retail pickup, advertising, CRM, and compliance structure validated.');
