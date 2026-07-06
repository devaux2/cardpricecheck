// Card Price Check — background service worker.
//
// Two engines, everything local to the browser:
//
// 1. On-page price comparison (content.js on eBay pages asks for it):
//    - "jp" / "eb": eBay searches fetched directly by the service worker and
//      parsed in an offscreen document (service workers have no DOMParser).
//    - "cm": Cardmarket lookups run through the shared hidden worker tab.
//
// 2. Watches (periodic deal scanning of Carousell HK / Facebook Marketplace):
//    chrome.alarms fires every few hours while the browser is open; each
//    enabled watch's search runs through the same hidden worker tab, new
//    listings are filtered (grade / Japanese / set / release date / price /
//    age), deduplicated against what has been seen before, stored as deals,
//    and surfaced via a notification and the action badge.
//
// The worker tab is a single reused background tab (a "side instance") —
// needed because Cardmarket sits behind Cloudflare and Facebook requires the
// user's own logged-in session. It closes after ~45s of inactivity. Each
// source has its own pacing, and every result is cached where that is safe.

importScripts('money.js', 'sets.js', 'watch-filters.js');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SOURCE_GAP_MS = { jp: 1500, eb: 1500, cm: 4000 };
const WORKER_LANE_GAP_MS = 1000;
const CM_JOB_TIMEOUT_MS = 30 * 1000;
const WATCH_JOB_TIMEOUT_MS = 45 * 1000;
// Must stay comfortably below the ~30s MV3 idle timeout: the keepalive runs
// while the worker tab is open, so the close timer must fire before the
// service worker is allowed to die, or the hidden tab would leak.
const WORKER_TAB_IDLE_CLOSE_MS = 15 * 1000;
const SAMPLE_SIZE = 12; // price stats use the cheapest N matches

const WATCH_ALARM = 'cpcWatchAlarm';
const WATCH_GAP_MS = 5000;
const DEALS_CAP = 400;
const SEEN_CAP = 2000;
const DEFAULT_WATCH_SETTINGS = { periodMinutes: 360, notify: true };

const EBAY_DOMAINS = new Set([
  'www.ebay.com', 'www.ebay.co.uk', 'www.ebay.de',
  'www.ebay.fr', 'www.ebay.com.au', 'www.ebay.ca',
]);
const CM_GAMES = new Set([
  'Pokemon', 'Magic', 'YuGiOh', 'OnePiece', 'Lorcana',
  'Digimon', 'FleshAndBlood', 'StarWarsUnlimited',
]);

const queues = { jp: [], eb: [], cm: [] };
const pumping = { jp: false, eb: false, cm: false };
const inflight = new Map(); // cache key -> pending promise

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'cpc-check') {
    handleCheck(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'cpc-scrape-result') {
    onScrapeResult(sender, msg);
    return;
  }
  if (msg.type === 'cpc-worker-poll') {
    let isWorker = workerActive && sender.tab && sender.tab.id === workerTabId;
    // A slow page from a previous, timed-out job can still poll after the
    // lane has moved on. Its URL still carries the old cpcw=<jobId> param,
    // so refuse to hand the *current* job's id to a stale document.
    if (isWorker && sender.url) {
      try {
        const cpcw = new URL(sender.url).searchParams.get('cpcw');
        if (cpcw && cpcw !== workerActive.jobId) isWorker = false;
      } catch { /* unparsable sender url — treat as current */ }
    }
    sendResponse(isWorker ? { jobId: workerActive.jobId, kind: workerActive.kind } : { jobId: null });
    return;
  }
  if (msg.type === 'cpc-run-watches') {
    runAllWatches().then(sendResponse, (e) => sendResponse({ ok: false, added: 0, error: String(e) }));
    return true;
  }
  if (msg.type === 'cpc-mark-deals-seen') {
    markDealsSeen().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'cpc-clear-cache') {
    clearPriceCache().then(() => sendResponse({ ok: true }));
    return true;
  }
});

