// Card Price Check — Cardmarket "side instance" scraper.
//
// Runs on cardmarket.com but only acts when the page was opened by this
// extension's hidden worker tab (marked with a #cpc-worker:<jobId> hash;
// the hash survives Cardmarket's redirect from a single-match search to
// the product page). Scrapes prices and reports them to the background
// worker. On normal Cardmarket browsing it does nothing.

(() => {
  const m = location.hash.match(/^#cpc-worker:(\w+)/);
  if (!m) return;
  const jobId = m[1];

  // Cloudflare "Just a moment…" interstitials usually solve themselves and
  // reload into the real page (where this script runs again); stay quiet so
  // the background keeps waiting instead of recording a failure.
  if (/just a moment/i.test(document.title)) return;

  const send = (payload) => {
    try {
      chrome.runtime.sendMessage({
        type: 'cpc-scrape-result',
        jobId,
        kind: 'cm',
        url: location.href.split('#')[0],
        ...payload,
      });
    } catch { /* extension reloaded mid-flight */ }
  };

  if (/attention required|access denied/i.test(document.title) || document.querySelector('#challenge-form')) {
    send({ blocked: true });
    return;
  }

  // A leaf element whose entire text is a money string (e.g. "3,50 €").
  // Scanning leaves avoids textContent concatenation gluing an availability
  // count onto the price ("42" + "3,50 €" → "423,50 €").
  function leafMoney(root) {
    for (const el of root.querySelectorAll('span, div, td, dd, b, strong')) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (!t || t.length > 15 || !/[€£$¥]/.test(t)) continue;
      const money = parseMoney(t);
      if (money) return money;
    }
    return null;
  }

  const values = [];
  let currency = null;
  let pageKind;

  const collect = (money) => {
    if (!money) return;
    values.push(money.value);
    if (!currency) currency = money.symbol;
  };

  if (document.querySelector('.article-row')) {
    // Product page: each .article-row is one seller's offer for this card.
    pageKind = 'product';
    for (const row of document.querySelectorAll('.article-row')) {
      const money = parseMoney(textOf(row, ['.price-container'])) || leafMoney(row);
      collect(money);
      if (values.length >= 15) break;
    }
  } else {
    // Search results: one row per product, with a "From" (lowest offer) price.
    pageKind = 'search';
    let rows = [...document.querySelectorAll('#ProductsTable .table-body > div')];
    if (!rows.length) {
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/Products/"]')) {
        const row = a.closest('div[class*="row"], tr');
        if (row && !seen.has(row)) {
          seen.add(row);
          rows.push(row);
        }
      }
    }
    for (const row of rows) {
      collect(leafMoney(row));
      if (values.length >= 15) break;
    }
  }

  send({ values, currency, pageKind });
})();
