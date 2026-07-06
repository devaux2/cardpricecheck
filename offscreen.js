// Offscreen document: parses eBay search-result HTML fetched by the
// background service worker (which has no DOMParser of its own).

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'cpc-parse-ebay') return;
  try {
    sendResponse(parseEbaySearch(msg.html));
  } catch (e) {
    sendResponse({ values: [], currency: null, error: String(e) });
  }
});

function parseEbaySearch(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // Classic results use li.s-item; the newer search experience uses li.s-card.
  let items = doc.querySelectorAll('li.s-item, li.s-card');
  if (!items.length) items = doc.querySelectorAll('.su-card-container, .s-card');
  const values = [];
  let currency = null;
  for (const item of items) {
    const title = textOf(item, ['.s-item__title', '.s-card__title', '[role="heading"]']);
    if (/shop on ebay/i.test(title)) continue; // eBay's dummy first result
    const money = parseMoney(textOf(item, ['.s-item__price', '.s-card__price', '[class*="price"]']));
    if (!money) continue;
    values.push(money.value);
    if (!currency) currency = money.symbol;
  }
  return { values, currency };
}
