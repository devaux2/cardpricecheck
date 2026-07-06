// Card Price Check — "Watches & deals" page (the extension's options page).
//
// Two tabs: "Deals" lists everything the background watch runs have flagged
// (chrome.storage.local 'cpcDeals', newest first) and "Watches" manages the
// saved searches ('cpcWatches') plus the check-frequency / notification
// settings ('cpcWatchSettings' in storage.sync). A manual run is triggered
// with a 'cpc-run-watches' message and can take minutes; progress and
// per-platform errors come from 'cpcWatchStatus'. All DOM is built with
// createElement / textContent — never innerHTML — because titles, names and
// error strings are scraped or user-entered text.

// sets.js (global CPC_JP_SETS, sorted by release date) may be absent; the set
// filter then degrades to "any set" with a note in the picker.
const SETS = typeof CPC_JP_SETS !== 'undefined' ? CPC_JP_SETS : [];

const DEFAULT_WATCH_SETTINGS = { periodMinutes: 360, notify: true };
const DEFAULT_GRADES = [7, 8, 9];
const PLATFORM_LABELS = { carousell: 'Carousell', fbm: 'FB Marketplace' };
const ERA_LABELS = { vintage: 'Vintage', classic: 'Classic', modern: 'Modern' };
const EMPTY_STATUS = { lastRun: null, running: false, platforms: {} };

const $ = (id) => document.getElementById(id);

let watches = [];
let deals = [];
let watchStatus = EMPTY_STATUS;
let editingId = null;         // id of the watch being edited, null when adding
let runPending = false;       // a 'cpc-run-watches' reply is still outstanding
let selectedSets = new Set(); // set codes picked in the form
const codeToBox = new Map();  // set code -> its checkbox in the picker list
const gradeBoxes = [];        // the 1..10 grade checkboxes, in order

// ------------------------------------------------------------- helpers ----

/** createElement + className + textContent in one call. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" for a ms timestamp. */
function relTime(ms) {
  if (!ms) return '';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fmtPrice(price, currency) {
  const v = Number.isInteger(price) ? price.toLocaleString('en-US') : price.toFixed(2);
  return `${currency || ''}${v}`;
}

// Deal urls/images come from scraped pages; only link/load http(s) ones.
const isHttp = (u) => /^https?:\/\//i.test(u || '');

// ---------------------------------------------------------------- tabs ----

function showTab(name) {
  $('tabDeals').classList.toggle('active', name === 'deals');
  $('tabWatches').classList.toggle('active', name === 'watches');
  $('pageDeals').classList.toggle('hidden', name !== 'deals');
  $('pageWatches').classList.toggle('hidden', name !== 'watches');
}

// ----------------------------------------------------- deals: run & status ----

function isRunning() {
  return runPending || !!(watchStatus && watchStatus.running);
}

function setRunningUI(running) {
  const btn = $('runNow');
  btn.disabled = running;
  btn.textContent = running ? 'Checking…' : 'Run checks now';
  if (running) btn.appendChild(el('span', 'spinner'));
}

function setRunResult(text, cls) {
  const node = $('runResult');
  node.textContent = text;
  node.className = cls;
}

async function runChecks() {
  if (isRunning()) return;
  runPending = true;
  setRunningUI(true);
  setRunResult('', '');
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: 'cpc-run-watches' });
  } catch (e) {
    res = { ok: false, added: 0, error: String(e) };
  }
  runPending = false;
  await refresh();
  if (res && res.ok) {
    setRunResult(res.added ? `Found ${res.added} new deal${res.added === 1 ? '' : 's'}` : 'No new deals', 'ok');
  } else {
    setRunResult((res && res.error) || 'The check failed', 'err');
  }
}