async function handleCheck(msg) {
  if (!queues[msg.source]) return { ok: false, error: `unknown source ${msg.source}` };
  const key = cacheKey(msg);
  const cached = await cacheGet(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve) => {
    queues[msg.source].push({ msg, key, resolve });
    pump(msg.source);
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function pump(source) {
  if (pumping[source]) return;
  pumping[source] = true;
  updateKeepalive();
  while (queues[source].length) {
    const job = queues[source].shift();
    let result;
    try {
      result = await runJob(source, job.msg);
    } catch (e) {
      result = { ok: false, error: String(e) };
    }
    if (result && result.ok) await cacheSet(job.key, result);
    job.resolve(result);
    await sleep(SOURCE_GAP_MS[source]);
  }
  pumping[source] = false;
  updateKeepalive();
}

function runJob(source, msg) {
  if (source === 'jp') return runEbayJob(msg, true);
  if (source === 'eb') return runEbayJob(msg, false);
  return runCmJob(msg);
}

// ---------------------------------------------------------------- eBay ----

async function runEbayJob(msg, japanOnly) {
  const domain = EBAY_DOMAINS.has(msg.domain) ? msg.domain : 'www.ebay.com';
  const query = buildEbayQuery(msg.query);
  if (!query) return { ok: false, error: 'could not build a search query from the title' };
  let result = await ebaySearch(domain, query, japanOnly);
  // Long noisy titles sometimes match nothing; retry once with a shorter query.
  if (result.ok && result.count === 0) {
    const shorter = query.split(' ').slice(0, 6).join(' ');
    if (shorter && shorter !== query) {
      await sleep(SOURCE_GAP_MS.jp);
      result = await ebaySearch(domain, shorter, japanOnly);
    }
  }
  return result;
}

async function ebaySearch(domain, query, japanOnly) {
  const params = new URLSearchParams({
    _nkw: query,
    LH_BIN: '1', // Buy It Now only, so prices are directly comparable
    _sop: '15',  // sort by price + postage, lowest first
    _ipg: '60',
    rt: 'nc',
  });
  if (japanOnly) {
    params.set('LH_LocatedIn', '1');
    params.set('_salic', '104'); // 104 = Japan
  }
  const url = `https://${domain}/sch/i.html?${params.toString()}`;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return { ok: false, error: `eBay responded HTTP ${res.status}`, url };
  const html = await res.text();
  const parsed = await parseInOffscreen(html);
  return { ok: true, url, query, currency: parsed.currency, ...computeStats(parsed.values) };
}

let offscreenReady = null;

async function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_PARSER'],
        justification: 'Parse fetched eBay search result pages to extract prices',
      });
    })().catch((e) => {
      offscreenReady = null;
      throw e;
    });
  }
  return offscreenReady;
}

async function parseInOffscreen(html) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: 'cpc-parse-ebay', html });
  if (!res) throw new Error('offscreen parser did not respond');
  return res;
}

// ---------------------------------------------------- shared worker tab ----
// One hidden background tab, reused for every scrape (Cardmarket, Carousell,
// Facebook Marketplace). Jobs are serialised on a single lane; scraper
// content scripts identify themselves via the #cpc-worker:<jobId> hash or,
// on SPAs that strip the hash, by polling with 'cpc-worker-poll'.

let workerTabId = null;
let workerIdleTimer = null;
let workerActive = null; // { resolve, timer, jobId, kind }
let workerJobSeq = 0;
let workerLane = Promise.resolve();

function scrapeViaWorkerTab(url, kind, timeoutMs) {
  const run = () => new Promise((resolve) => {
    const jobId = String(++workerJobSeq);
    // cpcw busts same-URL navigations so the page always reloads; the hash
    // survives server redirects and correlates the result.
    const target = `${url}${url.includes('?') ? '&' : '?'}cpcw=${jobId}#cpc-worker:${jobId}`;
    const timer = setTimeout(() => finishWorker({ ok: false, error: 'timed out' }), timeoutMs);
    workerActive = { resolve, timer, jobId, kind };
    updateKeepalive();
    openWorkerTab(target).catch((e) => finishWorker({ ok: false, error: String(e) }));
  });
  const p = workerLane.then(run);
  workerLane = p.catch(() => {}).then(() => sleep(WORKER_LANE_GAP_MS));
  return p;
}

