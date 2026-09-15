const OFFSCREEN_URL = 'offscreen.html';
const NOTIFICATION_ID = 'value-watch-alert';

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play alert sound when a watched value changes.'
  });
  console.log('[Value Watch] offscreen document created');
}

async function tellOffscreen(type) {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: 'offscreen', type });
    console.log('[Value Watch] sent to offscreen:', type);
  } catch (e) {
    console.warn('[Value Watch] tellOffscreen failed:', type, e);
  }
}

async function bumpBadge() {
  const { badgeCount = 0 } = await chrome.storage.local.get('badgeCount');
  const next = badgeCount + 1;
  await chrome.storage.local.set({ badgeCount: next });
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: '#d00000' });
}

async function startAlert(watch, oldVal, newVal) {
  const { alertActive } = await chrome.storage.local.get('alertActive');
  await chrome.storage.local.set({
    alertActive: true,
    lastAlert: { watch, oldVal, newVal, at: Date.now() }
  });
  bumpBadge();
  if (alertActive) return;
  tellOffscreen('startSiren');
  try {
    chrome.notifications.create(NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: `Value changed: ${watch.label}`,
      message: `${oldVal} → ${newVal}. Click to stop the alert.`,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.warn('[Value Watch] notification failed:', e);
  }
}

async function stopEverything() {
  await chrome.storage.local.set({ alertActive: false, badgeCount: 0 });
  chrome.action.setBadgeText({ text: '' });
  chrome.notifications.clear(NOTIFICATION_ID);
  tellOffscreen('stopSiren');
}

async function updateLastValue(id, value) {
  const { watches = [] } = await chrome.storage.local.get('watches');
  const next = watches.map(w => w.id === id ? { ...w, lastValue: value } : w);
  await chrome.storage.local.set({ watches: next });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.alertActive) {
    const val = changes.alertActive.newValue;
    if (val === false) {
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.local.set({ badgeCount: 0 });
      chrome.notifications.clear(NOTIFICATION_ID);
      tellOffscreen('stopSiren');
    } else if (val === true) {
      tellOffscreen('startSiren');
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'valueChanged') {
    const w = msg.watch;
    if (!w || typeof w.label !== 'string' || typeof w.id !== 'string') return;
    startAlert(w, String(msg.oldValue), String(msg.newValue));
  } else if (msg.type === 'updateLastValue') {
    if (typeof msg.id !== 'string') return;
    updateLastValue(msg.id, msg.value);
  } else if (msg.type === 'clearBadge') {
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.set({ badgeCount: 0 });
  } else if (msg.type === 'testAlert') {
    startAlert(
      { id: 'test', label: 'Test alert', selector: 'n/a', urlPattern: 'n/a' },
      'OLD', 'NEW'
    );
  } else if (msg.type === 'offscreenReady') {
    chrome.storage.local.get('alertActive').then(({ alertActive }) => {
      if (alertActive) tellOffscreen('startSiren');
    });
  }
});

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIFICATION_ID) chrome.storage.local.set({ alertActive: false });
});
chrome.notifications.onClosed.addListener((id, byUser) => {
  if (id === NOTIFICATION_ID && byUser) chrome.storage.local.set({ alertActive: false });
});