function renderStatus() {
  const errors = $('statusErrors');
  errors.replaceChildren();
  let text;
  if (isRunning()) text = 'Checking now — this can take a few minutes…';
  else if (watchStatus.lastRun) text = `Last check: ${relTime(watchStatus.lastRun)}`;
  else text = 'No checks have run yet.';

  const okParts = [];
  for (const platform of ['carousell', 'fbm']) {
    const stamp = (watchStatus.platforms || {})[platform];
    if (!stamp) continue;
    const label = platform === 'fbm' ? 'Facebook Marketplace' : 'Carousell';
    if (stamp.error) {
      const box = el('div', 'status-error');
      box.appendChild(el('strong', null, `${label}: `));
      box.append(stamp.error);
      // The usual Facebook failure is not being logged in — spell out the
      // fix even when the background error didn't.
      if (platform === 'fbm' && !/facebook\.com/i.test(stamp.error)) {
        box.append(' If this keeps happening, log in to facebook.com in a normal tab, then run the checks again.');
      }
      errors.appendChild(box);
    } else if (stamp.ok) {
      okParts.push(`${label} ✓ ${relTime(stamp.at)}`);
    }
  }
  $('statusLine').textContent = okParts.length ? `${text} · ${okParts.join(' · ')}` : text;
  setRunningUI(isRunning());
}

// -------------------------------------------------------- deals: listing ----

function renderWatchFilter() {
  const select = $('filterWatch');
  const prev = select.value;
  select.replaceChildren();
  const all = el('option', null, 'All watches');
  all.value = '';
  select.appendChild(all);
  // Every watch that exists or that a stored deal still points at (a deleted
  // watch's deals stay filterable under its recorded name).
  const names = new Map();
  for (const w of watches) names.set(w.id, w.name || w.query);
  for (const d of deals) if (!names.has(d.watchId)) names.set(d.watchId, d.watchName || d.watchId);
  for (const [id, name] of names) {
    const opt = el('option', null, name);
    opt.value = id;
    select.appendChild(opt);
  }
  if (names.has(prev)) select.value = prev;
}

function dealRow(d) {
  const row = el('div', d.seen ? 'deal' : 'deal deal-unseen');
  const dot = el('span', 'deal-dot');
  if (!d.seen) dot.title = 'New since your last visit';
  row.appendChild(dot);

  if (d.image && isHttp(d.image)) {
    const img = document.createElement('img');
    img.className = 'deal-thumb';
    img.src = d.image;
    img.alt = '';
    img.loading = 'lazy';
    row.appendChild(img);
  } else {
    row.appendChild(el('div', 'deal-thumb deal-thumb-empty'));
  }

  const body = el('div', 'deal-body');
  const title = el('div', 'deal-title');
  const link = el('a', null, d.title || '(no title)');
  if (isHttp(d.url)) link.href = d.url;
  link.target = '_blank';
  link.rel = 'noopener';
  title.appendChild(link);

  const meta = el('div', 'deal-meta');
  if (d.price != null) meta.appendChild(el('span', 'deal-price', fmtPrice(d.price, d.currency)));
  meta.appendChild(el('span', 'chip', PLATFORM_LABELS[d.platform] || d.platform));
  if (d.grade != null) meta.appendChild(el('span', 'chip chip-grade', `PSA ${d.grade}`));
  if (d.setCode) {
    const chip = el('span', 'chip chip-set', d.setCode);
    if (d.setName) chip.title = d.setName;
    meta.appendChild(chip);
  }
  if (d.era && ERA_LABELS[d.era]) meta.appendChild(el('span', 'chip', ERA_LABELS[d.era]));
  if (d.refUsd != null) {
    const market = el('a', 'deal-market',
      `market ~$${d.refUsd.toFixed(0)}${d.refHkd ? ` ≈HK$${d.refHkd.toFixed(0)}` : ''}`);
    if (isHttp(d.refUrl)) market.href = d.refUrl;
    market.target = '_blank';
    market.rel = 'noopener';
    market.title = 'Cheapest eBay reference (JP-located or worldwide) — click to verify';
    meta.appendChild(market);
  }
  if (d.discountPct != null) {
    const good = d.discountPct >= 15;
    const chip = el('span', good ? 'chip chip-discount' : 'chip',
      d.discountPct >= 0 ? `▼ ${d.discountPct}% vs market` : `▲ ${Math.abs(d.discountPct)}% over`);
    meta.appendChild(chip);
  }
  if (d.watchName) meta.appendChild(el('span', null, `watch: ${d.watchName}`));
  if (d.postedText) meta.appendChild(el('span', null, `listed ${d.postedText}`));
  meta.appendChild(el('span', null, `found ${relTime(d.foundAt)}`));

  body.append(title, meta);
  row.appendChild(body);
  return row;
}