function finishWorker(result) {
  if (!workerActive) return;
  clearTimeout(workerActive.timer);
  const { resolve } = workerActive;
  workerActive = null;
  resolve(result);
  scheduleWorkerClose();
  updateKeepalive();
}

async function openWorkerTab(url) {
  clearTimeout(workerIdleTimer);
  if (workerTabId !== null) {
    try {
      await chrome.tabs.update(workerTabId, { url });
      return;
    } catch {
      workerTabId = null; // tab was closed, fall through and recreate
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  workerTabId = tab.id;
  // Remembered across service-worker restarts so a tab orphaned by a crash
  // or extension reload can be cleaned up on the next wake.
  try { await chrome.storage.session.set({ cpcWorkerTabId: tab.id }); } catch { /* best effort */ }
}

function onScrapeResult(sender, msg) {
  if (!workerActive || !sender.tab || sender.tab.id !== workerTabId) return;
  if (msg.jobId !== workerActive.jobId) return; // stale result from a timed-out job
  if (msg.kind !== workerActive.kind) return;   // stale page answering another platform's job
  finishWorker({ ok: true, ...msg });
}

function scheduleWorkerClose() {
  clearTimeout(workerIdleTimer);
  workerIdleTimer = setTimeout(async () => {
    if (workerActive || workerTabId === null) return;
    // Null the id before the await: a job arriving mid-remove must open a
    // fresh tab rather than tabs.update() one that is being torn down.
    const closing = workerTabId;
    workerTabId = null;
    updateKeepalive(); // tab gone — let the service worker wind down
    try { await chrome.tabs.remove(closing); } catch { /* already gone */ }
    try { await chrome.storage.session.remove('cpcWorkerTabId'); } catch { /* best effort */ }
  }, WORKER_TAB_IDLE_CLOSE_MS);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== workerTabId) return;
  workerTabId = null;
  finishWorker({ ok: false, error: 'worker tab was closed' });
  updateKeepalive(); // finishWorker no-ops when no job was active
});

// ---------------------------------------------------------- Cardmarket ----

async function runCmJob(msg) {
  const game = CM_GAMES.has(msg.game) ? msg.game : 'Pokemon';
  const query = buildCmQuery(msg.query);
  if (!query) return { ok: false, error: 'could not build a Cardmarket query from the title' };
  const cleanUrl = `https://www.cardmarket.com/en/${game}/Products/Search?searchString=${encodeURIComponent(query)}`;
  const r = await scrapeViaWorkerTab(cleanUrl, 'cm', CM_JOB_TIMEOUT_MS);
  if (!r.ok) {
    const error = r.error === 'timed out'
      ? 'Cardmarket lookup timed out (slow load or bot check — open cardmarket.com once in a normal tab, then retry)'
      : r.error;
    return { ok: false, error, url: cleanUrl };
  }
  if (r.blocked) {
    return {
      ok: false, url: r.url || cleanUrl,
      error: 'Cardmarket showed a bot check — open cardmarket.com in a normal tab, pass it, then retry',
    };
  }
  return {
    ok: true,
    url: r.url || cleanUrl,
    currency: r.currency || '€',
    kind: r.pageKind,
    ...computeStats(r.values || []),
  };
}

// -------------------------------------------------------------- watches ----

let watchRunning = false;

// Out-of-the-box watches: the whole point of the extension is "find vintage
// Japanese PSA cards", so that hunt is preconfigured. Grades 1–10 means
// "must be PSA-graded, any grade" (an empty list would also accept raws).
const ALL_GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const DEFAULT_WATCHES = [
  {
    id: 'w-default-vintage', name: 'Vintage JP PSA (auto)', query: 'pokemon psa',
    platforms: { carousell: true, fbm: true }, grades: ALL_GRADES,
    japaneseOnly: true, eraMode: 'vintage', setCodes: [],
    releasedFrom: null, releasedTo: null, maxPrice: null, maxAgeDays: 7, enabled: true,
  },
  {
    id: 'w-default-kyuura', name: '旧裏 old-back (auto)', query: '旧裏',
    platforms: { carousell: true, fbm: true }, grades: ALL_GRADES,
    japaneseOnly: true, eraMode: 'vintage', setCodes: [],
    releasedFrom: null, releasedTo: null, maxPrice: null, maxAgeDays: 7, enabled: true,
  },
];

