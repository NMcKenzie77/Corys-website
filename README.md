# YOUR BRAND — Wholesale Cannabis Site

A Node/Express site for a Washington-licensed cannabis producer-processor selling wholesale to licensed retailers. Built for Railway deployment.

## Layout system

The site now uses one shared layout instead of duplicating the header and footer on every page.

Shared files:

- `views/layout.html` — the master page shell. It loads the CSS, fonts, SEO metadata, age gate, shared header, page content, shared footer, and JavaScript.
- `views/partials/header.html` — the single source for the navigation/header and scrolling crawler.
- `views/partials/footer.html` — the single source for the footer and compliance language.
- `public/css/styles.css` — the single source for the site styling and color palette.
- `public/js/main.js` — shared browser behavior for the gate, smoke, reveals, crawler support, and form submission.

Page files:

- `views/pages/index.html` — homepage content only.
- `views/pages/404.html` — shared-layout 404 page.

To add a new page, create a new file in `views/pages/` using a lowercase slug name:

```txt
views/pages/about.html
views/pages/products.html
views/pages/retailers.html
```

Then visit:

```txt
/about
/products
/retailers
```

The server automatically wraps that page with the shared layout, header, CSS, JavaScript, age gate, footer, SEO tags, and canonical URL.

## SEO system

The site now generates SEO-critical tags from one renderer in `server.js`:

- `<title>`
- meta description
- robots directive
- canonical URL
- Open Graph tags
- Twitter card tags
- JSON-LD structured data
- `/robots.txt`
- `/sitemap.xml`
- 301 redirects for trailing slash cleanup

The sitemap is generated automatically from every file in `views/pages/`, except `404.html` and pages marked `noindex`.

## Optional page metadata

At the top of any page file, add metadata inside an HTML comment:

```html
<!--
title: About YOUR BRAND | Washington Wholesale Cannabis
description: Learn about YOUR BRAND and its Washington wholesale cannabis operation.
robots: index, follow
ogTitle: About YOUR BRAND
ogDescription: Washington wholesale cannabis producer-processor.
ogImage: /assets/og-image.jpg
schemaType: Organization
changefreq: monthly
priority: 0.7
-->
```

Supported metadata keys:

- `title`
- `description`
- `robots`
- `canonical`
- `ogTitle`
- `ogDescription`
- `ogImage`
- `ogType`
- `twitterCard`
- `schemaType`
- `changefreq`
- `priority`

If metadata is not provided, the site uses the default title, description, and robots setting from `server.js`.

## Environment variables

Set these in Railway when the real brand/domain is ready:

```txt
SITE_NAME=Real Brand Name
SITE_URL=https://www.realbranddomain.com
OG_IMAGE=/assets/og-image.jpg
ENABLE_INDEXING=true
```

To temporarily block indexing while the site still has placeholder copy:

```txt
ENABLE_INDEXING=false
```

## Running locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

## Before this goes live, replace:

1. **"YOUR BRAND"** — search the `views/` files for every instance and replace with the real name.
2. **Logo mark** — the `YB` letter badges in the layout/header/footer are placeholders. Swap for a real logo once it exists.
3. **`[LICENSE #]`** — real WA UBI/license number in `views/partials/footer.html`.
4. **`[EMAIL]` / `[PHONE]` / `[ADDRESS]`** — real contact info in `views/pages/index.html`.
5. **Brand/domain environment variables** — set `SITE_NAME` and `SITE_URL` in Railway.
6. **Category copy** — the Flower/Edibles/Vapes/Concentrates descriptions are generic placeholders. Swap in real product line details.
7. **Social image** — add an Open Graph image and set `OG_IMAGE`.

## Wholesale inquiry form

Submissions get appended to `inquiries.log.jsonl` in the project root. That file is ignored by Git. For production, replace the logging behavior in `server.js` with an email/API workflow when ready.
