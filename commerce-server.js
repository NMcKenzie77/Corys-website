'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { initDatabase, pool } = require('./db');
const { registerCommerce } = require('./commerce-api');
const { ensureMarketingSchema, registerMarketing, startMarketingWorker } = require('./marketing-api');
const { ensureCrmSchema, registerCrm } = require('./crm-api');
const { ensureCrmOrderSync } = require('./crm-order-sync');
const { ensureAutomationSchema, registerAutomations, startAutomationWorker } = require('./automation-api');
const { ensureComplianceSchema, registerCompliance } = require('./compliance-api');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const VIEWS = path.join(__dirname, 'views');
const PAGES = path.join(VIEWS, 'pages');
const PARTIALS = path.join(VIEWS, 'partials');

const SITE_NAME = process.env.SITE_NAME || 'YOUR BRAND';
const SITE_URL = String(process.env.SITE_URL || '').replace(/\/+$/, '');
const OG_IMAGE = process.env.OG_IMAGE || '';
const GOOGLE_SITE_VERIFICATION = process.env.GOOGLE_SITE_VERIFICATION || '';
const BUSINESS_EMAIL = process.env.BUSINESS_EMAIL || process.env.SALES_EMAIL || '';
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || '';
const BUSINESS_ADDRESS = process.env.BUSINESS_ADDRESS || '';
const BUSINESS_LICENSE_NUMBER = process.env.BUSINESS_LICENSE_NUMBER || '';
const PRIVACY_EMAIL = process.env.PRIVACY_EMAIL || BUSINESS_EMAIL || process.env.ADMIN_EMAIL || '';
const ENABLE_INDEXING_REQUESTED = process.env.ENABLE_INDEXING === 'true';

const PUBLIC_READINESS = {
  siteName: Boolean(SITE_NAME && SITE_NAME !== 'YOUR BRAND'),
  siteUrl: /^https:\/\//i.test(SITE_URL),
  businessEmail: Boolean(BUSINESS_EMAIL),
  businessPhone: Boolean(BUSINESS_PHONE),
  businessAddress: Boolean(BUSINESS_ADDRESS),
  licenseNumber: Boolean(BUSINESS_LICENSE_NUMBER),
  privacyEmail: Boolean(PRIVACY_EMAIL)
};
const PUBLIC_READY = Object.values(PUBLIC_READINESS).every(Boolean);
const INDEXING_ENABLED = ENABLE_INDEXING_REQUESTED && PUBLIC_READY;

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

registerCompliance(app);

app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders: (res, file) => {
    if (file.endsWith('.css') || file.endsWith('.js')) {
      res.setHeader('Cache-Control', 'public,max-age=3600,must-revalidate');
    }
  }
}));

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function xml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function replace(source, values) {
  return Object.entries(values).reduce((output, [key, value]) => output.split(`{{${key}}}`).join(value == null ? '' : String(value)), source);
}

function base(req) {
  return SITE_URL || `${req.protocol}://${req.get('host')}`;
}

function url(req, routePath = '/') {
  return routePath === '/' ? `${base(req)}/` : `${base(req)}/${String(routePath).replace(/^\/+|\/+$/g, '')}`;
}

function page(slug) {
  const file = path.join(PAGES, `${slug}.html`);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const meta = {};
  const match = raw.match(/^\s*<!--([\s\S]*?)-->/);
  let content = raw;

  if (match) {
    match[1].split('\n').forEach((line) => {
      const item = line.match(/^\s*(title|description|robots|ogTitle|ogDescription|schemaType|changefreq|priority):\s*(.*?)\s*$/i);
      if (item) meta[item[1]] = item[2];
    });
    content = raw.slice(match[0].length).trimStart();
  }

  return { file, meta, content };
}