async function seedDefaultWatches() {
  const { cpcWatches } = await chrome.storage.local.get('cpcWatches');
  if (cpcWatches && cpcWatches.length) return; // never touch user-managed watches
  await chrome.storage.local.set({ cpcWatches: DEFAULT_WATCHES });
}

chrome.runtime.onInstalled.addListener(() => { seedDefaultWatches(); setupWatchAlarm(); updateBadge(); sweepExpiredCache(); });
chrome.runtime.onStartup.addListener(() => { setupWatchAlarm(); updateBadge(); sweepExpiredCache(); });

// Runs on every service-worker wake: a fresh worker means no run is actually
// in progress, so a persisted running:true is stale (Chrome quit or the SW
// died mid-run) and would lock out "Run checks now" forever. Same for a
// worker tab orphaned by a crash — close it if it still exists.
(async function recoverFromInterruptedRun() {
  try {
    const { cpcWatchStatus } = await chrome.storage.local.get('cpcWatchStatus');
    if (cpcWatchStatus && cpcWatchStatus.running && !watchRunning) {
      await chrome.storage.local.set({ cpcWatchStatus: { ...cpcWatchStatus, running: false } });
    }
    const { cpcWorkerTabId } = await chrome.storage.session.get('cpcWorkerTabId');
    if (cpcWorkerTabId != null && cpcWorkerTabId !== workerTabId) {
      try { await chrome.tabs.remove(cpcWorkerTabId); } catch { /* already gone */ }
      await chrome.storage.session.remove('cpcWorkerTabId');
    }
  } catch { /* recovery is best-effort */ }
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.cpcWatchSettings) setupWatchAlarm();
  // The options page edits cpcDeals directly (e.g. "Clear all");
  // keep the action badge in sync with the unseen count.
  if (area === 'local' && changes.cpcDeals) updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) runAllWatches().catch(() => {});
});

chrome.notifications.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function getWatchSettings() {
  const { cpcWatchSettings } = await chrome.storage.sync.get('cpcWatchSettings');
  return { ...DEFAULT_WATCH_SETTINGS, ...(cpcWatchSettings || {}) };
}

async function setupWatchAlarm() {
  const settings = await getWatchSettings();
  await chrome.alarms.clear(WATCH_ALARM);
  if (settings.periodMinutes > 0) {
    chrome.alarms.create(WATCH_ALARM, {
      periodInMinutes: Math.max(60, settings.periodMinutes),
      delayInMinutes: 3,
    });
  }
}

