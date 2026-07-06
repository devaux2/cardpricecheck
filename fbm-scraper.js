// Card Price Check — Facebook Marketplace worker-tab scraper.
//
// Runs on every facebook.com/marketplace page but only acts when the page was
// opened by this extension's hidden worker tab (marked with a
// #cpc-worker:<jobId> hash; Facebook is an SPA and may strip the hash, so the
// background can also be polled for the job id). Marketplace hydrates
// client-side, so the script waits for result cards to appear, scrapes them
// once and reports to the background worker. On normal browsing it does
// nothing.
//
// Facebook's markup is obfuscated (generated class names that change per
// build), so everything here keys off structure only: item anchors, their
// innerText lines and their images — never class names.

(async () => {
  const KIND = 'fbm';
  const DEADLINE_MS = 20000; // hydration wait budget
  const MAX_LISTINGS = 60;

  // "Free" listings have no money line; reported with priceText null.
  const FREE = /^(?:free|免費|免费)$/i;

  // ---------------------------------------------------------------- gating ----

  let jobId = null;
  const m = location.hash.match(/^#cpc-worker:(\w+)/);
  if (m) {
    jobId = m[1];
  } else {
    // The SPA may have stripped the hash — ask the background whether this
    // tab is the worker. Anything but a job id means normal user browsing.
    try {
      const res = await chrome.runtime.sendMessage({ type: 'cpc-worker-poll' });
      jobId = res && res.jobId;
    } catch {
      return; // extension reloading mid-flight
    }
    if (!jobId) return;
  }

  const send = (payload) => {
    try {
      chrome.runtime.sendMessage({
        type: 'cpc-scrape-result',
        jobId,
        kind: KIND,
        url: location.href.split('#')[0],
        ...payload,
      });
    } catch { /* extension reloaded mid-flight */ }
  };

  // ------------------------------------------------- blocked / login walls ----

  function isBlocked() {
    if (document.querySelector('iframe[src*="captcha"], img[src*="captcha"], #captcha')) return true;
    return /security check|captcha|temporarily blocked/i.test(document.title);
  }

  // Facebook bounces logged-out (or flagged) visitors to /login or
  // /checkpoint; sometimes it stays on the marketplace URL but renders the
  // login form instead of results.
  function needsLogin() {
    return location.pathname.includes('/login') || location.pathname.includes('/checkpoint');
  }

  function showsLoginForm() {
    if (document.querySelector('form[action*="login"]')) return true;
    return !!(document.querySelector('input[name="email"]') && document.querySelector('input[name="pass"]'));
  }

  // -------------------------------------------------------------- scraping ----

  // A card line that is a price — money-only lines are short; long lines that
  // merely contain an amount are more likely titles ("2 boxes $100 each").
  function isPriceLine(t) {
    return t.length <= 25 && !!parseMoney(t);
  }

  /**
   * Pick the title from a card's non-price innerText lines: prefer the
   * longest line over 10 chars (location lines like "Hong Kong" are short),
   * falling back to the longest line at all.
   */
  function pickTitle(lines) {
    let longest = null;
    let longestOk = null;
    for (const t of lines) {
      if (!longest || t.length > longest.length) longest = t;
      if (t.length > 10 && (!longestOk || t.length > longestOk.length)) longestOk = t;
    }
    return longestOk || longest;
  }

  function scrape() {
    const found = new Map(); // id -> listing, dedupes (the grid repeats items)
    for (const a of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
      if (found.size >= MAX_LISTINGS) break;
      const href = a.getAttribute('href') || '';
      const idm = href.match(/\/marketplace\/item\/(\d+)/);
      if (!idm) continue;
      const id = idm[1];
      if (found.has(id)) continue;
      let u;
      try {
        u = new URL(href, location.origin);
      } catch {
        continue;
      }
      // The card's small texts come out as separate innerText lines:
      // price, title, location (in varying order).
      const lines = (a.innerText || '').split('\n').map((t) => t.trim()).filter(Boolean);
      if (!lines.length) continue;
      let priceText = null;
      let sawPrice = false;
      const rest = [];
      for (const t of lines) {
        if (FREE.test(t)) {
          sawPrice = true; // a price line, but reported as null
          continue;
        }
        if (isPriceLine(t)) {
          if (!sawPrice) {
            sawPrice = true;
            priceText = t; // raw, e.g. "HK$1,200" — never parsed here
          }
          continue; // later money lines are struck-through old prices
        }
        rest.push(t);
      }
      const title = pickTitle(rest);
      if (!title) continue;
      const img = a.querySelector('img');
      found.set(id, {
        id,
        title,
        priceText,
        url: u.origin + u.pathname, // query params are tracking noise
        image: img ? img.currentSrc || img.src || null : null,
        postedText: null, // the grid doesn't show it
      });
    }
    return [...found.values()];
  }

  // ------------------------------------------------------------ main loop ----

  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    if (isBlocked()) {
      send({ blocked: true });
      return;
    }
    if (needsLogin()) {
      send({ loginRequired: true });
      return;
    }
    const listings = scrape();
    if (listings.length) {
      send({ listings });
      return;
    }
    // Login form with no marketplace content — results will never hydrate.
    if (showsLoginForm()) {
      send({ loginRequired: true });
      return;
    }
    if (Date.now() >= deadline) {
      send({ listings: [] }); // give up early so the background can move on
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
})();
