'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { initDatabase, pool } = require('./db');
const { ensureComplianceSchema, registerCompliance } = require('./compliance-api');
const { ensureRetailSchema, registerRetailApi, startRetailAutomationWorker, storeConfig } = require('./retail-api');
const { ensureRetailLegalSchema, registerRetailLegalControls } = require('./retail-legal-controls');
const { registerRetailComplianceApi } = require('./retail-compliance-api');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const RETAIL_VIEWS = path.join(__dirname, 'views', 'retail');
const RETAIL_PAGES = path.join(RETAIL_VIEWS, 'pages');

const SITE_NAME = process.env.SITE_NAME || 'YOUR DISPENSARY';
const SITE_URL = String(process.env.SITE_URL || '').replace(/\/+$/, '');
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || process.env.SALES_EMAIL || '';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || '';
const BUSINESS_LICENSE_NUMBER = process.env.BUSINESS_LICENSE_NUMBER || '';
const STORE_HOURS = process.env.STORE_HOURS || '';
const PRIVACY_EMAIL = process.env.PRIVACY_EMAIL || BUSINESS_EMAIL || process.env.ADMIN_EMAIL || '';
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';
const OG_IMAGE = process.env.OG_IMAGE || '';
const INDEXING_REQUESTED = process.env.ENABLE_INDEXING === 'true';

const PUBLIC_READINESS = {
  siteName: Boolean(SITE_NAME && SITE_NAME !== 'YOUR DISPENSARY'),
  siteUrl: /^https:\/\//i.test(SITE_URL),
  businessEmail: Boolean(BUSINESS_EMAIL),
  businessPhone: Boolean(BUSINESS_PHONE),
  businessAddress: Boolean(BUSINESS_ADDRESS),
  licenseNumber: Boolean(BUSINESS_LICENSE_NUMBER),
  storeHours: Boolean(STORE_HOURS),
  privacyEmail: Boolean(PRIVACY_EMAIL)
};
const PUBLIC_READY = Object.values(PUBLIC_READINESS).every(Boolean);
const INDEXING_ENABLED = INDEXING_REQUESTED && PUBLIC_READY;

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/') || req.path === '/healthz') {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

registerCompliance(app);
registerRetailLegalControls(app);
registerRetailComplianceApi(app);
registerRetailApi(app);

app.use(express.static(PUBLIC, {
  setHeaders(res, file) {
    if (file.endsWith('.css') || file.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public,max-age=3600,must-revalidate');
    }
  }
}));

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function xml(value) {
  return esc(value).replace(/&#39;/g, '&apos;');
}

function replace(source, values) {
  return Object.entries(values).reduce(
    (output, [key, value]) => output.split(`{{${key}}}`).join(value == null ? '' : String(value)),
    source
  );
}

function base(req) {
  return SITE_URL || `${req.protocol}://${req.get('host')}`;
}

function canonical(req, routePath) {
  return routePath === '/' ? `${base(req)}/` : `${base(req)}${routePath}`;
}

const PAGE_META = {
  home: {
    route: '/',
    title: `${SITE_NAME} | Licensed Washington Cannabis Dispensary`,
    description: `Browse the current menu at ${SITE_NAME}. Reserve online for pickup, then verify ID and pay inside the licensed Washington store.`,
    schemaType: 'Store',
    index: true
  },
  menu: {
    route: '/menu',
    title: `Cannabis Menu | ${SITE_NAME}`,
    description: 'Browse live flower, pre-rolls, concentrates, vapes, edibles, and other products. Online reservation only; payment and final sale occur in store.',
    schemaType: 'CollectionPage',
    index: true
  },
  pickup: {
    route: '/pickup',
    title: `Pickup Reservation | ${SITE_NAME}`,
    description: `Reserve cannabis products for pickup at ${SITE_NAME}. No online payment, shipping, or delivery.`,
    schemaType: 'WebPage',
    index: false
  },
  privacy: {
    route: '/privacy',
    title: `Privacy Notice | ${SITE_NAME}`,
    description: `How ${SITE_NAME} collects, uses, protects, and responds to requests about personal information.`,
    schemaType: 'WebPage',
    index: true
  },
  terms: {
    route: '/terms',
    title: `Website and Pickup Terms | ${SITE_NAME}`,
    description: `Terms for using the ${SITE_NAME} website and submitting in-store pickup reservations.`,
    schemaType: 'WebPage',
    index: true
  },
  accessibility: {
    route: '/accessibility',
    title: `Accessibility | ${SITE_NAME}`,
    description: `${SITE_NAME} accessibility statement and contact information.`,
    schemaType: 'WebPage',
    index: true
  },
  notfound: {
    route: '',
    title: `Page Not Found | ${SITE_NAME}`,
    description: 'The requested page was not found.',
    schemaType: 'WebPage',
    index: false
  }
};

function templateValues() {
  const config = storeConfig();
  return {
    siteName: esc(SITE_NAME),
    businessEmail: esc(BUSINESS_EMAIL),
    businessPhone: esc(BUSINESS_PHONE),
    businessAddress: esc(BUSINESS_ADDRESS),
    businessLicenseNumber: esc(BUSINESS_LICENSE_NUMBER),
    storeHours: esc(STORE_HOURS),
    privacyEmail: esc(PRIVACY_EMAIL),
    pickupInstructions: esc(config.pickupInstructions)
  };
}

function structuredData(req, meta, pageUrl) {
  const siteRoot = `${base(req)}/`;
  const store = {
    '@type': 'Store',
    '@id': `${siteRoot}#store`,
    name: SITE_NAME,
    url: siteRoot,
    email: BUSINESS_EMAIL,
    telephone: BUSINESS_PHONE,
    address: BUSINESS_ADDRESS,
    description: meta.description,
    identifier: {
      '@type': 'PropertyValue',
      propertyID: 'Washington cannabis retail license',
      value: BUSINESS_LICENSE_NUMBER
    }
  };
  if (OG_IMAGE) store.image = OG_IMAGE;

  const website = {
    '@type': 'WebSite',
    '@id': `${siteRoot}#website`,
    url: siteRoot,
    name: SITE_NAME,
    publisher: { '@id': `${siteRoot}#store` },
    inLanguage: 'en-US'
  };

  const page = {
    '@type': meta.schemaType === 'CollectionPage' ? 'CollectionPage' : 'WebPage',
    '@id': `${pageUrl}#webpage`,
    url: pageUrl,
    name: meta.title,
    description: meta.description,
    isPartOf: { '@id': `${siteRoot}#website` },
    about: { '@id': `${siteRoot}#store` },
    inLanguage: 'en-US'
  };

  return JSON.stringify({ '@context': 'https://schema.org', '@graph': [store, website, page] });
}

function render(name, req, status = 200) {
  const meta = PAGE_META[name];
  const pagePath = path.join(RETAIL_PAGES, `${name}.html`);
  if (!meta || !fs.existsSync(pagePath)) return null;
  const pageUrl = canonical(req, meta.route || req.path);
  const robots = status >= 400 || !meta.index || !INDEXING_ENABLED ? 'noindex, nofollow' : 'index, follow';
  const values = templateValues();
  return replace(fs.readFileSync(path.join(RETAIL_VIEWS, 'layout.html'), 'utf8'), {
    ...values,
    title: esc(meta.title),
    description: esc(meta.description),
    robots,
    canonicalUrl: esc(pageUrl),
    ogTitle: esc(meta.title),
    ogDescription: esc(meta.description),
    ogImageTag: OG_IMAGE ? `<meta property="og:image" content="${esc(OG_IMAGE)}">` : '',
    googleVerificationTag: GOOGLE_SITE_VERIFICATION
      ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}">`
      : '',
    jsonLd: structuredData(req, meta, pageUrl).replace(/</g, '\\u003c'),
    content: replace(fs.readFileSync(pagePath, 'utf8'), values)
  });
}

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      database: true,
      mode: 'WASHINGTON_RETAIL_PICKUP_ONLY',
      publicReady: PUBLIC_READY,
      indexingRequested: INDEXING_REQUESTED,
      indexingEnabled: INDEXING_ENABLED,
      readiness: PUBLIC_READINESS
    });
  } catch (error) {
    res.status(503).json({ ok: false, database: false, error: error.message });
  }
});