async function runAllWatches() {
  if (watchRunning) return { ok: false, added: 0, error: 'a check is already running' };
  watchRunning = true;
  updateKeepalive();
  const status = { lastRun: Date.now(), running: true, platforms: {} };
  const added = [];
  const platformDead = {}; // stop hammering a platform that failed this run
  try {
    await chrome.storage.local.set({ cpcWatchStatus: status });
    const { cpcWatches = [] } = await chrome.storage.local.get('cpcWatches');
    const sets = typeof CPC_JP_SETS !== 'undefined' ? CPC_JP_SETS : [];
    for (const watch of cpcWatches) {
      if (!watch.enabled) continue;
      for (const platform of ['carousell', 'fbm']) {
        if (!watch.platforms || !watch.platforms[platform]) continue;
        if (platformDead[platform]) continue;
        const url = watchSearchUrl(platform, buildWatchQuery(watch), watch.maxAgeDays);
        let r;
        try {
          r = await scrapeViaWorkerTab(url, platform, WATCH_JOB_TIMEOUT_MS);
        } catch (e) {
          r = { ok: false, error: String(e) };
        }
        const stamp = { ok: false, error: null, at: Date.now() };
        if (!r.ok) {
          stamp.error = r.error || 'lookup failed';
          platformDead[platform] = true;
        } else if (r.loginRequired) {
          const site = platform === 'fbm' ? 'facebook.com' : 'carousell.com.hk';
          stamp.error = `Not logged in — open ${site} in a normal tab, log in, then run again`;
          platformDead[platform] = true;
        } else if (r.blocked) {
          stamp.error = 'Blocked / bot check shown — open the site in a normal tab, then run again';
          platformDead[platform] = true;
        } else {
          stamp.ok = true;
          added.push(...await processListings(watch, platform, r.listings || [], sets));
        }
        status.platforms[platform] = stamp;
        await chrome.storage.local.set({ cpcWatchStatus: status });
        await sleep(WATCH_GAP_MS);
      }
    }
    if (added.length) {
      // Rank every new deal against the market before recording it, so the
      // feed can sort by "% below market". Lookups go through the normal
      // cached, rate-limited eBay queues.
      const { usdToHkd } = await chrome.storage.sync.get({ usdToHkd: 7.8 });
      for (const deal of added) {
        try { await priceReference(deal, usdToHkd); } catch { /* deal stays unranked */ }
      }
      await recordDeals(added);
      await notifyDeals(added.length);
    }
    await updateBadge();
    return { ok: true, added: added.length };
  } finally {
    watchRunning = false;
    status.running = false;
    await chrome.storage.local.set({ cpcWatchStatus: status });
    updateKeepalive();
  }
}

async function processListings(watch, platform, listings, sets) {
  const seenKey = `cpcSeen|${watch.id}|${platform}`;
  const store = await chrome.storage.local.get(seenKey);
  const seen = store[seenKey] || {};
  const fresh = [];
  const maxAge = watch.maxAgeDays == null ? 7 : watch.maxAgeDays;
  for (const listing of listings) {
    if (!listing || !listing.id || !listing.title) continue;
    const localId = String(listing.id);
    if (seen[localId]) continue;
    seen[localId] = Date.now(); // evaluated once, never re-flagged
    const days = parsePostedDays(listing.postedText);
    if (maxAge > 0 && days != null && days > maxAge) continue;
    const meta = filterListing(watch, listing, sets);
    if (!meta) continue;
    fresh.push({
      id: `${platform}:${localId}`,
      watchId: watch.id,
      watchName: watch.name || watch.query,
      platform,
      title: listing.title,
      price: meta.price,
      currency: meta.currency,
      url: listing.url,
      image: listing.image || null,
      postedText: listing.postedText || null,
      grade: meta.grade,
      setCode: meta.setCode,
      setName: meta.setName,
      era: meta.era,
      foundAt: Date.now(),
      seen: false,
    });
  }
  // prune the oldest entries so the seen map doesn't grow forever
  const ids = Object.keys(seen);
  if (ids.length > SEEN_CAP) {
    ids.sort((a, b) => seen[a] - seen[b]);
    for (const id of ids.slice(0, ids.length - SEEN_CAP)) delete seen[id];
  }
  await chrome.storage.local.set({ [seenKey]: seen });
  return fresh;
}

// Attach the market reference to a deal: the cheaper of the Japan-located
// and worldwide eBay medians (both USD on ebay.com), converted to HK$ via
// the peg rate, plus the discount of the listing against it.
async function priceReference(deal, usdToHkd) {
  const [jp, eb] = await Promise.all([
    handleCheck({ source: 'jp', query: deal.title, domain: 'www.ebay.com' }),
    handleCheck({ source: 'eb', query: deal.title, domain: 'www.ebay.com' }),
  ]);
  const refs = [jp, eb].filter((r) => r && r.ok && r.count && r.median > 0 && r.currency === '$');
  if (!refs.length) return;
  const best = refs.reduce((a, b) => (a.median <= b.median ? a : b));
  deal.refUsd = best.median;
  deal.refHkd = best.median * usdToHkd;
  deal.refUrl = best.url;
  // Carousell shows HK$; FBM in Hong Kong renders plain "$" but means HK$.
  if (deal.price && (deal.currency === 'HK$' || deal.currency === '$') && deal.refHkd > 0) {
    deal.discountPct = Math.round((1 - deal.price / deal.refHkd) * 100);
  }
}

