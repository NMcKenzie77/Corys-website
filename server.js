const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, 'public');
const VIEWS_DIR = path.join(__dirname, 'views');
const PAGES_DIR = path.join(VIEWS_DIR, 'pages');
const PARTIALS_DIR = path.join(VIEWS_DIR, 'partials');

const DEFAULT_META = {
  title: 'YOUR BRAND | Washington Wholesale Cannabis — Flower, Edibles, Vapes, Concentrates',
  description: 'YOUR BRAND is a Washington-licensed producer-processor supplying flower, edibles, vapes, and concentrates to licensed retailers statewide.',
  robots: 'noindex, nofollow'
};

app.use(express.json());

// Basic hardening headers — no extra dependency needed for a site this size.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

function readView(relativePath) {
  return fs.readFileSync(path.join(VIEWS_DIR, relativePath), 'utf8');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parsePageContent(rawContent) {
  const meta = { ...DEFAULT_META };
  let content = rawContent;

  const metaMatch = rawContent.match(/^\s*<!--([\s\S]*?)-->/);
  if (metaMatch) {
    const lines = metaMatch[1].split('\n');
    let hasMetadata = false;

    lines.forEach((line) => {
      const match = line.match(/^\s*(title|description|robots):\s*(.*?)\s*$/i);
      if (!match) return;
      hasMetadata = true;
      meta[match[1].toLowerCase()] = match[2];
    });

    if (hasMetadata) {
      content = rawContent.slice(metaMatch[0].length).trimStart();
    }
  }

  return { meta, content };
}

function renderPage(pageSlug) {
  const safeSlug = pageSlug === '' ? 'index' : pageSlug;

  if (!/^[a-z0-9-]+$/.test(safeSlug)) {
    return null;
  }

  const pagePath = path.join(PAGES_DIR, `${safeSlug}.html`);

  if (!fs.existsSync(pagePath)) {
    return null;
  }

  const layout = readView('layout.html');
  const header = fs.readFileSync(path.join(PARTIALS_DIR, 'header.html'), 'utf8');
  const footer = fs.readFileSync(path.join(PARTIALS_DIR, 'footer.html'), 'utf8');
  const rawPage = fs.readFileSync(pagePath, 'utf8');
  const { meta, content } = parsePageContent(rawPage);

  return layout
    .replace('{{title}}', escapeHtml(meta.title))
    .replace('{{description}}', escapeHtml(meta.description))
    .replace('{{robots}}', escapeHtml(meta.robots))
    .replace('{{header}}', header)
    .replace('{{content}}', content)
    .replace('{{footer}}', footer);
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/', (req, res) => {
  const html = renderPage('index');
  res.type('html').send(html);
});

// Automatic page routing.
// Add `views/pages/about.html` and it becomes available at `/about`.
// Add `views/pages/products.html` and it becomes available at `/products`.
app.get('/:page', (req, res, next) => {
  const html = renderPage(req.params.page);

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
  res.status(404).type('html').send(renderPage('404') || '<h1>Page not found</h1>');
});

app.listen(PORT, () => {
  console.log(`Wholesale site running on port ${PORT}`);
});
