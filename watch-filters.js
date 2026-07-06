// Pure watch-filtering logic, shared by background.js (via importScripts) and
// the node test scripts. No chrome.* APIs and no DOM in here; parseMoney comes
// from money.js, which is always loaded alongside this file.

const CPC_GRADE_RE = /psa[\s\-]*(10|[1-9])(?!\d)/i;

/** PSA grade from a listing title, or null when the card looks ungraded. */
function extractGrade(title) {
  const m = String(title).match(CPC_GRADE_RE);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Heuristic: does the title look like a Japanese-version card? Explicit
 * markers or kana (hiragana/katakana, which Chinese titles don't use) pass;
 * an explicit Chinese-version marker fails even alongside CJK text, since
 * Carousell HK titles are often written in Chinese about non-Japanese cards.
 */
function titleLooksJapanese(title) {
  const t = String(title);
  if (/中文版|chinese version/i.test(t)) return false;
  return /japan(ese)?\b|\bjpn\b|\bjap\b|日本|日版|日文/i.test(t) || /[぀-ヿ]/.test(t);
}

/**
 * Match a listing title against the bundled set list. Set codes ("sv4a",
 * "s8b") are the strongest signal and are matched with alphanumeric
 * boundaries so "s4a" does not fire inside "sv4a"; Japanese and English set
 * names are fallbacks. Prefers the longest matching code. Returns the set
 * entry or null. Compiled regexes are cached on the entries.
 */
function matchSet(title, sets) {
  const t = String(title);
  const low = t.toLowerCase();
  let best = null;
  for (const s of sets) {
    if (s.code) {
      if (!s._re) {
        const esc = s.code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        s._re = new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, 'i');
      }
      if (s._re.test(low)) {
        if (!best || String(s.code).length > String(best.code).length) best = s;
        continue;
      }
    }
    if (s.jaName && t.includes(s.jaName)) { best = best || s; continue; }
    if (s.name && s.name.length >= 4 && low.includes(s.name.toLowerCase())) best = best || s;
  }
  return best;
}

/** Rough listing age in days parsed from relative-time text (EN + zh-HK). */
function parsePostedDays(text) {
  if (!text) return null;
  const t = String(text);
  const en = t.match(/(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month)/i);
  if (en) {
    const n = parseInt(en[1], 10);
    const u = en[2].toLowerCase();
    if (u.startsWith('sec') || u.startsWith('min')) return 0;
    if (u.startsWith('h')) return n / 24;
    if (u.startsWith('d')) return n;
    if (u.startsWith('w')) return n * 7;
    return n * 30;
  }
  const zh = t.match(/(\d+)\s*(秒|分鐘|分钟|小時|小时|日|天|星期|週|周|個月|个月)/);
  if (zh) {
    const n = parseInt(zh[1], 10);
    const u = zh[2];
    if (u === '秒' || u.startsWith('分')) return 0;
    if (u.startsWith('小')) return n / 24;
    if (u === '日' || u === '天') return n;
    if (u === '星期' || u === '週' || u === '周') return n * 7;
    return n * 30;
  }
  return null;
}

/**
 * Apply a watch's criteria to a scraped listing. Returns the extracted
 * metadata { grade, setCode, setName, price, currency } when the listing
 * matches, or null when it should be dropped.
 */
function filterListing(watch, listing, sets) {
  const title = listing.title || '';
  if (!title) return null;

  const grade = extractGrade(title);
  const grades = watch.grades || [];
  if (grades.length && (grade === null || !grades.includes(grade))) return null;

  if (watch.japaneseOnly && !titleLooksJapanese(title)) return null;

  const money = listing.priceText ? parseMoney(listing.priceText) : null;
  if (watch.maxPrice && money && money.value > watch.maxPrice) return null;

  const wantsSet = (watch.setCodes && watch.setCodes.length) || watch.releasedFrom || watch.releasedTo;
  const matched = matchSet(title, sets);
  if (wantsSet) {
    if (!matched) return null;
    if (watch.setCodes && watch.setCodes.length && !watch.setCodes.includes(matched.code)) return null;
    // 'YYYY-MM-DD' strings compare correctly as strings
    if (watch.releasedFrom && (!matched.release || matched.release < watch.releasedFrom)) return null;
    if (watch.releasedTo && (!matched.release || matched.release > watch.releasedTo)) return null;
  }

  return {
    grade,
    setCode: matched ? matched.code : null,
    setName: matched ? matched.name : null,
    price: money ? money.value : null,
    currency: money ? money.symbol : null,
  };
}

/** Search text sent to a platform for a watch. */
function buildWatchQuery(watch) {
  let q = (watch.query || '').trim();
  if ((watch.grades || []).length && !/\bpsa\b/i.test(q)) q = `${q} psa`.trim();
  return q || 'psa pokemon';
}

/** Platform search URL, newest-first where the platform supports it. */
function watchSearchUrl(platform, query) {
  if (platform === 'carousell') {
    return `https://www.carousell.com.hk/search/${encodeURIComponent(query)}`
      + '?addRecent=false&canChangeKeyword=false&includeSuggestions=false&sort_by=3';
  }
  return `https://www.facebook.com/marketplace/search/?query=${encodeURIComponent(query)}`
    + '&daysSinceListed=7&sortBy=creation_time_descend&exact=false';
}