// Serialise every read-modify-write of cpcDeals so a scheduled run's
// recordDeals can't interleave with markDealsSeen and clobber fresh deals.
let dealsLock = Promise.resolve();

function withDealsLock(fn) {
  const p = dealsLock.then(fn);
  dealsLock = p.catch(() => {});
  return p;
}

function recordDeals(fresh) {
  return withDealsLock(async () => {
    const { cpcDeals = [] } = await chrome.storage.local.get('cpcDeals');
    const existing = new Set(cpcDeals.map((d) => d.id));
    const merged = [...fresh.filter((d) => !existing.has(d.id)), ...cpcDeals].slice(0, DEALS_CAP);
    await chrome.storage.local.set({ cpcDeals: merged });
  });
}

async function notifyDeals(count) {
  const settings = await getWatchSettings();
  if (!settings.notify) return;
  chrome.notifications.create('cpc-deals', {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Card Price Check',
    message: `${count} new matching listing${count === 1 ? '' : 's'} found`,
    priority: 1,
  });
}

async function markDealsSeen() {
  await withDealsLock(async () => {
    const { cpcDeals = [] } = await chrome.storage.local.get('cpcDeals');
    await chrome.storage.local.set({ cpcDeals: cpcDeals.map((d) => ({ ...d, seen: true })) });
  });
  await updateBadge();
}

