# Card Price Check

A Chrome extension that scans the eBay search page (or item page) you are on,
looks up what the same card costs from **Japan-located eBay sellers** and on
**Cardmarket**, and highlights listings that are selling at a significant
discount versus the cheapest alternative market.

Everything runs **locally in your browser**. There is no server, no crawler,
no third-party API — lookups happen on demand only for the listings you are
actually viewing, they are rate-limited, and results are cached for 6 hours.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select this folder.

## Usage

Browse an eBay search results page (ebay.co.uk, ebay.com, .de, .fr, .com.au,
.ca) as normal. Under each listing a small badge appears per comparison
source:

- `JP eBay ~£8.40` — median of the cheapest Japan-located Buy-It-Now matches
  (click to open that search and verify).
- `Cardmarket ~€7.50 ≈£6.38` — median of the cheapest Cardmarket matches,
  converted with the rate from settings.
- A verdict such as **▼ 34% below best alternative** — when the listing is at
  least the threshold (default 20%) below the cheapest alternative, the whole
  listing is outlined green.

On a single item page (`/itm/…`) a floating panel appears in the bottom-right
corner with the same comparison.

Settings live in the toolbar popup: enable/disable sources, deal threshold,
Cardmarket game section (Pokémon by default), EUR conversion rate, and the
max number of listings checked per page. Reload the eBay page after changing
them.

## How it works

- **eBay (Japan)** — eBay has no separate Japanese marketplace, so "Japanese
  eBay" means your local eBay site filtered to items located in Japan
  (`LH_LocatedIn=1&_salic=104` — the same filter as Advanced Search →
  "Located in: Japan"). Prices come back in your site's currency, so no
  conversion is needed. The background service worker fetches the search page
  directly (Buy-It-Now only, sorted by price + postage) and parses it in an
  offscreen document.
- **Cardmarket** — sits behind Cloudflare, so plain fetches won't work.
  Instead the extension runs a single hidden background worker tab (a "side
  instance"), navigates it through the queued searches, scrapes the prices
  with a content script, and closes the tab after ~45 s of inactivity. If a
  search matches exactly one product, Cardmarket redirects to the product
  page and the actual offers are scraped instead of the search list.
- **Comparison** — for each source the extension takes the *median of the
  cheapest ~12 matches* (more robust than the single cheapest, which is often
  junk or damaged). The reference price is the cheapest source, converted to
  your currency; a listing is flagged as a deal when it is at least the
  threshold below that reference.
- **Politeness** — one request at a time per source, 1.5 s gaps for eBay,
  4 s for Cardmarket, identical queries deduplicated, results cached for
  6 hours in `chrome.storage.local`.

## Limitations / notes

- **Matching is heuristic.** Queries are built from listing titles, so wrong
  or mixed matches happen (different set, different grade, bundles). Treat
  highlights as leads and click the badge to verify before buying.
- **Shipping is not included** in the comparison — Japan-located and
  Cardmarket sellers usually charge more postage than domestic ones.
- **Cardmarket prices are in EUR**; conversion uses the fixed rate in
  settings (no external FX API, to keep everything local). Update it now and
  then.
- **Cloudflare** may occasionally challenge the Cardmarket worker tab. The
  "Just a moment…" page usually solves itself; if lookups keep failing, open
  cardmarket.com once in a normal tab, then retry.
- Both sites change their markup regularly; selectors may need occasional
  updates.
- Scraping is for **personal use** — keep the rate limits polite and respect
  the sites' terms of service.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `content.js` / `content.css` | eBay page scanner, badges, deal highlighting |
| `background.js` | Lookup queues, caching, rate limiting, Cardmarket worker-tab orchestration |
| `offscreen.html` / `offscreen.js` | Parses fetched eBay search HTML (service workers have no DOMParser) |
| `cm-scraper.js` | Runs in the hidden Cardmarket worker tab, scrapes prices |
| `money.js` | Shared price/currency parsing |
| `popup.html` / `popup.js` | Settings UI |
