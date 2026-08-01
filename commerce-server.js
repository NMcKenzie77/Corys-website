'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { initDatabase, pool } = require('./db');
const { registerCommerce } = require('./commerce-api');
const { ensureMarketingSchema, registerMarketing, startMarketingWorker } = require('./marketing-api');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const VIEWS = path.join(__dirname, 'views');
const PAGES = path.join(VIEWS, 'pages');
const PARTIALS = path.join(VIEWS, 'partials');
const SITE_NAME = process.env.SITE_NAME || 'YOUR BRAND';
const SITE_URL = String(process.env.SITE_URL || '').replace(/\/+$/, '');
const ENABLE_INDEXING = process.env.ENABLE_INDEXING === 'true';
const OG_IMAGE = process.env.OG_IMAGE || '';

app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(PUBLIC, {
  extensions: ['html'],
  setHeaders: (res, file) => {
    if (file.endsWith('.css') || file.endsWith('.js')) res.setHeader('Cache-Control', 'no-cache,must-revalidate');
  }
}));

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function replace(source, values) {
  return Object.entries(values).reduce((output, [key, value]) => output.split(`{{${key}}}`).join(value == null ? '' : String(value)), source);
}
function base(req) { return SITE_URL || `${req.protocol}://${req.get('host')}`; }
function url(req, routePath = '/') { return routePath === '/' ? `${base(req)}/` : `${base(req)}/${String(routePath).replace(/^\/+|\/+$/g, '')}`; }
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
function render(slug, req, status = 200) {
  const pageData = page(slug);
  if (!pageData) return null;
  const title = replace(pageData.meta.title || `${SITE_NAME} | Washington Wholesale Cannabis`, { siteName: SITE_NAME });
  const description = replace(pageData.meta.description || `${SITE_NAME} supplies licensed Washington cannabis retailers.`, { siteName: SITE_NAME });
  const canonical = url(req, slug === 'index' ? '/' : `/${slug}`);
  const robots = status === 404 ? 'noindex, nofollow' : (pageData.meta.robots || (ENABLE_INDEXING ? 'index, follow' : 'noindex, nofollow'));
  const jsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': pageData.meta.schemaType || 'Organization', name: SITE_NAME, url: canonical, description });
  return replace(fs.readFileSync(path.join(VIEWS, 'layout.html'), 'utf8'), {
    siteName: esc(SITE_NAME), title: esc(title), description: esc(description), robots: esc(robots), canonicalUrl: esc(canonical), ogType: 'website',
    ogTitle: esc(replace(pageData.meta.ogTitle || title, { siteName: SITE_NAME })), ogDescription: esc(replace(pageData.meta.ogDescription || description, { siteName: SITE_NAME })),
    twitterCard: OG_IMAGE ? 'summary_large_image' : 'summary', ogImageTag: OG_IMAGE ? `<meta property="og:image" content="${esc(OG_IMAGE)}" />` : '',
    twitterImageTag: OG_IMAGE ? `<meta name="twitter:image" content="${esc(OG_IMAGE)}" />` : '', jsonLd: jsonLd.replace(/</g, '\\u003c'),
    header: replace(fs.readFileSync(path.join(PARTIALS, 'header.html'), 'utf8'), { siteName: esc(SITE_NAME) }),
    content: replace(pageData.content, { siteName: esc(SITE_NAME) }), footer: replace(fs.readFileSync(path.join(PARTIALS, 'footer.html'), 'utf8'), { siteName: esc(SITE_NAME) })
  });
}

registerCommerce(app, { salesEmail: process.env.SALES_EMAIL || process.env.ADMIN_EMAIL || '' });
registerMarketing(app);

app.get('/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: true }); }
  catch (error) { res.status(503).json({ ok: false, database: false, error: error.message }); }
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send(ENABLE_INDEXING ? `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${url(req, '/sitemap.xml')}\n` : 'User-agent: *\nDisallow: /\n'));
app.get('/sitemap.xml', (req, res) => {
  const rows = fs.readdirSync(PAGES).filter((file) => file.endsWith('.html') && !['404.html'].includes(file)).map((file) => `<url><loc>${url(req, file === 'index.html' ? '/' : `/${file.replace('.html', '')}`)}</loc></url>`).join('\n');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>`);
});
app.get('/admin', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'admin.html'), 'utf8'), { siteName: esc(SITE_NAME) })));
app.get('/admin/marketing', (_req, res) => res.type('html').send(replace(fs.readFileSync(path.join(VIEWS, 'marketing.html'), 'utf8'), { siteName: esc(SITE_NAME) })));
app.get('/', (req, res) => res.type('html').send(render('index', req)));
app.get('/:page', (req, res, next) => { const html = render(req.params.page, req); if (!html) return next(); res.type('html').send(html); });
app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) || (error.code === '23505' ? 409 : 500);
  let message = error.code === '23505' ? 'That slug, SKU, or email is already in use.' : (error.message || 'Something went wrong.');
  if (status >= 500 && process.env.NODE_ENV === 'production') message = 'Something went wrong on our end.';
  res.status(status).json({ ok: false, error: message });
});
app.use((req, res) => res.status(404).type('html').send(render('404', req, 404) || '<h1>Page not found</h1>'));

initDatabase().then(ensureMarketingSchema).then(() => {
  startMarketingWorker();
  app.listen(PORT, () => console.log(`${SITE_NAME} commerce running on ${PORT}`));
}).catch((error) => { console.error('Startup failed:', error); process.exit(1); });
