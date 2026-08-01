'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pagesDir = path.join(root, 'views', 'pages');
const errors = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function requireText(content, expected, file, message) {
  if (!content.includes(expected)) errors.push(`${file}: ${message}`);
}

const publicFiles = fs.readdirSync(pagesDir).filter((file) => file.endsWith('.html'));
for (const file of publicFiles) {
  const content = fs.readFileSync(path.join(pagesDir, file), 'utf8');
  if (file !== '404.html') {
    if (!/^\s*<!--[\s\S]*?title:\s*.+/i.test(content)) errors.push(`${file}: missing title metadata`);
    if (!/^\s*<!--[\s\S]*?description:\s*.+/i.test(content)) errors.push(`${file}: missing description metadata`);
    if (!/^\s*<!--[\s\S]*?robots:\s*.+/i.test(content)) errors.push(`${file}: missing robots metadata`);
  }
  if (/\[(EMAIL|PHONE|ADDRESS|LICENSE\s*#?)\]/i.test(content)) errors.push(`${file}: contains a public launch placeholder`);
}

const layout = read('views/layout.html');
requireText(layout, 'name="description"', 'views/layout.html', 'missing meta description');
requireText(layout, 'name="robots"', 'views/layout.html', 'missing robots meta tag');
requireText(layout, 'rel="canonical"', 'views/layout.html', 'missing canonical link');
requireText(layout, 'application/ld+json', 'views/layout.html', 'missing JSON-LD structured data');
requireText(layout, '{{googleSiteVerificationTag}}', 'views/layout.html', 'missing Google verification slot');

const footer = read('views/partials/footer.html');
['/privacy', '/terms', '/accessibility'].forEach((href) => {
  requireText(footer, `href="${href}"`, 'views/partials/footer.html', `missing ${href} link`);
});
['{{businessAddress}}', '{{businessEmail}}', '{{businessPhone}}', '{{businessLicenseNumber}}'].forEach((token) => {
  requireText(footer, token, 'views/partials/footer.html', `missing ${token} public business field`);
});

const index = read('views/pages/index.html');
requireText(index, 'name="privacyAccepted"', 'views/pages/index.html', 'inquiry form must require privacy acceptance');
requireText(index, 'href="/privacy"', 'views/pages/index.html', 'inquiry consent must link to Privacy Notice');
requireText(index, 'href="/terms"', 'views/pages/index.html', 'inquiry consent must link to Terms');

const cart = read('views/pages/cart.html');
requireText(cart, 'name="privacyAccepted"', 'views/pages/cart.html', 'order form must require privacy acceptance');
requireText(cart, 'name="licenseConfirmed"', 'views/pages/cart.html', 'order form must require license confirmation');
requireText(cart, 'name="marketingConsent"', 'views/pages/cart.html', 'order form must keep marketing consent separate and optional');

['views/pages/privacy.html', 'views/pages/terms.html', 'views/pages/accessibility.html', 'views/compliance.html', 'compliance-api.js'].forEach((file) => {
  if (!fs.existsSync(path.join(root, file))) errors.push(`${file}: required compliance file is missing`);
});

const server = read('commerce-server.js');
requireText(server, 'ENABLE_INDEXING_REQUESTED && PUBLIC_READY', 'commerce-server.js', 'indexing must require complete public launch data');
requireText(server, "Disallow: /admin", 'commerce-server.js', 'robots.txt must protect admin routes');
requireText(server, "Disallow: /api/", 'commerce-server.js', 'robots.txt must protect API routes');
requireText(server, 'ensureComplianceSchema', 'commerce-server.js', 'compliance schema must initialize at startup');

if (errors.length) {
  console.error('Search and CRM compliance validation failed:\n- ' + errors.join('\n- '));
  process.exit(1);
}

console.log(`Search and CRM compliance validation passed for ${publicFiles.length} public pages.`);
