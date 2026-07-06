// Shared price-parsing helpers. Loaded before content.js / cm-scraper.js and
// by offscreen.html, so everything extracts and normalises prices the same way.

/** Normalise a matched currency marker to a single canonical symbol. */
function normSymbol(raw) {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s === 'US$' || s === '$') return '$';
  if (s === 'HK$' || s === 'HKD') return 'HK$';
  if (s === 'C$') return 'C$';
  if (s === 'AU$') return 'AU$';
  if (s === 'NZ$') return 'NZ$';
  if (s === 'S$' || s === 'SGD') return 'S$';
  if (s === 'NT$' || s === 'TWD') return 'NT$';
  if (s === 'EUR' || s === '€') return '€';
  if (s === 'JPY' || s === '¥') return '¥';
  if (s === 'GBP' || s === '£') return '£';
  return raw.trim();
}

/**
 * Parse an amount string that may use either "1,234.56" or "1.234,56"
 * conventions. Whichever separator appears last is treated as the decimal
 * point; a lone comma followed by 1-2 digits is treated as a decimal comma.
 */
function parseAmount(str) {
  let s = String(str).replace(/\s/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    const decimals = s.length - lastComma - 1;
    if (decimals >= 1 && decimals <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  return parseFloat(s);
}

/**
 * Extract the first money value from a text like "£12.34", "US $5.00 to
 * US $9.00", "EUR 12,34" or "12,34 €". Returns { symbol, value } or null.
 * For ranges, the lower bound is used.
 */
function parseMoney(text) {
  if (!text) return null;
  const t = String(text).replace(/ /g, ' ');
  let symbol = null;
  let amount = null;
  // The lookbehind keeps letter-prefixed symbols from firing mid-word
  // ("CARDS $12" must be $, not S$; "PSA'S $50" must be $).
  const prefix = t.match(/(?<![a-z'])(US\s?\$|HK\s?\$|AU\s?\$|C\s?\$|NZ\s?\$|NT\s?\$|S\s?\$|EUR|JPY|HKD|£|\$|€|¥)\s*(\d[\d.,\s]*)/i);
  if (prefix) {
    symbol = normSymbol(prefix[1]);
    amount = prefix[2];
  } else {
    const suffix = t.match(/(\d[\d.,]*)\s*(EUR|JPY|HKD|£|\$|€|¥)/i);
    if (!suffix) return null;
    symbol = normSymbol(suffix[2]);
    amount = suffix[1];
  }
  const value = parseAmount(amount.trim().replace(/[.,]$/, ''));
  if (!isFinite(value) || value <= 0) return null;
  return { symbol, value };
}

/** First non-empty textContent among the given selectors, searched in order. */
function textOf(root, selectors) {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) {
      const t = el.textContent.trim();
      if (t) return t;
    }
  }
  return '';
}