function renderDeals() {
  const platform = $('filterPlatform').value;
  const watchId = $('filterWatch').value;
  const era = $('filterEra').value;
  const list = deals.filter((d) =>
    (!platform || d.platform === platform)
    && (!watchId || d.watchId === watchId)
    && (!era || d.era === era));
  if ($('sortDeals').value === 'newest') {
    list.sort((a, b) => b.foundAt - a.foundAt);
  } else {
    // best value first; unranked deals (no market reference) sink to the end
    const rank = (d) => (d.discountPct == null ? -Infinity : d.discountPct);
    list.sort((a, b) => rank(b) - rank(a) || b.foundAt - a.foundAt);
  }
  const box = $('dealList');
  box.replaceChildren();
  for (const d of list) box.appendChild(dealRow(d));
  const empty = $('dealsEmpty');
  empty.classList.toggle('hidden', list.length > 0);
  empty.textContent = deals.length
    ? 'No deals match the current filters.'
    : 'No deals yet — add a watch on the Watches tab and run the checks.';
}

// --------------------------------------------------------- watches: list ----

function gradeSummary(grades) {
  if (!grades || !grades.length) return 'any grade';
  const sorted = [...grades].sort((a, b) => a - b);
  const contiguous = sorted.length > 1
    && sorted.every((g, i) => i === 0 || g === sorted[i - 1] + 1);
  return contiguous
    ? `PSA ${sorted[0]}–${sorted[sorted.length - 1]}`
    : `PSA ${sorted.join('/')}`;
}

function watchChips(w) {
  const chips = el('div', 'watch-chips');
  const add = (text, cls) => chips.appendChild(el('span', cls ? `chip ${cls}` : 'chip', text));
  const platforms = [];
  if (w.platforms && w.platforms.carousell) platforms.push('Carousell HK');
  if (w.platforms && w.platforms.fbm) platforms.push('FB Marketplace');
  add(platforms.length ? platforms.join(' + ') : 'no platforms');
  add(gradeSummary(w.grades), w.grades && w.grades.length ? 'chip-grade' : null);
  if (w.japaneseOnly) add('JP only');
  if (w.eraMode && w.eraMode !== 'any') add(ERA_LABELS[w.eraMode] || w.eraMode);
  const codes = w.setCodes || [];
  if (codes.length) add(codes.length <= 3 ? codes.join(', ') : `${codes.length} sets`, 'chip-set');
  if (w.releasedFrom && w.releasedTo) add(`${w.releasedFrom} → ${w.releasedTo}`);
  else if (w.releasedFrom) add(`released ≥ ${w.releasedFrom}`);
  else if (w.releasedTo) add(`released ≤ ${w.releasedTo}`);
  if (w.maxPrice != null) add(`≤ HK$${w.maxPrice}`);
  const age = w.maxAgeDays != null ? w.maxAgeDays : 7;
  add(age === 0 ? 'any age' : `≤ ${age}d old`);
  return chips;
}

