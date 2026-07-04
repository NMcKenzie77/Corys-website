# YOUR BRAND — Wholesale Cannabis Site

A Node/Express site for a Washington-licensed cannabis producer-processor selling
wholesale to licensed retailers. Built for Railway deployment.

## What's in here

- `server.js` — Express server. Serves the static site and handles the
  wholesale inquiry form (`POST /api/inquiry`).
- `public/index.html` — the whole site (age gate + main page).
- `public/css/styles.css` — all styling. Palette lives in the `:root` block
  at the top — change those variables to re-skin the entire site.
- `public/js/main.js` — age gate logic, the canvas smoke effect, the hero
  word cycler, and the inquiry form submit handler.

## Running locally

```
npm install
npm start
```

Visit `http://localhost:3000`.

## Before this goes live, replace:

1. **"YOUR BRAND"** — search `public/index.html` for every instance and
   replace with the real name (nav, hero, footer, page title/meta).
2. **Logo mark** — the `YB` letter badges in the nav/gate/footer are
   placeholders. Swap for a real logo (SVG recommended) once it exists.
3. **`[LICENSE #]`** — real WA UBI/license number, in the footer.
4. **`[EMAIL]` / `[PHONE]` / `[ADDRESS]`** — real contact info, in the contact section.
5. **`noindex, nofollow`** in the `<meta name="robots">` tag — remove this
   once real brand copy is in place and the site is ready to be found on Google.
6. **Category copy** — the Flower/Edibles/Vapes/Concentrates descriptions
   are generic placeholders. Swap in real product line details.

## Wholesale inquiry form

Right now, submissions get appended to `inquiries.log.jsonl` in the project
root (gitignored). That's fine for testing, but you'll want real notifications
before this goes live — the easiest path is wiring `POST /api/inquiry` in
`server.js` to Resend (same as the Invicta/ARKON stack) instead of the log file.

## Compliance notes (Washington / WSLCB)

This template includes what's currently required for WA cannabis advertising:
- The four mandatory warning statements (intoxicating/habit-forming, impairment,
  health risk, 21+/keep from children), sized appropriately.
- A 21+ statement.
- No youth-appealing imagery, no health/curative claims, no promotional
  giveaways built into the flow.
- An out-of-state targeting disclaimer in the footer and gate.

Washington's advertising rules changed as of July 4, 2026 (WAC 314-55-155
amendments under ESB 5206). This template reflects the requirements as
researched at build time — have this reviewed by an actual WA cannabis
attorney before launch, not just this README. Rules around signage, trade
names, and online content continue to evolve.

## Deploying to Railway

`railway.json` is already set up (Nixpacks build, `npm start`). Push this repo,
connect it to a new Railway service, and it should deploy with no extra config
beyond setting the `PORT` env var if Railway doesn't already inject one (it does
by default).
