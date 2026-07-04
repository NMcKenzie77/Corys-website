const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', true);

const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');
const PAGES_DIR = path.join(VIEWS_DIR, 'pages');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

const SITE_NAME = process.env.SITE_NAME || 'YOUR BRAND';
const SITE_URL = normalizeBaseUrl(process.env.SITE_URL || '');
const DEFAULT_OG_IMAGE = process.env.OG_IMAGE || '';
const ENABLE_INDEXING = process.env.ENABLE_INDEXING !== 'false';

const DEFAULT_META = {
  title: `${SITE_NAME} | Washington Wholesale Cannabis — Flower, Edibles, Vapes, Concentrates`,
  description: `${SITE_NAME} is a Washington-licensed producer-processor supplying flower, edibles, vapes, and concentrates to licensed retailers statewide.`,
  robots: ENABLE_INDEXING ? 'index, follow' : 'noindex, nofollow',
  ogType: 'website',
  twitterCard: DEFAULT_OG_IMAGE ? 'summary_large_image' : 'summary',
  ogImage: DEFAULT_OG_IMAGE,
  schemaType: 'Organization',
  changefreq: 'weekly',
  priority: '0.8'
};

app.use(express.json());

// Canonical URL hygiene: one URL per page.
app.use((req, res, next) => {
  if (req.path.length > 1 && req.path.endsWith('/')) {
    const cleanPath = req.path.replace(/\/+$/, '');
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    return res.redirect(301, `${cleanPath}${query}`);
  }
  next();
});

// Basic hardening headers — no extra dependency needed for a site this size.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function readView(relativePath) {
  return fs.readFileSync(path.join(VIEWS_DIR, relativePath), 'utf8');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function replaceAllTokens(source, replacements) {
  return Object.entries(replacements).reduce((output, [key, value]) => {
    return output.split(`{{${key}}}`).join(value == null ? '' : String(value));
  }, source);
}

