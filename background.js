// ============================================================================
// background.js — Service Worker (the "brain" of the extension)
// ----------------------------------------------------------------------------
// In Manifest V3, there is no persistent background page. Instead Chrome runs
// this file as a *service worker*: it wakes up on events (messages, alarms,
// storage changes), does its work, and is shut down again when idle. That's
// why we never keep meaningful state in module-level variables — anything we
// need across wake-ups lives in chrome.storage.local.
//
// Responsibilities:
//   1. Coordinate the alert cascade when a watched value changes (siren + OS
//      notification + toolbar badge).
//   2. Manage the lifecycle of the offscreen document (needed for audio,
//      because service workers can't use <audio>).
//   3. React to alert-state changes made by ANY surface (popup, content
//      script banner, OS notification click) via storage.onChanged.
// ============================================================================


// URL of the offscreen document we create for audio playback. Relative to the
// extension root; Chrome resolves it via chrome.runtime.getURL internally.
const OFFSCREEN_URL = 'offscreen.html';

// A single, fixed ID for our OS notification. Using a constant ID means when
// a new alert fires, it *replaces* the previous notification rather than
// stacking a fresh toast every time.
const NOTIFICATION_ID = 'value-watch-alert';


// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
// The offscreen doc is the only place we can play audio in MV3. We create it
// lazily on first use, and reuse it thereafter.

async function ensureOffscreen() {
  // hasDocument() returns true if an offscreen doc already exists for this
  // extension. Chrome only allows one at a time, so we bail out if so.
  if (await chrome.offscreen.hasDocument()) return;

  // Create the hidden document. `reasons` must include a Chrome-approved
  // reason string — AUDIO_PLAYBACK is the one we need. `justification` is a
  // human-readable string shown to the user if they inspect it.
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Play alert sound when a watched value changes.'
  });
  console.log('[Value Watch] offscreen document created');
}

// Send a control message to the offscreen doc (e.g. "start playing the
// siren"). We wrap in try/catch because the offscreen doc may have been
// torn down and needs to be re-created — ensureOffscreen() handles that.
async function tellOffscreen(type) {
  try {
    await ensureOffscreen();
    // We tag the message with `target: 'offscreen'` so the offscreen
    // listener can distinguish our commands from other extension traffic
    // (chrome.runtime.sendMessage broadcasts to every context of the
    // extension, not just one target).
    await chrome.runtime.sendMessage({ target: 'offscreen', type });
    console.log('[Value Watch] sent to offscreen:', type);
  } catch (e) {
    console.warn('[Value Watch] tellOffscreen failed:', type, e);
  }
}


// ---------------------------------------------------------------------------
// Toolbar badge (the red number that appears over the extension icon)
// ---------------------------------------------------------------------------

// Increment the badge counter. Reads the current count from storage (source
// of truth), increments it, writes it back, and updates the visible badge.
// We keep the counter in storage rather than in a global so it survives
// service-worker restarts.
async function bumpBadge() {
  const { badgeCount = 0 } = await chrome.storage.local.get('badgeCount');
  const next = badgeCount + 1;
  await chrome.storage.local.set({ badgeCount: next });
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: '#d00000' });
}


// ---------------------------------------------------------------------------
// The alert cascade
// ---------------------------------------------------------------------------
// Called when a content script reports that a watched value has changed.
// This is the fan-out point: from here we trigger audio, notification, and
// badge — each on its own surface.

async function startAlert(watch, oldVal, newVal) {
  // Read the current alert flag BEFORE we set it. If an alert is already
  // active, we want to bump the badge (indicating a NEW change) but NOT
  // re-fire the siren or create a duplicate notification. This is the
  // rate-limiting/idempotency guard.
  const { alertActive } = await chrome.storage.local.get('alertActive');

  // Update the shared state. Every subscribed context (popup, content
  // script) will react to these two keys via storage.onChanged.
  await chrome.storage.local.set({
    alertActive: true,
    lastAlert: { watch, oldVal, newVal, at: Date.now() }
  });

  // Bump the badge regardless — subsequent changes should still be counted.
  bumpBadge();

  // If we were already alerting, stop here. The siren is looping and the
  // notification is still on screen from the previous change.
  if (alertActive) return;

  // First-time alert: start the siren...
  tellOffscreen('startSiren');

  // ...and pop the OS notification.
  try {
    chrome.notifications.create(NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title: `Value changed: ${watch.label}`,
      message: `${oldVal} → ${newVal}. Click to stop the alert.`,
      priority: 2,
      // requireInteraction: true means the toast stays on screen until the
      // user dismisses it — critical for alerts that must be acknowledged.
      requireInteraction: true
    });
  } catch (e) {
    console.warn('[Value Watch] notification failed:', e);
  }
}


