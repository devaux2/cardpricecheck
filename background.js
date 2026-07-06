// Card Price Check — background service worker.
//
// The price-lookup engine. Everything runs locally in the browser:
//  - "jp" / "eb": eBay searches fetched directly by the service worker and
//    parsed in an offscreen document (service workers have no DOMParser).
//  - "cm": Cardmarket lookups run through a single hidden "side instance"
//    tab, because Cardmarket sits behind Cloudflare and needs a real
//    browser context. The tab is reused for the whole queue and closed
//    after it has been idle for a while.
// Each source has its own sequential queue with a polite delay between
// requests, and every result is cached for a few hours.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SOURCE_GAP_MS = { jp: 1500, eb: 1500, cm: 4000 };
const CM_JOB_TIMEOUT_MS = 30 * 1000;
const CM_TAB_IDLE_CLOSE_MS = 45 * 1000;
const SAMPLE_SIZE = 12; // stats use the cheapest N matches

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
  if (msg.type === 'cpc-cm-result') {
    onCmResult(sender, msg);
    return;
  }
  if (msg.type === 'cpc-clear-cache') {
    chrome.storage.local.clear().then(() => sendResponse({ ok: true }));
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
  if (source === 'cm') scheduleCmClose();
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

// ---------------------------------------------------------- Cardmarket ----

let cmTabId = null;
let cmIdleTimer = null;
let cmActive = null; // { resolve, timer, jobId }
let cmJobSeq = 0;

function runCmJob(msg) {
  const game = CM_GAMES.has(msg.game) ? msg.game : 'Pokemon';
  const query = buildCmQuery(msg.query);
  if (!query) return Promise.resolve({ ok: false, error: 'could not build a Cardmarket query from the title' });
  const jobId = String(++cmJobSeq);
  const cleanUrl = `https://www.cardmarket.com/en/${game}/Products/Search?searchString=${encodeURIComponent(query)}`;
  // cpcw busts same-URL navigations so the page always reloads; the hash
  // survives Cardmarket's redirect-to-product and correlates the result.
  const url = `${cleanUrl}&cpcw=${jobId}#cpc-worker:${jobId}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      finishCm({
        ok: false, url: cleanUrl,
        error: 'Cardmarket lookup timed out (slow load or bot check — open cardmarket.com once in a normal tab, then retry)',
      });
    }, CM_JOB_TIMEOUT_MS);
    cmActive = { resolve, timer, jobId };
    openCmTab(url).catch((e) => finishCm({ ok: false, error: String(e) }));
  });
}

function finishCm(result) {
  if (!cmActive) return;
  clearTimeout(cmActive.timer);
  const { resolve } = cmActive;
  cmActive = null;
  resolve(result);
}

async function openCmTab(url) {
  clearTimeout(cmIdleTimer);
  if (cmTabId !== null) {
    try {
      await chrome.tabs.update(cmTabId, { url });
      return;
    } catch {
      cmTabId = null; // tab was closed, fall through and recreate
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  cmTabId = tab.id;
}

function onCmResult(sender, msg) {
  if (!cmActive || !sender.tab || sender.tab.id !== cmTabId) return;
  if (msg.jobId !== cmActive.jobId) return; // stale result from a previous, timed-out job
  if (msg.blocked) {
    finishCm({
      ok: false, url: msg.url,
      error: 'Cardmarket showed a bot check — open cardmarket.com in a normal tab, pass it, then retry',
    });
    return;
  }
  finishCm({
    ok: true,
    url: msg.url,
    currency: msg.currency || '€',
    kind: msg.kind,
    ...computeStats(msg.values || []),
  });
}

function scheduleCmClose() {
  clearTimeout(cmIdleTimer);
  cmIdleTimer = setTimeout(async () => {
    if (queues.cm.length || cmActive || cmTabId === null) return;
    try { await chrome.tabs.remove(cmTabId); } catch { /* already gone */ }
    cmTabId = null;
  }, CM_TAB_IDLE_CLOSE_MS);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== cmTabId) return;
  cmTabId = null;
  finishCm({ ok: false, error: 'worker tab was closed' });
});

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
    // keep letters (incl. Japanese), digits, and /-.&' which appear in card
    // numbers ("123/165") and names; everything else (emoji, ★, …) → space
    .replace(/[^\p{L}\p{N}/\-.&' ]+/gu, ' ')
    .split(/\s+/)
    // drop stray single ASCII letters ("L@@K" → "L", "K"); keep V/X, which
    // are card-name suffixes, and single CJK characters
    .filter((t) => t && (t.length > 1 || !/^[a-z]$/i.test(t) || /^[vx]$/i.test(t)));
}

function buildEbayQuery(title) {
  // eBay handles long queries well; keep the title nearly intact so graded
  // cards compare against graded cards, Japanese against Japanese, etc.
  return tokenize(title).slice(0, 12).join(' ');
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// MV3 service workers idle out after ~30s; while queues are busy, poke a
// trivial API every 25s so long queues (many listings) finish reliably.
let keepalive = null;

function updateKeepalive() {
  const busy = Object.values(queues).some((q) => q.length)
    || Object.values(pumping).some(Boolean)
    || !!cmActive;
  if (busy && !keepalive) {
    keepalive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 25 * 1000);
  } else if (!busy && keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
}
