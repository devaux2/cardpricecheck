# Card Price Check

A Chrome extension for hunting graded Japanese card deals. Two engines, both
running **entirely locally in your browser** — no server, no crawler, no
third-party API:

1. **On-page price comparison** — while you browse **Carousell HK** or
   **Facebook Marketplace**, every listing gets a badge with the price of
   the same card from **Japan-located eBay sellers** (converted to HK$ —
   HKD is pegged to USD, so the fixed editable rate stays accurate), and
   listings sitting well below that reference are highlighted green. The
   same treatment works on eBay pages too (compared against JP eBay and
   Cardmarket).
2. **Watches** — saved searches for **Carousell HK** and **Facebook
   Marketplace** that run automatically every few hours (while Chrome is
   open), filter for what you collect — e.g. PSA 7/8/9 Japanese cards from
   specific sets or release years — and flag every *new* matching listing in
   a deals feed with a desktop notification and a badge count.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

## On-page comparison

Browse Carousell HK or Facebook Marketplace search results as normal — each
listing gets a `JP eBay ~$12 ≈HK$94` badge (click it to open the actual eBay
search and verify) and a verdict like **▼ 34% below JP eBay** with a green
outline when it clears the threshold (default 20%).

On eBay pages (ebay.co.uk, ebay.com, .de, .fr, .com.au, .ca) the same badges
appear with more sources:

- `JP eBay ~£8.40` — median of the cheapest Japan-located Buy-It-Now matches
  (click to open that search and verify).
- `Cardmarket ~€7.50 ≈£6.38` — median of the cheapest Cardmarket matches,
  converted with the rate from settings.
- A verdict such as **▼ 34% below best alternative** — when the listing is at
  least the threshold (default 20%) below the cheapest alternative, the whole
  listing is outlined green.

On a single item page (`/itm/…`) a floating panel appears in the bottom-right
corner. Settings live in the toolbar popup. eBay has no separate Japanese
marketplace, so "Japanese eBay" means your local eBay site filtered to items
located in Japan (`LH_LocatedIn=1&_salic=104`) — prices come back in your
site's currency.

## Watches (Carousell HK + Facebook Marketplace)

Open **Watches & deals** from the toolbar popup (or the extension's options
page). Each watch has:

- a **search query** (e.g. `charizard`, `リザードン`, `gengar sar`),
- **platforms** — Carousell HK and/or Facebook Marketplace,
- **PSA grades** to accept (default 7/8/9; ungraded listings are rejected
  unless "any grade" is picked),
- **Japanese only** — heuristic on the title (kana, or markers like
  `日版`/`日本`/`Japanese`; explicit `中文版` is rejected),
- **set / expansion filter** — pick sets from the bundled list of Japanese
  expansions (searchable by code, English or Japanese name),
- **release-date range** — only sets released in that window match (works
  through the same set detection),
- **max price** (HK$) and **max listing age** (default: one week).

Checks run on a schedule (default every 6 hours, configurable down to hourly
or manual-only) and only while Chrome is open. Every listing is remembered
once evaluated, so only *new* listings are flagged. New matches land in the
**Deals** feed, fire a desktop notification, and show as a badge count on the
toolbar icon.

### Facebook Marketplace caveats

FB has no public API and requires your own logged-in session — the extension
checks it through a hidden worker tab using *your* login. If the feed shows a
"not logged in" error, log in to facebook.com in a normal tab and run the
checks again. Facebook's terms frown on automated collection: keep the
frequency modest (the default is gentle) and treat this as personal tooling.
Facebook also changes its markup constantly; the scraper reads the
server-embedded search payload first (which also works in the hidden worker
tab, where Chrome never renders the visual feed — the tab *looking*
half-loaded is expected) and only falls back to the visible DOM. Expect
occasional breakage anyway.

## How the lookups work

- **eBay (Japan)** — the background service worker fetches the filtered
  search page directly (Buy-It-Now only, sorted by price + postage) and
  parses it in an offscreen document. Median of the cheapest ~12 matches.
- **Cardmarket / Carousell / Facebook** — one shared hidden background tab
  (a "side instance") is navigated through the queued searches; content
  scripts scrape results and report back, and the tab closes after ~45 s of
  inactivity. Cardmarket and Facebook need a real browser context
  (Cloudflare / login), which is why these aren't plain fetches.
- **Politeness** — one request at a time per source with multi-second gaps,
  identical queries deduplicated, price lookups cached for 6 hours.

## Limitations / notes

- **Matching is heuristic.** Queries are built from listing titles; set
  detection needs a recognisable set code or name in the title. Treat flags
  as leads and click through to verify before buying.
- **Shipping is not included** in price comparisons.
- **Cardmarket prices are in EUR**; conversion uses a fixed, user-editable
  rate (no external FX API, to keep everything local).
- The bundled Japanese set list (`sets.js`) is generated from model
  knowledge — dates are approximate and the list is editable.
- All four sites change their markup regularly; selectors may need updates.
- Scraping is for **personal use** — keep the rate limits polite and respect
  each site's terms of service.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` / `content.css` | eBay page scanner, badges, deal highlighting |
| `marketplace-annotator.js` | Live badges/highlighting on Carousell HK and FBM pages |
| `background.js` | Lookup queues, caching, worker-tab orchestration, watch scheduler |
| `watch-filters.js` | Pure filtering logic (grades, Japanese heuristic, set matching) |
| `sets.js` | Bundled Japanese Pokémon expansion list (codes, names, release dates) |
| `offscreen.html` / `offscreen.js` | Parses fetched eBay search HTML |
| `cm-scraper.js` | Cardmarket worker-tab scraper |
| `carousell-scraper.js` | Carousell HK worker-tab scraper |
| `fbm-scraper.js` | Facebook Marketplace worker-tab scraper |
| `money.js` | Shared price/currency parsing |
| `popup.html` / `popup.js` | Quick settings popup |
| `watches.html` / `.css` / `.js` | Watches & deals page |
| `icons/` | Extension icons |