function templateValues() {
  return {
    siteName: esc(SITE_NAME),
    businessEmail: esc(BUSINESS_EMAIL),
    businessPhone: esc(BUSINESS_PHONE),
    businessAddress: esc(BUSINESS_ADDRESS),
    businessLicenseNumber: esc(BUSINESS_LICENSE_NUMBER),
    privacyEmail: esc(PRIVACY_EMAIL)
  };
}

function structuredData(req, slug, pageData, title, description, canonical) {
  const root = `${base(req)}/`;
  const organization = {
    '@type': 'Organization',
    '@id': `${root}#organization`,
    name: SITE_NAME,
    url: root,
    description
  };

  if (OG_IMAGE) organization.logo = { '@type': 'ImageObject', url: OG_IMAGE };
  if (BUSINESS_EMAIL) organization.email = BUSINESS_EMAIL;
  if (BUSINESS_PHONE) organization.telephone = BUSINESS_PHONE;
  if (BUSINESS_ADDRESS) organization.address = BUSINESS_ADDRESS;
  if (BUSINESS_LICENSE_NUMBER) {
    organization.identifier = {
      '@type': 'PropertyValue',
      propertyID: 'Washington cannabis license',
      value: BUSINESS_LICENSE_NUMBER
    };
  }

  const website = {
    '@type': 'WebSite',
    '@id': `${root}#website`,
    url: root,
    name: SITE_NAME,
    publisher: { '@id': `${root}#organization` },
    inLanguage: 'en-US'
  };

  const requestedType = pageData.meta.schemaType || 'WebPage';
  const pageType = requestedType === 'CollectionPage' ? 'CollectionPage' : 'WebPage';
  const webPage = {
    '@type': pageType,
    '@id': `${canonical}#webpage`,
    url: canonical,
    name: title,
    description,
    isPartOf: { '@id': `${root}#website` },
    about: { '@id': `${root}#organization` },
    inLanguage: 'en-US'
  };

  if (slug === 'shop') webPage.mainEntity = { '@type': 'ItemList', name: 'Current wholesale cannabis products' };

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, website, webPage]
  };
}

function render(slug, req, status = 200) {
  const pageData = page(slug);
  if (!pageData) return null;

  const values = templateValues();
  const title = replace(pageData.meta.title || `${SITE_NAME} | Washington Wholesale Cannabis`, { siteName: SITE_NAME });
  const description = replace(pageData.meta.description || `${SITE_NAME} supplies licensed Washington cannabis retailers.`, { siteName: SITE_NAME });
  const canonical = url(req, slug === 'index' ? '/' : `/${slug}`);
  const requestedRobots = pageData.meta.robots || 'index, follow';
  const pageRequestsNoIndex = /noindex/i.test(requestedRobots);
  const robots = status === 404 || pageRequestsNoIndex || !INDEXING_ENABLED
    ? 'noindex, nofollow'
    : requestedRobots;
  const jsonLd = JSON.stringify(structuredData(req, slug, pageData, title, description, canonical));

  return replace(fs.readFileSync(path.join(VIEWS, 'layout.html'), 'utf8'), {
    ...values,
    title: esc(title),
    description: esc(description),
    robots: esc(robots),
    canonicalUrl: esc(canonical),
    ogType: 'website',
    ogTitle: esc(replace(pageData.meta.ogTitle || title, { siteName: SITE_NAME })),
    ogDescription: esc(replace(pageData.meta.ogDescription || description, { siteName: SITE_NAME })),
    twitterCard: OG_IMAGE ? 'summary_large_image' : 'summary',
    ogImageTag: OG_IMAGE ? `<meta property="og:image" content="${esc(OG_IMAGE)}" />` : '',
    twitterImageTag: OG_IMAGE ? `<meta name="twitter:image" content="${esc(OG_IMAGE)}" />` : '',
    googleSiteVerificationTag: GOOGLE_SITE_VERIFICATION
      ? `<meta name="google-site-verification" content="${esc(GOOGLE_SITE_VERIFICATION)}" />`
      : '',
    jsonLd: jsonLd.replace(/</g, '\\u003c'),
    header: replace(fs.readFileSync(path.join(PARTIALS, 'header.html'), 'utf8'), values),
    content: replace(pageData.content, values),
    footer: replace(fs.readFileSync(path.join(PARTIALS, 'footer.html'), 'utf8'), values)
  });
}

