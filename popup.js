// Settings popup: reads/writes chrome.storage.sync. Content scripts pick the
// values up on the next page load.

const DEFAULTS = {
  enabled: true,
  threshold: 20,
  maxListings: 50,
  srcJp: true,
  srcCm: true,
  srcEb: false,
  game: 'Pokemon',
  eurRate: 0.85,
  usdToHkd: 7.8,
};

const CHECKBOXES = ['enabled', 'srcJp', 'srcCm', 'srcEb'];
const NUMBERS = ['threshold', 'maxListings', 'eurRate', 'usdToHkd'];

const status = document.getElementById('status');
let statusTimer = null;

function flash(text) {
  status.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { status.textContent = ''; }, 1500);
}

async function load() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  for (const id of CHECKBOXES) document.getElementById(id).checked = s[id];
  for (const id of NUMBERS) document.getElementById(id).value = s[id];
  document.getElementById('game').value = s.game;
}

async function save() {
  const s = {};
  for (const id of CHECKBOXES) s[id] = document.getElementById(id).checked;
  for (const id of NUMBERS) {
    const v = parseFloat(document.getElementById(id).value);
    s[id] = isFinite(v) ? v : DEFAULTS[id];
  }
  s.game = document.getElementById('game').value;
  await chrome.storage.sync.set(s);
  flash('Saved');
}

for (const id of [...CHECKBOXES, ...NUMBERS, 'game']) {
  document.getElementById(id).addEventListener('change', save);
}

document.getElementById('openWatches').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// Reloads the unpacked extension from disk — the one-click alternative to
// the ↻ button on chrome://extensions after a `git pull`.
document.getElementById('reloadExt').addEventListener('click', () => {
  chrome.runtime.reload();
});

document.getElementById('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'cpc-clear-cache' });
  flash('Cache cleared');
});

load();