async function updateBadge() {
  const { cpcDeals = [] } = await chrome.storage.local.get('cpcDeals');
  const unseen = cpcDeals.filter((d) => !d.seen).length;
  chrome.action.setBadgeText({ text: unseen ? String(unseen) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
}

// ------------------------------------------------------- query building ----

// Words that describe condition/grading/language/hype rather than the card
// itself. Removed for Cardmarket queries, where product names are terse and
// extra words cause zero matches. Variant words like "ex", "V", "VMAX" are
// deliberately NOT here — they are part of card names.
const CM_STOP_WORDS = new Set([
  'new', 'listing', 'nm', 'lp', 'mp', 'hp', 'dmg', 'damaged', 'mint', 'near',
  'excellent', 'good', 'played', 'poor', 'condition',
  'psa', 'bgs', 'cgc', 'ace', 'graded', 'grade', 'gem', 'slab', 'slabbed', 'pop',
  'pokemon', 'pokémon', 'tcg', 'ccg', 'card', 'cards', 'trading',
  'japanese', 'japan', 'jpn', 'jp', 'english', 'eng', 'german', 'french', 'italian',
  'holo', 'holofoil', 'foil', 'reverse', 'shiny', 'ultra', 'secret', 'hyper',
  'rare', 'rara', 'genuine', 'authentic', 'official', 'vintage', 'rge',
  '1st', 'first', 'edition', 'ed', 'shadowless', 'unlimited',
]);

function tokenize(title) {
  return String(title)
    .replace(/new listing/gi, ' ')
    .normalize('NFKC')
    // CJK titles glue scripts together ("リザードンPSA9日版"); split at
    // CJK↔latin/digit boundaries so PSA grades and set codes become tokens
    .replace(/([\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])(?=[a-z0-9])/giu, '$1 ')
    .replace(/([a-z0-9])(?=[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])/giu, '$1 ')
    // keep letters (incl. Japanese), digits, and /-.&' which appear in card
    // numbers ("123/165") and names; everything else (emoji, ★, …) → space
    .replace(/[^\p{L}\p{N}/\-.&' ]+/gu, ' ')
    .split(/\s+/)
    // drop stray single ASCII letters ("L@@K" → "L", "K"); keep V/X, which
    // are card-name suffixes, and single CJK characters
    .filter((t) => t && (t.length > 1 || !/^[a-z]$/i.test(t) || /^[vx]$/i.test(t)));
}

// Hong Kong marketplace vocabulary that Japan-located eBay sellers never put
// in their titles — searching with it just produces zero matches.
const EB_STOP_WORDS = new Set([
  '寶可夢', '宝可梦', '寵物小精靈', '日版', '日本版', '港版', '中文版', '行貨',
  '卡', '咭', '卡牌', '咭牌', 'hk', 'hkd',
]);

function buildEbayQuery(title) {
  // eBay handles long queries well; keep the title nearly intact so graded
  // cards compare against graded cards, Japanese against Japanese, etc.
  return tokenize(title)
    .filter((t) => !EB_STOP_WORDS.has(t.toLowerCase()))
    .slice(0, 12)
    .join(' ');
}

const GRADE_WORDS = new Set(['psa', 'bgs', 'cgc', 'ace', 'grade', 'graded', 'gem']);

function buildCmQuery(title) {
  const tokens = tokenize(title);
  const kept = [];
  for (let i = 0; i < tokens.length; i++) {
    const low = tokens[i].toLowerCase();
    // treat compounds like "NM/Mint" as stopwords when every part is one
    const parts = low.split('/').filter(Boolean);
    if (parts.length && parts.every((p) => CM_STOP_WORDS.has(p))) {
      // also swallow the grade number in "PSA 10", "CGC 9.5" etc.
      if (GRADE_WORDS.has(low) && i + 1 < tokens.length && /^\d{1,2}(\.5)?$/.test(tokens[i + 1])) i += 1;
      continue;
    }
    kept.push(tokens[i]);
  }
  return kept.slice(0, 6).join(' ');
}

// ----------------------------------------------------------------- misc ----

function computeStats(values) {
  const sorted = values.filter((v) => isFinite(v) && v > 0).sort((a, b) => a - b);
  const sample = sorted.slice(0, SAMPLE_SIZE);
  const median = sample.length
    ? (sample.length % 2
      ? sample[(sample.length - 1) / 2]
      : (sample[sample.length / 2 - 1] + sample[sample.length / 2]) / 2)
    : null;
  return { count: sorted.length, min: sorted[0] ?? null, median };
}

function cacheKey(msg) {
  const q = String(msg.query).toLowerCase().replace(/\s+/g, ' ').trim();
  const scope = msg.source === 'cm' ? msg.game : msg.domain;
  return `cpc|${msg.source}|${scope || ''}|${q}`;
}

async function cacheGet(key) {
  const obj = await chrome.storage.local.get(key);
  const entry = obj[key];
  if (entry && Date.now() - entry.t < CACHE_TTL_MS) return entry.data;
  return null;
}

async function cacheSet(key, data) {
  try {
    await chrome.storage.local.set({ [key]: { t: Date.now(), data } });
  } catch { /* storage full — lookups still work, just uncached */ }
}

// Only remove price-cache entries ('cpc|…'); watches, deals and seen-listing
// memory also live in storage.local and must survive a cache clear.
async function clearPriceCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('cpc|'));
  if (keys.length) await chrome.storage.local.remove(keys);
}

// Expired cache entries are dead weight (cacheGet ignores them); sweep them
// on startup so storage.local doesn't creep toward its quota over months.
async function sweepExpiredCache() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale = Object.keys(all).filter((k) =>
      k.startsWith('cpc|') && !(all[k] && now - all[k].t < CACHE_TTL_MS));
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch { /* sweep is best-effort */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// MV3 service workers idle out after ~30s; while queues are busy, poke a
// trivial API every 25s so long queues (many listings) finish reliably.
let keepalive = null;

function updateKeepalive() {
  // An open worker tab counts as busy: the service worker must outlive the
  // idle-close timer, or the hidden tab would leak when the SW dies first.
  const busy = Object.values(queues).some((q) => q.length)
    || Object.values(pumping).some(Boolean)
    || !!workerActive
    || workerTabId !== null
    || watchRunning;
  if (busy && !keepalive) {
    keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25 * 1000);
  } else if (!busy && keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}
