const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Basic hardening headers — no extra dependency needed for a site this size.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
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

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Wholesale site running on port ${PORT}`);
});