function getBaseUrl(req) {
  if (SITE_URL) return SITE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

function fullUrl(req, routePath = '/') {
  const base = getBaseUrl(req);
  if (!routePath || routePath === '/') return `${base}/`;
  return `${base}/${String(routePath).replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function assetUrl(req, value) {
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `${getBaseUrl(req)}${value.startsWith('/') ? value : `/${value}`}`;
}

function parsePageContent(rawContent) {
  const meta = { ...DEFAULT_META };
  let content = rawContent;

  const metaMatch = rawContent.match(/^\s*<!--([\s\S]*?)-->/);
  if (metaMatch) {
    const lines = metaMatch[1].split('\n');
    let hasMetadata = false;

    lines.forEach((line) => {
      const match = line.match(/^\s*(title|description|robots|canonical|ogTitle|ogDescription|ogImage|ogType|twitterCard|schemaType|changefreq|priority):\s*(.*?)\s*$/i);
      if (!match) return;
      hasMetadata = true;
      meta[match[1]] = match[2];
    });

    if (hasMetadata) {
      content = rawContent.slice(metaMatch[0].length).trimStart();
    }
  }

  return { meta, content };
}

function getPageSlugs() {
  if (!fs.existsSync(PAGES_DIR)) return [];
  return fs.readdirSync(PAGES_DIR)
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.replace(/\.html$/, ''))
    .filter((slug) => /^[a-z0-9-]+$/.test(slug))
    .sort((a, b) => {
      if (a === 'index') return -1;
      if (b === 'index') return 1;
      return a.localeCompare(b);
    });
}

function getPageRoute(slug) {
  return slug === 'index' ? '/' : `/${slug}`;
}

function getPageFile(slug) {
  return path.join(PAGES_DIR, `${slug}.html`);
}

function getPageData(slug) {
  const pagePath = getPageFile(slug);
  if (!fs.existsSync(pagePath)) return null;
  const rawPage = fs.readFileSync(pagePath, 'utf8');
  const parsed = parsePageContent(rawPage);
  return { ...parsed, pagePath };
}

function buildJsonLd(meta, canonicalUrl) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': meta.schemaType || 'Organization',
    name: SITE_NAME,
    url: canonicalUrl,
    description: meta.description
  };

  if (meta.ogImage) {
    schema.image = meta.ogImage;
  }

  return JSON.stringify(schema);
}

function renderPage(pageSlug, req, statusCode = 200) {
  const safeSlug = pageSlug === '' ? 'index' : pageSlug;

  if (!/^[a-z0-9-]+$/.test(safeSlug)) {
    return null;
  }

  const pageData = getPageData(safeSlug);
  if (!pageData) return null;

  const layout = readView('layout.html');
  const header = fs.readFileSync(path.join(PARTIALS_DIR, 'header.html'), 'utf8');
  const footer = fs.readFileSync(path.join(PARTIALS_DIR, 'footer.html'), 'utf8');
  const routePath = getPageRoute(safeSlug);
  const canonicalUrl = pageData.meta.canonical || fullUrl(req, routePath);
  const ogImageUrl = assetUrl(req, pageData.meta.ogImage || DEFAULT_OG_IMAGE);

  const meta = {
    ...pageData.meta,
    canonicalUrl,
    ogTitle: pageData.meta.ogTitle || pageData.meta.title,
    ogDescription: pageData.meta.ogDescription || pageData.meta.description,
    ogImage: ogImageUrl,
    ogType: pageData.meta.ogType || DEFAULT_META.ogType,
    twitterCard: pageData.meta.twitterCard || (ogImageUrl ? 'summary_large_image' : 'summary')
  };

  const commonTokens = {
    siteName: escapeHtml(SITE_NAME),
    title: escapeHtml(meta.title),
    description: escapeHtml(meta.description),
    robots: escapeHtml(statusCode === 404 ? 'noindex, nofollow' : meta.robots),
    canonicalUrl: escapeHtml(meta.canonicalUrl),
    ogType: escapeHtml(meta.ogType),
    ogTitle: escapeHtml(meta.ogTitle),
    ogDescription: escapeHtml(meta.ogDescription),
    twitterCard: escapeHtml(meta.twitterCard),
    ogImageTag: meta.ogImage ? `<meta property="og:image" content="${escapeHtml(meta.ogImage)}" />` : '',
    twitterImageTag: meta.ogImage ? `<meta name="twitter:image" content="${escapeHtml(meta.ogImage)}" />` : '',
    jsonLd: buildJsonLd({ ...meta, ogImage: meta.ogImage }, meta.canonicalUrl).replace(/</g, '\\u003c')
  };

  const html = replaceAllTokens(layout, {
    ...commonTokens,
    header: replaceAllTokens(header, { siteName: escapeHtml(SITE_NAME) }),
    content: replaceAllTokens(pageData.content, { siteName: escapeHtml(SITE_NAME) }),
    footer: replaceAllTokens(footer, { siteName: escapeHtml(SITE_NAME) })
  });

  return html;
}

function buildSitemap(req) {
  const urls = getPageSlugs()
    .filter((slug) => slug !== '404')
    .map((slug) => {
      const pageData = getPageData(slug);
      if (!pageData || /noindex/i.test(pageData.meta.robots || '')) return null;

      const stat = fs.statSync(pageData.pagePath);
      const routePath = getPageRoute(slug);
      const loc = pageData.meta.canonical || fullUrl(req, routePath);
      const lastmod = stat.mtime.toISOString().split('T')[0];
      const changefreq = pageData.meta.changefreq || DEFAULT_META.changefreq;
      const priority = pageData.meta.priority || (slug === 'index' ? '1.0' : DEFAULT_META.priority);

      return [
        '  <url>',
        `    <loc>${escapeXml(loc)}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${escapeXml(changefreq)}</changefreq>`,
        `    <priority>${escapeXml(priority)}</priority>`,
        '  </url>'
      ].join('\n');
    })
    .filter(Boolean)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/robots.txt', (req, res) => {
  const robots = ENABLE_INDEXING
    ? ['User-agent: *', 'Allow: /', `Sitemap: ${fullUrl(req, '/sitemap.xml')}`, ''].join('\n')
    : ['User-agent: *', 'Disallow: /', `Sitemap: ${fullUrl(req, '/sitemap.xml')}`, ''].join('\n');
  res.type('text/plain').send(robots);
});

app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(buildSitemap(req));
});

app.get('/', (req, res) => {
  const html = renderPage('index', req);
  res.type('html').send(html);
});

// Automatic page routing.
// Add `views/pages/about.html` and it becomes available at `/about`.
// Add `views/pages/products.html` and it becomes available at `/products`.
app.get('/:page', (req, res, next) => {
  const html = renderPage(req.params.page, req);

  if (!html) {
    return next();
  }

  res.type('html').send(html);
});

app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    // While this site is still being iterated on, force browsers to always
    // re-check CSS/JS instead of serving a stale cached copy after a deploy.
    // Once the design is locked in, this can be removed (or swapped for
    // hashed filenames) so assets cache normally for real visitors.
    if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  }
}));

// Wholesale inquiry form submissions land here.
// Right now this just logs to a local file so nothing is lost during setup.
// Swap this for Resend (or whatever you're already using on ARKON/Invicta)
// the moment you're ready to route these to a real inbox.
app.post('/api/inquiry', (req, res) => {
  const { businessName, contactName, licenseNumber, email, phone, message } = req.body || {};

  if (!businessName || !contactName || !email) {
    return res.status(400).json({ ok: false, error: 'Business name, contact name, and email are required.' });
  }

  const entry = {
    receivedAt: new Date().toISOString(),
    businessName,
    contactName,
    licenseNumber: licenseNumber || null,
    email,
    phone: phone || null,
    message: message || null
  };

  const logPath = path.join(__dirname, 'inquiries.log.jsonl');
  fs.appendFile(logPath, JSON.stringify(entry) + '\n', (err) => {
    if (err) {
      console.error('Failed to write inquiry:', err);
      return res.status(500).json({ ok: false, error: 'Something went wrong on our end. Please try again.' });
    }
    console.log('New wholesale inquiry:', entry.businessName, entry.email);
    res.json({ ok: true });
  });
});

app.use((req, res) => {
  res.status(404).type('html').send(renderPage('404', req, 404) || '<h1>Page not found</h1>');
});

app.listen(PORT, () => {
  console.log(`Wholesale site running on port ${PORT}`);
});
