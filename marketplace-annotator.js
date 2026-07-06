// Card Price Check — Carousell / Facebook Marketplace page annotator.
//
// The live-browsing counterpart of the watch scanner: while you browse
// Carousell HK or FBM search results, each listing gets a badge with the
// price of the same card from Japan-located eBay sellers (the reference
// market), and listings sitting well below that reference are highlighted.
// eBay prices come back in USD; HKD is pegged to USD, so one fixed,
// user-editable rate converts them.
//
// Must NOT run in the extension's own hidden worker tab (that tab exists to
// scrape, not to trigger more lookups) — worker pages are identified by
// their cpcw URL param / #cpc-worker hash, or by asking the background.

(() => {
  const DEFAULTS = {
    enabled: true,
    threshold: 20,   // % below the reference to count as a deal
    maxListings: 50, // per page, keeps request volume sane
    srcJp: true,     // eBay, items located in Japan
    srcEb: false,    // eBay, all locations
    usdToHkd: 7.8,   // HKD is pegged at 7.75–7.85; editable in the popup
  };
  const SOURCE_LABELS = { jp: 'JP eBay', eb: 'eBay all' };
  const REF_DOMAIN = 'www.ebay.com'; // forces USD reference prices

  const isFbm = location.hostname === 'www.facebook.com';
  let settings = DEFAULTS;
  let processed = 0;

  const REL_TIME = /(?:just now|\b(?:an?|\d+)\s*(?:sec|min|hour|hr|day|week|month|year)|\d+\s*(?:秒|分鐘|小時|日|天|週|周|月|年)前)/i;
  const CONDITION = /^(?:brand new|like new|lightly used|well used|heavily used|new|used|全新|幾乎全新|輕微使用|明顯使用|殘舊)$/i;

  init();

  async function init() {
    if (new URLSearchParams(location.search).has('cpcw')) return;
    if (location.hash.startsWith('#cpc-worker')) return;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'cpc-worker-poll' });
      if (r && r.jobId) return; // worker tab whose SPA stripped the markers
    } catch {
      return; // extension reloading
    }
    settings = await chrome.storage.sync.get(DEFAULTS);
    if (!settings.enabled || (!settings.srcJp && !settings.srcEb)) return;
    scan();
    let debounce = null;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(scan, 800);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function scan() {
    const anchors = document.querySelectorAll(
      isFbm ? 'a[href*="/marketplace/item/"]' : 'a[href*="/p/"]');
    for (const a of anchors) {
      if (processed >= settings.maxListings) break;
      if (a.dataset.cpcDone) continue;
      a.dataset.cpcDone = '1';
      const info = isFbm ? extractFbm(a) : extractCarousell(a);
      if (!info) continue;
      processed += 1;
      annotate(a, info);
    }
  }

  // ---------------------------------------------------------- extraction ----

  /** Leaf texts inside root, in document order (keeps price/title apart). */
  function leafTexts(root) {
    const out = [];
    for (const el of root.querySelectorAll('p, span, div, h1, h2, h3, h4, time')) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (t) out.push(t);
    }
    return out;
  }

  // A money-and-nothing-else line (a price tag, not a title containing one).
  function isPriceOnly(t) {
    if (t.length > 25 || !parseMoney(t)) return false;
    const rest = t
      .replace(/US\s?\$|HK\s?\$|AU\s?\$|C\s?\$|NZ\s?\$|NT\s?\$|S\s?\$|EUR|JPY|HKD|£|\$|€|¥/gi, '')
      .replace(/[\d.,\s]/g, '');
    return rest.length <= 2;
  }

  function extractCarousell(a) {
    let u;
    try {
      u = new URL(a.getAttribute('href') || '', location.origin);
    } catch { return null; }
    if (!u.pathname.startsWith('/p/')) return null;
    const card = a.closest('[data-testid*="listing"]') || a.parentElement || a;
    let title = (a.getAttribute('title') || '').trim();
    let priceText = null;
    for (const t of leafTexts(card)) {
      if (!priceText && isPriceOnly(t) && /(?:HK\$|\$)\s*\d/.test(t)) { priceText = t; continue; }
      if (!title && t.length >= 2 && !/^\d+$/.test(t)
          && !isPriceOnly(t) && !REL_TIME.test(t) && !CONDITION.test(t)) title = t;
    }
    const local = priceText ? parseMoney(priceText) : null;
    if (!title || !local) return null;
    return { title, local, host: card };
  }

  function extractFbm(a) {
    const lines = (a.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
    if (!lines.length) return null;
    let priceText = null;
    const rest = [];
    for (const t of lines) {
      if (isPriceOnly(t)) { if (!priceText) priceText = t; continue; }
      rest.push(t);
    }
    let title = null;
    for (const t of rest) {
      if (t.length > 10 && (!title || t.length > title.length)) title = t;
    }
    if (!title) title = rest.sort((x, y) => y.length - x.length)[0] || null;
    const local = priceText ? parseMoney(priceText) : null;
    if (!title || !local) return null;
    // Badges can't live inside the link (clicks would navigate); use the
    // grid cell wrapping the anchor.
    return { title, local, host: a.parentElement || a };
  }

  // ---------------------------------------------------------- annotation ----

  function annotate(a, info) {
    const badge = document.createElement('div');
    badge.className = 'cpc-badge';
    // Never inside the anchor itself — our badge links must stay clickable.
    if (info.host.contains(a) && info.host !== a) info.host.appendChild(badge);
    else a.insertAdjacentElement('afterend', badge);

    const sources = [];
    if (settings.srcJp) sources.push('jp');
    if (settings.srcEb) sources.push('eb');
    const state = { host: info.host, badge, local: info.local, results: {}, pending: sources.length };

    for (const src of sources) {
      const slot = document.createElement('a');
      slot.className = 'cpc-slot cpc-pending';
      slot.textContent = `${SOURCE_LABELS[src]} …`;
      slot.target = '_blank';
      slot.rel = 'noopener';
      badge.appendChild(slot);
      chrome.runtime
        .sendMessage({ type: 'cpc-check', source: src, query: info.title, domain: REF_DOMAIN })
        .catch((e) => ({ ok: false, error: String(e) }))
        .then((res) => {
          state.results[src] = res;
          renderSlot(slot, SOURCE_LABELS[src], res);
          state.pending -= 1;
          if (state.pending === 0) evaluate(state);
        });
    }
  }

  /** Reference median converted into HK$, or null when that isn't possible. */
  function toHkd(res) {
    if (!res || !res.ok || !res.count || !res.median) return null;
    if (res.currency === '$') return res.median * settings.usdToHkd;
    if (res.currency === 'HK$') return res.median;
    return null;
  }

  function renderSlot(slot, label, res) {
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
      slot.title = 'No comparable eBay listings found — click to see the search';
      return;
    }
    const hkd = toHkd(res);
    slot.textContent = `${label} ~$${res.median.toFixed(0)}${hkd ? ` ≈HK$${hkd.toFixed(0)}` : ''}`;
    slot.title = `${res.count} matches · cheapest $${(res.min || 0).toFixed(2)} · median of the cheapest few · click to view`;
  }

  function evaluate(state) {
    const refs = Object.values(state.results).map(toHkd).filter((v) => v && v > 0);
    if (!refs.length) return;
    const ref = Math.min(...refs);
    // Carousell always shows HK$; FBM in Hong Kong renders plain "$" but
    // means HK$, so both symbols are treated as HKD here.
    if (state.local.symbol !== 'HK$' && state.local.symbol !== '$') return;
    const pct = Math.round((1 - state.local.value / ref) * 100);
    const verdict = document.createElement('span');
    verdict.className = 'cpc-verdict';
    if (state.local.value <= ref * (1 - settings.threshold / 100)) {
      state.host.classList.add('cpc-deal');
      verdict.classList.add('cpc-verdict--deal');
      verdict.textContent = `▼ ${pct}% below JP eBay`;
    } else if (state.local.value >= ref * (1 + settings.threshold / 100)) {
      verdict.classList.add('cpc-verdict--over');
      verdict.textContent = `▲ ${Math.abs(pct)}% above`;
    } else {
      verdict.textContent = `≈ market (${pct >= 0 ? '−' : '+'}${Math.abs(pct)}%)`;
    }
    state.badge.prepend(verdict);
  }
})();