function watchRow(w) {
  const row = el('div', w.enabled ? 'watch' : 'watch watch-disabled');
  const head = el('div', 'watch-head');
  head.appendChild(el('strong', null, w.name || w.query));
  if (w.name) head.appendChild(el('span', 'watch-query', w.query));

  const controls = el('div', 'watch-controls');
  const toggle = el('label', 'watch-toggle');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!w.enabled;
  cb.addEventListener('change', async () => {
    w.enabled = cb.checked;
    row.classList.toggle('watch-disabled', !w.enabled);
    await chrome.storage.local.set({ cpcWatches: watches });
  });
  toggle.append(cb, ' enabled');
  const edit = el('button', null, 'Edit');
  edit.type = 'button';
  edit.addEventListener('click', () => startEdit(w));
  const del = el('button', 'danger', 'Delete');
  del.type = 'button';
  del.addEventListener('click', () => deleteWatch(w));
  controls.append(toggle, edit, del);
  head.appendChild(controls);

  row.append(head, watchChips(w));
  return row;
}

function renderWatches() {
  const box = $('watchList');
  box.replaceChildren();
  for (const w of watches) box.appendChild(watchRow(w));
  $('watchesEmpty').classList.toggle('hidden', watches.length > 0);
}

async function deleteWatch(w) {
  if (!confirm(`Delete the watch "${w.name || w.query}"?`)) return;
  watches = watches.filter((x) => x.id !== w.id);
  if (editingId === w.id) resetForm();
  await chrome.storage.local.set({ cpcWatches: watches });
  renderWatches();
  renderWatchFilter();
}

// --------------------------------------------------------- watches: form ----

function buildGradeRow() {
  const rowBox = $('gradeRow');
  for (let g = 1; g <= 10; g += 1) {
    const label = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(g);
    label.append(cb, ` ${g}`);
    rowBox.appendChild(label);
    gradeBoxes.push(cb);
  }
}

function onAnyGradeChange() {
  const any = $('wAnyGrade').checked;
  for (const cb of gradeBoxes) {
    cb.disabled = any;
    if (any) cb.checked = false;
  }
  // Re-enabling with nothing ticked would silently mean "any grade" again;
  // restore the sensible default instead.
  if (!any && !gradeBoxes.some((cb) => cb.checked)) {
    for (const cb of gradeBoxes) cb.checked = DEFAULT_GRADES.includes(parseInt(cb.value, 10));
  }
}