registerCommerce(app, { salesEmail: process.env.SALES_EMAIL || process.env.ADMIN_EMAIL || '' });
registerMarketing(app);
registerCrm(app);
registerAutomations(app);

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, database: true, indexingEnabled: INDEXING_ENABLED, publicReady: PUBLIC_READY });
  } catch (error) {
    res.status(503).json({ ok: false, database: false, error: error.message });
  }
});

app.get('/robots.txt', (req, res) => {
  if (!INDEXING_ENABLED) {
    return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  }

  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /api/',
    'Disallow: /healthz',
    `Sitemap: ${url(req, '/sitemap.xml')}`,
    ''
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const rows = INDEXING_ENABLED
    ? fs.readdirSync(PAGES)
      .filter((file) => file.endsWith('.html') && file !== '404.html')
      .map((file) => {
        const slug = file.replace('.html', '');
        const pageData = page(slug);
        return { file, slug, pageData };
      })
      .filter(({ pageData }) => pageData && !/noindex/i.test(pageData.meta.robots || ''))
      .map(({ file, slug, pageData }) => {
        const location = url(req, slug === 'index' ? '/' : `/${slug}`);
        const modified = fs.statSync(path.join(PAGES, file)).mtime.toISOString().slice(0, 10);
        const changefreq = pageData.meta.changefreq || 'monthly';
        const priority = pageData.meta.priority || '0.5';
        return `  <url><loc>${xml(location)}</loc><lastmod>${modified}</lastmod><changefreq>${xml(changefreq)}</changefreq><priority>${xml(priority)}</priority></url>`;
      })
      .join('\n')
    : '';

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>`);
});

app.get('/admin', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'admin.html'), 'utf8'), templateValues())));
app.get('/admin/marketing', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'marketing.html'), 'utf8'), templateValues())));
app.get('/admin/crm', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'crm.html'), 'utf8'), templateValues())));
app.get('/admin/automations', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'automations.html'), 'utf8'), templateValues())));
app.get('/admin/compliance', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'compliance.html'), 'utf8'), templateValues())));
app.get('/', (req, res) => res.type('html').send(render('index', req)));
app.get('/:page', (req, res, next) => {
  const html = render(req.params.page, req);
  if (!html) return next();
  res.type('html').send(html);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) || (error.code === '23505' ? 409 : 500);
  let message = error.code === '23505'
    ? 'That slug, SKU, license number, email, or request is already in use.'
    : (error.message || 'Something went wrong.');
  if (status >= 500 && process.env.NODE_ENV === 'production') message = 'Something went wrong on our end.';
  res.status(status).json({ ok: false, error: message });
});

app.use((req, res) => res.status(404).type('html').send(render('404', req, 404) || '<h1>Page not found</h1>'));

initDatabase()
  .then(ensureMarketingSchema)
  .then(ensureCrmSchema)
  .then(ensureComplianceSchema)
  .then(ensureAutomationSchema)
  .then(ensureCrmOrderSync)
  .then(() => {
    if (ENABLE_INDEXING_REQUESTED && !PUBLIC_READY) {
      const missing = Object.entries(PUBLIC_READINESS).filter(([, ready]) => !ready).map(([key]) => key);
      console.warn(`ENABLE_INDEXING was requested but public launch data is incomplete: ${missing.join(', ')}. The site will remain noindex.`);
    }
    startMarketingWorker();
    startAutomationWorker();
    app.listen(PORT, () => console.log(`${SITE_NAME} commerce running on ${PORT}; indexing=${INDEXING_ENABLED}`));
  })
  .catch((error) => {
    console.error('Startup failed:', error);
    process.exit(1);
  });
