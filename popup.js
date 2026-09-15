const listEl = document.getElementById('watch-list');
const form = document.getElementById('add-form');
const alertBar = document.getElementById('alert-bar');
const alertText = alertBar.querySelector('.alert-text');
const stopBtn = document.getElementById('stop-alert');

async function load() {
  const { watches = [] } = await chrome.storage.local.get('watches');
  listEl.innerHTML = '';
  if (watches.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.border = 'none';
    li.textContent = 'No watches yet. Add one above.';
    listEl.appendChild(li);
    return;
  }
  for (const w of watches) {
    const li = document.createElement('li');
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.dataset.id = w.id;

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = w.label;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${w.urlPattern}  ·  ${w.selector}`;

    const value = document.createElement('div');
    value.className = 'value';
    value.textContent = w.lastValue != null ? `Last: ${w.lastValue}` : 'No value seen yet';

    li.append(remove, label, meta, value);
    listEl.appendChild(li);
  }
}

async function refreshAlertBar() {
  const { alertActive, lastAlert } = await chrome.storage.local.get(['alertActive', 'lastAlert']);
  if (alertActive) {
    alertBar.hidden = false;
    alertText.textContent = lastAlert
      ? `${lastAlert.watch.label}: ${lastAlert.oldVal} → ${lastAlert.newVal}`
      : 'Alert active';
  } else {
    alertBar.hidden = true;
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('label').value.trim();
  const urlPattern = document.getElementById('urlPattern').value.trim();
  const selector = document.getElementById('selector').value.trim();
  if (!label || !urlPattern || !selector) return;

  const { watches = [] } = await chrome.storage.local.get('watches');
  watches.push({
    id: crypto.randomUUID(),
    label, urlPattern, selector,
    lastValue: null
  });
  await chrome.storage.local.set({ watches });
  form.reset();
  load();
});

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  const id = btn.dataset.id;
  const { watches = [] } = await chrome.storage.local.get('watches');
  await chrome.storage.local.set({ watches: watches.filter(w => w.id !== id) });
  load();
});

stopBtn.addEventListener('click', () => {
  chrome.storage.local.set({ alertActive: false });
});

document.getElementById('test-alert').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'testAlert' });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.alertActive || changes.lastAlert) refreshAlertBar();
  if (changes.watches) load();
});

chrome.runtime.sendMessage({ type: 'clearBadge' });
load();
refreshAlertBar();
