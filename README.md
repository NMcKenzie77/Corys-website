# YOUR BRAND — Wholesale Cannabis Site

A Node/Express site for a Washington-licensed cannabis producer-processor selling wholesale to licensed retailers. Built for Railway deployment.

## Layout system

The site now uses one shared layout instead of duplicating the header and footer on every page.

Shared files:

- `views/layout.html` — the master page shell. It loads the CSS, fonts, age gate, shared header, page content, shared footer, and JavaScript.
- `views/partials/header.html` — the single source for the navigation/header and scrolling crawler.
- `views/partials/footer.html` — the single source for the footer and compliance language.
- `public/css/styles.css` — the single source for the site styling and color palette.
- `public/js/main.js` — shared browser behavior for the gate, smoke, reveals, crawler support, and form submission.

Page files:

- `views/pages/index.html` — homepage content only.

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

The server automatically wraps that page with the shared layout, header, CSS, JavaScript, age gate, and footer.

## Optional page metadata

At the top of any page file, you can add metadata inside an HTML comment:

```html
<!--
title: About YOUR BRAND | Washington Wholesale Cannabis
description: Learn about YOUR BRAND and its Washington wholesale cannabis operation.
robots: noindex, nofollow
-->
```

If metadata is not provided, the site uses the default title, description, and robots setting from `server.js`.

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
5. **`noindex, nofollow`** — remove or change this once real brand copy is in place and the site is ready to be found on Google.
6. **Category copy** — the Flower/Edibles/Vapes/Concentrates descriptions are generic placeholders. Swap in real product line details.

## Wholesale inquiry form

Submissions get appended to `inquiries.log.jsonl` in the project root. That file is ignored by Git. For production, replace the logging behavior in `server.js` with an email/API workflow when ready.
