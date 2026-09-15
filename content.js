let activeWatches = [];
let observer = null;
let debounceTimer = null;

function urlMatches(pattern, url) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(url);
}

function readValue(selector) {
  try {
    const el = document.querySelector(selector);
    return el ? el.textContent.trim() : null;
  } catch {
    return null;
  }
}

function ensurePulseStyle() {
  if (document.getElementById('__value_watch_style__')) return;
  const s = document.createElement('style');
  s.id = '__value_watch_style__';
  s.textContent = `@keyframes __value_watch_pulse {
    0%, 100% { background: #d00000; }
    50% { background: #ff5252; }
  }`;
  (document.head || document.documentElement).appendChild(s);
}

function removeBanner() {
  document.getElementById('__value_watch_banner__')?.remove();
}

function showBanner(watch, oldVal, newVal) {
  removeBanner();
  ensurePulseStyle();
  const banner = document.createElement('div');
  banner.id = '__value_watch_banner__';
  banner.textContent = `Value Watch — "${watch.label}" changed: ${oldVal} → ${newVal}   ·   click to stop alert`;
  Object.assign(banner.style, {
    position: 'fixed', top: '0', left: '0', right: '0',
    background: '#d00000', color: '#fff',
    padding: '12px 16px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '14px', fontWeight: '700',
    textAlign: 'center',
    zIndex: '2147483647',
    boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
    cursor: 'pointer',
    animation: '__value_watch_pulse 1s ease-in-out infinite'
  });
  banner.addEventListener('click', () => {
    removeBanner();
    chrome.storage.local.set({ alertActive: false });
  });
  (document.body || document.documentElement).appendChild(banner);
}

function checkWatches() {
  const url = location.href;
  for (const w of activeWatches) {
    if (!urlMatches(w.urlPattern, url)) continue;
    const current = readValue(w.selector);
    if (current === null) continue;

    const previous = w.lastValue;
    if (previous != null && current !== previous) {
      showBanner(w, previous, current);
      chrome.runtime.sendMessage({
        type: 'valueChanged',
        watch: { id: w.id, label: w.label, selector: w.selector, urlPattern: w.urlPattern },
        oldValue: previous,
        newValue: current
      });
    }
    if (current !== previous) {
      w.lastValue = current;
      chrome.runtime.sendMessage({ type: 'updateLastValue', id: w.id, value: current });
    }
  }
}

function scheduleCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkWatches, 300);
}

function startObserving() {
  observer?.disconnect();
  observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body || document.documentElement, {
    childList: true, subtree: true, characterData: true
  });
}

function applies() {
  return activeWatches.some(w => urlMatches(w.urlPattern, location.href));
}

async function init() {
  const { watches = [] } = await chrome.storage.local.get('watches');
  activeWatches = watches;
  if (applies()) {
    startObserving();
    setTimeout(checkWatches, 500);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.watches) {
    activeWatches = changes.watches.newValue || [];
    if (applies()) {
      startObserving();
      scheduleCheck();
    } else {
      observer?.disconnect();
      observer = null;
    }
  }
  if (changes.alertActive && changes.alertActive.newValue === false) {
    removeBanner();
  }
});

init();