app.get('/robots.txt', (req, res) => {
  const body = INDEXING_ENABLED
    ? `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nDisallow: /healthz\nDisallow: /pickup\nSitemap: ${canonical(req, '/sitemap.xml')}\n`
    : 'User-agent: *\nDisallow: /\n';
  res.type('text/plain').send(body);
});

app.get('/sitemap.xml', (req, res) => {
  const routes = Object.values(PAGE_META).filter((meta) => meta.index && meta.route);
  const rows = INDEXING_ENABLED
    ? routes.map((meta) => `<url><loc>${xml(canonical(req, meta.route))}</loc></url>`).join('\n')
    : '';
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>`
  );
});

app.get('/', (req, res) => res.type('html').send(render('home', req)));
app.get('/menu', (req, res) => res.type('html').send(render('menu', req)));
app.get('/pickup', (req, res) => res.type('html').send(render('pickup', req)));
app.get('/privacy', (req, res) => res.type('html').send(render('privacy', req)));
app.get('/terms', (req, res) => res.type('html').send(render('terms', req)));
app.get('/accessibility', (req, res) => res.type('html').send(render('accessibility', req)));
app.get('/admin', (_req, res) => res.type('html').send(replace(
  fs.readFileSync(path.join(RETAIL_VIEWS, 'admin.html'), 'utf8'),
  templateValues()
)));

app.get('/shop', (_req, res) => res.redirect(301, '/menu'));
app.get('/cart', (_req, res) => res.redirect(301, '/pickup'));
app.get('/admin/crm', (_req, res) => res.redirect(302, '/admin#customers'));
app.get('/admin/marketing', (_req, res) => res.redirect(302, '/admin#campaigns'));
app.get('/admin/automations', (_req, res) => res.redirect(302, '/admin#automations'));
app.get('/admin/compliance', (_req, res) => res.redirect(302, '/admin#compliance'));

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) || (error.code === '23505' ? 409 : 500);
  let message = error.code === '23505' ? 'That email, SKU, or identifier is already in use.' : (error.message || 'Something went wrong.');
  if (status >= 500 && process.env.NODE_ENV === 'production') message = 'Something went wrong on our end.';
  res.status(status).json({ ok: false, error: message });
});

app.use((req, res) => res.status(404).type('html').send(render('notfound', req, 404) || '<h1>Page not found</h1>'));

initDatabase()
  .then(ensureComplianceSchema)
  .then(ensureRetailSchema)
  .then(ensureRetailLegalSchema)
  .then(() => {
    startRetailAutomationWorker();
    app.listen(PORT, () => console.log(`${SITE_NAME} retail pickup application running on ${PORT}`));
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