function buildSetList() {
  const list = $('setList');
  if (!SETS.length) {
    list.appendChild(el('p', 'hint', 'Set list unavailable — sets.js is missing or empty. Watches fall back to "any set".'));
    return;
  }
  // Group by era, keeping the file's release order within each group.
  const groups = new Map();
  for (const s of SETS) {
    const era = s.era || 'Other';
    if (!groups.has(era)) groups.set(era, []);
    groups.get(era).push(s);
  }
  for (const [era, sets] of groups) {
    const group = el('div', 'set-group');
    group.appendChild(el('div', 'set-era', era));
    for (const s of sets) {
      const label = el('label', 'set-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = s.code;
      cb.addEventListener('change', () => {
        if (cb.checked) selectedSets.add(s.code);
        else selectedSets.delete(s.code);
        renderSetChips();
      });
      const year = s.release ? ` (${s.release.slice(0, 4)})` : '';
      label.appendChild(cb);
      label.append(` ${s.code} — ${s.name}${year}`);
      label.dataset.search = `${s.code} ${s.name} ${s.jaName || ''}`.toLowerCase();
      codeToBox.set(s.code, cb);
      group.appendChild(label);
    }
    list.appendChild(group);
  }
}

function applySetSearch() {
  const q = $('setSearch').value.trim().toLowerCase();
  for (const group of $('setList').querySelectorAll('.set-group')) {
    let visible = 0;
    for (const row of group.querySelectorAll('.set-row')) {
      const hit = !q || row.dataset.search.includes(q);
      row.classList.toggle('hidden', !hit);
      if (hit) visible += 1;
    }
    group.classList.toggle('hidden', !visible);
  }
}

function syncSetCheckboxes() {
  for (const [code, cb] of codeToBox) cb.checked = selectedSets.has(code);
}

function renderSetChips() {
  const box = $('setChips');
  box.replaceChildren();
  // Codes saved before a set left the bundled list still get a chip.
  for (const code of [...selectedSets].sort()) {
    const chip = el('span', 'set-chip', code);
    const x = el('button', 'set-chip-x', '×');
    x.type = 'button';
    x.title = `Remove ${code}`;
    x.addEventListener('click', () => {
      selectedSets.delete(code);
      const cb = codeToBox.get(code);
      if (cb) cb.checked = false;
      renderSetChips();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  }
  box.classList.toggle('hidden', !selectedSets.size);
}

/** Populate the form from a watch, or with new-watch defaults when null. */
function fillForm(w) {
  $('wName').value = w ? (w.name || '') : '';
  $('wQuery').value = w ? w.query : '';
  $('wPlatCarousell').checked = w ? !!(w.platforms && w.platforms.carousell) : true;
  $('wPlatFbm').checked = w ? !!(w.platforms && w.platforms.fbm) : true;
  const grades = w ? (w.grades || []) : DEFAULT_GRADES;
  $('wAnyGrade').checked = grades.length === 0;
  for (const cb of gradeBoxes) {
    cb.checked = grades.includes(parseInt(cb.value, 10));
    cb.disabled = grades.length === 0;
  }
  $('wJapaneseOnly').checked = w ? !!w.japaneseOnly : true;
  const eraMode = (w && w.eraMode) || 'any';
  for (const radio of document.querySelectorAll('input[name="wEra"]')) {
    radio.checked = radio.value === eraMode;
  }
  selectedSets = new Set(w ? (w.setCodes || []) : []);
  syncSetCheckboxes();
  renderSetChips();
  $('setSearch').value = '';
  applySetSearch();
  $('wFrom').value = (w && w.releasedFrom) || '';
  $('wTo').value = (w && w.releasedTo) || '';
  $('wMaxPrice').value = w && w.maxPrice != null ? w.maxPrice : '';
  $('wMaxAge').value = w && w.maxAgeDays != null ? w.maxAgeDays : 7;
}

function startEdit(w) {
  editingId = w.id;
  $('formTitle').textContent = `Edit watch: ${w.name || w.query}`;
  fillForm(w);
  $('watchForm').scrollIntoView({ behavior: 'smooth' });
}

function resetForm() {
  editingId = null;
  $('formTitle').textContent = 'Add a watch';
  fillForm(null);
}

async function saveWatch(e) {
  e.preventDefault();
  const query = $('wQuery').value.trim();
  if (!query) return; // the input's `required` normally catches this
  if (!$('wPlatCarousell').checked && !$('wPlatFbm').checked) {
    alert('Pick at least one platform to search.');
    return;
  }
  const grades = $('wAnyGrade').checked
    ? []
    : gradeBoxes.filter((cb) => cb.checked)
      .map((cb) => parseInt(cb.value, 10))
      .sort((a, b) => a - b);
  const maxPrice = parseFloat($('wMaxPrice').value);
  const maxAge = parseInt($('wMaxAge').value, 10);
  const existing = watches.find((w) => w.id === editingId);
  const watch = {
    id: existing ? existing.id : `w${Date.now()}`,
    name: $('wName').value.trim(),
    query,
    platforms: { carousell: $('wPlatCarousell').checked, fbm: $('wPlatFbm').checked },
    grades,
    japaneseOnly: $('wJapaneseOnly').checked,
    eraMode: (document.querySelector('input[name="wEra"]:checked') || {}).value || 'any',
    setCodes: [...selectedSets],
    releasedFrom: $('wFrom').value || null,
    releasedTo: $('wTo').value || null,
    maxPrice: isFinite(maxPrice) && maxPrice > 0 ? maxPrice : null,
    maxAgeDays: isFinite(maxAge) && maxAge >= 0 ? maxAge : 7,
    enabled: existing ? existing.enabled : true,
  };
  watches = existing ? watches.map((w) => (w.id === watch.id ? watch : w)) : [...watches, watch];
  await chrome.storage.local.set({ cpcWatches: watches });
  resetForm();
  renderWatches();
  renderWatchFilter();
}

// ------------------------------------------------------------- settings ----

let settingsTimer = null;

function applySettings(stored) {
  const s = { ...DEFAULT_WATCH_SETTINGS, ...(stored || {}) };
  $('periodMinutes').value = String(s.periodMinutes);
  $('notify').checked = !!s.notify;
}

async function loadSettings() {
  const { cpcWatchSettings } = await chrome.storage.sync.get('cpcWatchSettings');
  applySettings(cpcWatchSettings);
}

async function saveSettings() {
  const periodMinutes = parseInt($('periodMinutes').value, 10);
  await chrome.storage.sync.set({
    cpcWatchSettings: {
      periodMinutes: isFinite(periodMinutes) ? periodMinutes : DEFAULT_WATCH_SETTINGS.periodMinutes,
      notify: $('notify').checked,
    },
  });
  $('settingsStatus').textContent = 'Saved';
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { $('settingsStatus').textContent = ''; }, 1500);
}

// --------------------------------------------------------------- wiring ----

async function refresh() {
  const data = await chrome.storage.local.get(['cpcWatches', 'cpcDeals', 'cpcWatchStatus']);
  watches = data.cpcWatches || [];
  deals = data.cpcDeals || [];
  watchStatus = data.cpcWatchStatus || EMPTY_STATUS;
  renderStatus();
  renderWatchFilter();
  renderDeals();
  renderWatches();
}

// Live-update when the background records deals/status (scheduled runs too)
// and when settings change in another window.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.cpcDeals) {
      deals = changes.cpcDeals.newValue || [];
      renderWatchFilter();
      renderDeals();
    }
    if (changes.cpcWatchStatus) {
      watchStatus = changes.cpcWatchStatus.newValue || EMPTY_STATUS;
      renderStatus();
    }
    if (changes.cpcWatches) {
      watches = changes.cpcWatches.newValue || [];
      renderWatches();
      renderWatchFilter();
    }
  } else if (area === 'sync' && changes.cpcWatchSettings) {
    applySettings(changes.cpcWatchSettings.newValue);
  }
});