// Fully clean up alert state. Not currently called anywhere directly because
// the storage.onChanged listener below does the same work reactively when
// alertActive flips to false — but kept as a utility for future use.
async function stopEverything() {
  await chrome.storage.local.set({ alertActive: false, badgeCount: 0 });
  chrome.action.setBadgeText({ text: '' });
  chrome.notifications.clear(NOTIFICATION_ID);
  tellOffscreen('stopSiren');
}


// ---------------------------------------------------------------------------
// Persisting each watch's "last seen" value
// ---------------------------------------------------------------------------
// The content script tells us "watch X now has value Y" — we update the
// stored watch record so the popup shows the current value even after the
// user closes and reopens it.

async function updateLastValue(id, value) {
  const { watches = [] } = await chrome.storage.local.get('watches');
  // Immutable map: create a new array with the target watch updated.
  const next = watches.map(w => w.id === id ? { ...w, lastValue: value } : w);
  await chrome.storage.local.set({ watches: next });
}


// ---------------------------------------------------------------------------
// Reactive listener: chrome.storage.onChanged
// ---------------------------------------------------------------------------
// This is our pub/sub bus. Any context that flips `alertActive` — popup
// button, in-page banner, OS notification click — triggers this listener.
// The listener translates the state change into concrete side effects
// (clear the badge, dismiss the notification, stop the siren).

chrome.storage.onChanged.addListener((changes, area) => {
  // We only care about local storage, not sync/session.
  if (area !== 'local') return;

  if (changes.alertActive) {
    const val = changes.alertActive.newValue;

    if (val === false) {
      // Alert was just stopped from some other surface — tear everything
      // down here.
      chrome.action.setBadgeText({ text: '' });
      chrome.storage.local.set({ badgeCount: 0 });
      chrome.notifications.clear(NOTIFICATION_ID);
      tellOffscreen('stopSiren');
    } else if (val === true) {
      // Alert became active — make sure audio is running. (The main
      // startAlert path also calls this; this handler covers cases like
      // the service worker restarting mid-alert.)
      tellOffscreen('startSiren');
    }
  }
});


// ---------------------------------------------------------------------------
// Runtime message router
// ---------------------------------------------------------------------------
// Handles messages sent from the popup, content scripts, and the offscreen
// document. All senders must be part of THIS extension — see the sender.id
// check below.

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;

  // SECURITY: only accept messages that originate from our own extension.
  // Chrome won't deliver messages from web pages unless we declare
  // externally_connectable (we don't), but this guard also blocks stray
  // messages from other installed extensions.
  if (sender.id !== chrome.runtime.id) return;

  if (msg.type === 'valueChanged') {
    // A content script reports a watched value has changed. Validate the
    // shape before using the payload, in case a bug in a caller produces
    // malformed data.
    const w = msg.watch;
    if (!w || typeof w.label !== 'string' || typeof w.id !== 'string') return;
    // Coerce values to strings so template literals in the notification
    // body don't misbehave if a caller passes a number/null.
    startAlert(w, String(msg.oldValue), String(msg.newValue));

  } else if (msg.type === 'updateLastValue') {
    // The content script observed a new value (possibly a first-ever
    // sighting, not necessarily a change). Persist it.
    if (typeof msg.id !== 'string') return;
    updateLastValue(msg.id, msg.value);

  } else if (msg.type === 'clearBadge') {
    // The popup was opened — user has "seen" the alerts, so reset the
    // badge counter.
    chrome.action.setBadgeText({ text: '' });
    chrome.storage.local.set({ badgeCount: 0 });

  } else if (msg.type === 'testAlert') {
    // The user pressed the "Test alert" button in the popup. Fire a fake
    // alert with placeholder values so they can verify siren/notification
    // permissions are working.
    startAlert(
      { id: 'test', label: 'Test alert', selector: 'n/a', urlPattern: 'n/a' },
      'OLD', 'NEW'
    );

  } else if (msg.type === 'offscreenReady') {
    // The offscreen doc just loaded and is asking whether it should be
    // playing audio right now. If an alert was already active when the
    // doc got torn down, this lets us resume seamlessly.
    chrome.storage.local.get('alertActive').then(({ alertActive }) => {
      if (alertActive) tellOffscreen('startSiren');
    });
  }
});


// ---------------------------------------------------------------------------
// Notification interaction handlers
// ---------------------------------------------------------------------------
// If the user clicks or dismisses the toast, we flip alertActive to false.
// Everything else cleans up via the storage.onChanged listener above.

chrome.notifications.onClicked.addListener((id) => {
  if (id === NOTIFICATION_ID) chrome.storage.local.set({ alertActive: false });
});

chrome.notifications.onClosed.addListener((id, byUser) => {
  // Only treat user-initiated closes as "stop alert" — programmatic
  // clears (from stopEverything) shouldn't recurse.
  if (id === NOTIFICATION_ID && byUser) chrome.storage.local.set({ alertActive: false });
});
