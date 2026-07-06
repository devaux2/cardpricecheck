// Card Price Check — eBay page annotator.
//
// Scans the search results (or the item page) you are looking at, asks the
// background worker for comparison prices per enabled source, shows a small
// badge on each listing and highlights listings that are significantly
// cheaper than the best alternative.

(() => {
  const DEFAULTS = {
    enabled: true,
    threshold: 20,     // % cheaper than the best alternative to count as a deal
    maxListings: 50,   // per page, keeps request volume sane
    srcJp: true,       // eBay, items located in Japan
    srcCm: true,       // Cardmarket
    srcEb: false,      // eBay, all locations
    game: 'Pokemon',   // Cardmarket game section
    eurRate: 0.85,     // EUR -> local currency, used only for Cardmarket
  };

  const SOURCE_LABELS = { jp: 'JP eBay', cm: 'Cardmarket', eb: 'eBay all' };

  let settings = DEFAULTS;
  let processed = 0;

  chrome.storage.sync.get(DEFAULTS).then((s) => {
    settings = s;
    init();
  });

  function init() {
    if (!settings.enabled) return;
    // Don't run on Japan-located searches — those are the comparison pages
    // this extension opens itself; annotating them would cascade lookups.
    if (new URLSearchParams(location.search).get('_salic') === '104') return;
    if (location.pathname.startsWith('/itm/')) initItemPage();
    else initSearchPage();
  }

  // ------------------------------------------------------- search pages ----

  function initSearchPage() {
    scan();
    const target = document.querySelector('ul.srp-results') || document.body;
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 600);
    }).observe(target, { childList: true, subtree: true });
  }

  function listingNodes() {
    let nodes = document.querySelectorAll('ul.srp-results li.s-item, ul.srp-results li.s-card');
    if (!nodes.length) nodes = document.querySelectorAll('li.s-item, li.s-card, .su-card-container');
    return [...nodes];
  }

  function scan() {
    for (const node of listingNodes()) {
      if (processed >= settings.maxListings) break;
      if (node.dataset.cpcDone) continue;
      node.dataset.cpcDone = '1';
      const title = textOf(node, ['.s-item__title', '.s-card__title', '[role="heading"]']);
      if (!title || /shop on ebay/i.test(title)) continue;
      const local = parseMoney(textOf(node, ['.s-item__price', '.s-card__price', '[class*="price"]']));
      if (!local) continue;
      processed += 1;
      const badge = document.createElement('div');
      badge.className = 'cpc-badge';
      (node.querySelector('.s-item__info') || node).appendChild(badge);
      attachChecks(badge, node, title, local);
    }
  }

  // ---------------------------------------------------------- item pages ----

  function initItemPage() {
    const title = textOf(document, ['h1.x-item-title__mainTitle', '.x-item-title__mainTitle', 'h1']);
    const local = parseMoney(textOf(document, ['.x-price-primary', '[data-testid="x-price-primary"]', '.x-price-approx__price']));
    if (!title || !local) return;

    const panel = document.createElement('div');
    panel.className = 'cpc-panel';
    const head = document.createElement('div');
    head.className = 'cpc-panel-title';
    head.append('Card Price Check');
    const close = document.createElement('button');
    close.className = 'cpc-close';
    close.textContent = '✕';
    close.addEventListener('click', () => panel.remove());
    head.appendChild(close);
    const badge = document.createElement('div');
    badge.className = 'cpc-badge cpc-badge--column';
    panel.append(head, badge);
    document.body.appendChild(panel);

    attachChecks(badge, panel, title, local);
  }

  // ------------------------------------------------------------- lookups ----

  function activeSources() {
    const active = [];
    if (settings.srcJp) active.push('jp');
    if (settings.srcCm) active.push('cm');
    if (settings.srcEb) active.push('eb');
    return active;
  }

  function attachChecks(badge, highlightNode, title, local) {
    const sources = activeSources();
    if (!sources.length) return;
    const state = { highlightNode, badge, local, results: {}, pending: sources.length };
    for (const src of sources) {
      const slot = document.createElement('a');
      slot.className = 'cpc-slot cpc-pending';
      slot.textContent = `${SOURCE_LABELS[src]} …`;
      slot.target = '_blank';
      slot.rel = 'noopener';
      badge.appendChild(slot);
      request(src, title).then((res) => {
        state.results[src] = res;
        renderSlot(slot, SOURCE_LABELS[src], res, local);
        state.pending -= 1;
        if (state.pending === 0) evaluate(state);
      });
    }
  }

  function request(source, title) {
    return chrome.runtime
      .sendMessage({
        type: 'cpc-check',
        source,
        query: title,
        domain: location.hostname,
        game: settings.game,
      })
      .catch((e) => ({ ok: false, error: String(e) }));
  }

  function renderSlot(slot, label, res, local) {
    slot.classList.remove('cpc-pending');
    if (res && res.url) slot.href = res.url;
    if (!res || !res.ok) {
      slot.classList.add('cpc-error');
      slot.textContent = `${label} ✕`;
      slot.title = (res && res.error) || 'lookup failed';
      return;
    }
    if (!res.count) {
      slot.classList.add('cpc-none');
      slot.textContent = `${label}: no matches`;
      slot.title = 'No comparable listings found — click to see the search';
      return;
    }
    const conv = convert(res, local);
    let text = `${label} ~${fmt(res.currency, res.median)}`;
    if (conv && res.currency !== local.symbol) text += ` ≈${fmt(local.symbol, conv.median)}`;
    slot.textContent = text;
    slot.title = `${res.count} matches · cheapest ${fmt(res.currency, res.min)} · median of the cheapest few shown · click to view`;
  }

  // Convert a source result into the local currency; null when we can't.
  function convert(res, local) {
    if (res.currency === local.symbol) return { median: res.median, min: res.min };
    if (res.currency === '€' && settings.eurRate > 0) {
      return { median: res.median * settings.eurRate, min: res.min * settings.eurRate };
    }
    return null;
  }

  function evaluate(state) {
    const refs = [];
    for (const res of Object.values(state.results)) {
      if (!res || !res.ok || !res.count) continue;
      const conv = convert(res, state.local);
      if (conv && conv.median > 0) refs.push(conv.median);
    }
    if (!refs.length) return;
    const ref = Math.min(...refs); // cheapest alternative market
    const pct = Math.round((1 - state.local.value / ref) * 100);
    const verdict = document.createElement('span');
    verdict.className = 'cpc-verdict';
    if (state.local.value <= ref * (1 - settings.threshold / 100)) {
      state.highlightNode.classList.add('cpc-deal');
      verdict.classList.add('cpc-verdict--deal');
      verdict.textContent = `▼ ${pct}% below best alternative`;
    } else if (state.local.value >= ref * (1 + settings.threshold / 100)) {
      verdict.classList.add('cpc-verdict--over');
      verdict.textContent = `▲ ${Math.abs(pct)}% above`;
    } else {
      verdict.textContent = `≈ market (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)`;
    }
    state.badge.prepend(verdict);
  }

  function fmt(symbol, value) {
    if (value == null) return '?';
    const v = symbol === '¥' ? Math.round(value).toString() : value.toFixed(2);
    return `${symbol}${v}`;
  }
})();