window.addEventListener('focus', () => { refresh(); });

$('tabDeals').addEventListener('click', () => showTab('deals'));
$('tabWatches').addEventListener('click', () => showTab('watches'));

$('runNow').addEventListener('click', runChecks);

$('markSeen').addEventListener('click', async () => {
  try {
    await chrome.runtime.sendMessage({ type: 'cpc-mark-deals-seen' });
  } catch { /* service worker restarting; refresh shows the truth */ }
  refresh();
});

$('clearDeals').addEventListener('click', async () => {
  if (!confirm('Delete all recorded deals? This cannot be undone.')) return;
  await chrome.storage.local.set({ cpcDeals: [] });
  refresh();
});

$('filterPlatform').addEventListener('change', renderDeals);
$('filterWatch').addEventListener('change', renderDeals);
$('filterEra').addEventListener('change', renderDeals);
$('sortDeals').addEventListener('change', renderDeals);

$('watchForm').addEventListener('submit', saveWatch);
$('cancelEdit').addEventListener('click', resetForm);
$('wAnyGrade').addEventListener('change', onAnyGradeChange);
$('setSearch').addEventListener('input', applySetSearch);

$('periodMinutes').addEventListener('change', saveSettings);
$('notify').addEventListener('change', saveSettings);

// Reloads the unpacked extension from disk (same as ↻ on chrome://extensions)
// so a `git pull` takes effect without leaving this page. The page reloads
// itself afterwards to run the fresh code.
$('reloadExt').addEventListener('click', () => {
  chrome.runtime.reload();
  setTimeout(() => location.reload(), 500);
});

buildGradeRow();
buildSetList();
fillForm(null);
loadSettings();
refresh();
