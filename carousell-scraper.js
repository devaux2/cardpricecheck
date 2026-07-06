// Card Price Check — Carousell worker-tab scraper.
//
// Runs on every carousell.com.hk page but only acts when the page was opened
// by this extension's hidden worker tab (marked with a #cpc-worker:<jobId>
// hash; Carousell is an SPA and sometimes strips the hash, so the background
// can also be polled for the job id). The page hydrates client-side, so the
// script waits for listing cards to appear, scrapes them once and reports to
// the background worker. On normal Carousell browsing it does nothing.

(async () => {
  const KIND = 'carousell';
  const DEADLINE_MS = 15000; // hydration wait budget
  const MAX_LISTINGS = 60;

  // Relative-time text as Carousell renders it — English ("2 days ago") or
  // Chinese ("2日前" / "2天前"). Passed through raw, never parsed.
  const REL_TIME = /(?:\bjust now\b|\b(?:an?|\d+)\s*(?:sec(?:ond)?s?|min(?:ute)?s?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago\b|\d+\s*(?:秒|分鐘|分钟|小時|小时|日|天|週|周|個月|个月|月|年)前)/i;

  // Condition labels shown on cards; never the title.
  const CONDITION = /^(?:brand new|like new|lightly used|well used|heavily used|new|used|全新|幾乎全新|輕微使用|明顯使用|殘舊)$/i;

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

  // Carousell fronts bot checks with PerimeterX ("Press & Hold") and the
  // occasional generic captcha interstitial.
  function isBlocked() {
    if (document.querySelector('#px-captcha, #challenge-form, iframe[src*="captcha"]')) return true;
    return /access denied|just a moment|attention required|verify you are (?:a )?human|robot check/i
      .test(document.title);
  }

  function needsLogin() {
    if (/^\/(login|signup|sign-in)(\/|$)/.test(location.pathname)) return true;
    return /^\s*(?:log ?in|sign ?in)\b/i.test(document.title) || /^登入/.test(document.title);
  }

  // -------------------------------------------------------- shared helpers ----

  /** First non-empty string value among the given keys of obj, trimmed. */
  function firstString(obj, keys) {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  // ------------------------------------------- strategy 1: __NEXT_DATA__ ----

  /**
   * Carousell is a Next.js app; the SSR payload in #__NEXT_DATA__ carries the
   * search results as JSON. The exact shape shifts between releases, so
   * rather than hardcoding a path we walk the whole tree and keep anything
   * listing-shaped.
   */
  function fromNextData() {
    const el = document.getElementById('__NEXT_DATA__');
    if (!el || !el.textContent) return [];
    let data;
    try {
      data = JSON.parse(el.textContent);
    } catch {
      return [];
    }
    const found = new Map(); // id -> listing, dedupes
    const stack = [data];
    while (stack.length && found.size < MAX_LISTINGS) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        // Push in reverse so pop() visits in document order — the first (and
        // usually richest) copy of a listing wins, and the cap keeps the
        // first MAX_LISTINGS results rather than an arbitrary subset.
        for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
        continue;
      }
      const listing = asListing(node);
      if (listing && !found.has(listing.id)) found.set(listing.id, listing);
      const values = Object.values(node);
      for (let i = values.length - 1; i >= 0; i -= 1) stack.push(values[i]);
    }
    return [...found.values()];
  }

  /**
   * First aboveFold/belowFold card component whose stringContent passes
   * `want`. These arrays hold the small texts rendered on the card (price,
   * bump state, relative time, ...).
   */
  function foldText(fold, want) {
    if (!Array.isArray(fold)) return null;
    for (const part of fold) {
      if (!part || typeof part !== 'object') continue;
      const t = typeof part.stringContent === 'string' ? part.stringContent.trim() : '';
      if (t && t.length <= 60 && want(t)) return t;
    }
    return null;
  }

  /** First usable photo URL on a __NEXT_DATA__ listing object. */
  function listingImage(obj) {
    if (Array.isArray(obj.photoUrls) && typeof obj.photoUrls[0] === 'string' && obj.photoUrls[0]) {
      return obj.photoUrls[0];
    }
    const flat = firstString(obj, ['thumbnailUrl', 'thumbnailURL', 'imageUrl', 'primaryPhotoUrl']);
    if (flat) return flat;
    if (Array.isArray(obj.photos) && obj.photos[0] && typeof obj.photos[0] === 'object') {
      return firstString(obj.photos[0], ['thumbnailUrl', 'imageUrl', 'url']);
    }
    return null;
  }

  /** Interpret one JSON object as a listing, or null if it isn't one. */
  function asListing(obj) {
    const rawId = obj.id != null ? obj.id : obj.listingID != null ? obj.listingID : obj.listingId;
    if (rawId == null || !/^\d+$/.test(String(rawId))) return null;
    const title = firstString(obj, ['title', 'listingTitle']);
    if (!title) return null;
    const priceText =
      firstString(obj, ['priceFormatted', 'formattedPrice', 'price', 'currentPrice']) ||
      foldText(obj.belowFold, (t) => !!parseMoney(t));
    const image = listingImage(obj);
    // Plenty of unrelated objects carry an id and a title (collections,
    // categories, promos) — require a price or a photo before trusting it.
    if (!priceText && !image) return null;
    const id = String(rawId);
    let url = firstString(obj, ['canonicalUrl', 'listingUrl', 'url']);
    if (url && url.startsWith('/')) url = location.origin + url;
    if (!url || !/^https?:/.test(url)) url = 'https://www.carousell.com.hk/p/' + id;
    const postedText =
      foldText(obj.aboveFold, (t) => REL_TIME.test(t)) ||
      (typeof obj.timeCreated === 'string' && REL_TIME.test(obj.timeCreated)
        ? obj.timeCreated.trim()
        : null);
    return { id, title, priceText: priceText || null, url, image, postedText };
  }

  // ------------------------------------------------ strategy 2: DOM cards ----

  /**
   * Leaf elements' trimmed texts inside root, in document order. Scanning
   * leaves keeps the price, title, time etc. as separate strings instead of
   * one glued-together textContent.
   */
  function leafTexts(root) {
    const out = [];
    for (const el of root.querySelectorAll('p, span, div, h1, h2, h3, h4, time')) {
      if (el.children.length) continue;
      const t = el.textContent.trim();
      if (t) out.push(t);
    }
    return out;
  }

  /** Walk up from the listing link to something that looks like the card. */
  function cardOf(a) {
    const marked = a.closest('[data-testid*="listing"]');
    if (marked) return marked;
    let el = a;
    for (let i = 0; i < 4 && el.parentElement; i += 1) {
      el = el.parentElement;
      if (el.querySelector('img') && /\$\s*\d/.test(el.textContent)) return el;
    }
    return a; // never fall back to the whole results grid
  }

  function pickTitle(a, card) {
    const attr = (a.getAttribute('title') || '').trim();
    if (attr) return attr;
    // The /p/ anchor wraps the title and price but not the seller link, so
    // prefer its leaves; the first one that isn't a price, a relative time,
    // a condition label or a bare count is the title.
    let texts = leafTexts(a);
    if (!texts.length && card !== a) texts = leafTexts(card);
    for (const t of texts) {
      if (t.length < 2 || /^\d+$/.test(t)) continue;
      if ((t.length <= 15 && parseMoney(t)) || REL_TIME.test(t) || CONDITION.test(t)) continue;
      return t;
    }
    return null;
  }

  function pickPrice(a, card) {
    let texts = leafTexts(a);
    if (!texts.length && card !== a) texts = leafTexts(card);
    for (const t of texts) {
      if (t.length <= 20 && /(?:HK\$|\$)\s*\d/.test(t)) return t;
    }
    return null;
  }

  function pickPosted(card) {
    for (const t of leafTexts(card)) {
      if (t.length <= 30 && REL_TIME.test(t)) return t;
    }
    return null;
  }

  function pickImage(card) {
    const img = card.querySelector('img');
    if (!img) return null;
    return img.currentSrc || img.src || null;
  }

  function fromDom() {
    const found = new Map(); // id -> listing, dedupes
    for (const a of document.querySelectorAll('a[href*="/p/"]')) {
      if (found.size >= MAX_LISTINGS) break;
      let u;
      try {
        u = new URL(a.getAttribute('href') || '', location.origin);
      } catch {
        continue;
      }
      if (u.origin !== location.origin || !u.pathname.startsWith('/p/')) continue;
      // /p/some-slug-1234567890 -> '1234567890'
      const idm = u.pathname.replace(/\/+$/, '').match(/(\d+)$/);
      if (!idm) continue;
      const id = idm[1];
      if (found.has(id)) continue;
      const card = cardOf(a);
      const title = pickTitle(a, card);
      if (!title) continue;
      found.set(id, {
        id,
        title,
        priceText: pickPrice(a, card),
        url: u.origin + u.pathname,
        image: pickImage(card),
        postedText: pickPosted(card),
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
    let listings = fromNextData();
    if (!listings.length) listings = fromDom();
    if (listings.length) {
      send({ listings });
      return;
    }
    if (Date.now() >= deadline) {
      send({ listings: [] }); // give up early so the background can move on
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
})();
