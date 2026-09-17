// ============================================================================
// content.js — Content Script (runs INSIDE every web page)
// ----------------------------------------------------------------------------
// A content script is injected by Chrome into every page the user visits
// (subject to the "matches" pattern in manifest.json — we use <all_urls>).
// It runs in an "isolated world": it can read and modify the page's DOM,
// but it can NOT access the page's JavaScript variables directly, and the
// page cannot access ours. This is a security boundary.
//
// Responsibilities:
//   1. Watch the page for DOM mutations (using MutationObserver).
//   2. For each user-configured watch whose URL pattern matches this tab,
//      re-check the value at the watched CSS selector.
//   3. If the value changed since we last checked, draw an in-page banner
//      immediately AND notify the background service worker so it can
//      trigger siren/notification/badge.
// ============================================================================


// In-memory copy of the user's watch list. Kept in sync with storage via the
// onChanged listener at the bottom.
let activeWatches = [];

// Current MutationObserver instance. We destroy and recreate it when the
// watch list changes.
let observer = null;

// Debounce timer handle. See scheduleCheck() below.
let debounceTimer = null;


// ---------------------------------------------------------------------------
// URL pattern matching
// ---------------------------------------------------------------------------
// Users enter patterns like "https://flex.twilio.com/queues-stats/*" — a
// simple wildcard syntax where * means "any characters". We translate that
// into a regex by escaping all regex metacharacters EXCEPT *, then replacing
// * with `.*`.

function urlMatches(pattern, url) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(url);
}


// ---------------------------------------------------------------------------
// Reading the watched value from the DOM
// ---------------------------------------------------------------------------
// Try to find the element the user specified and return its plain text.
// A missing element or malformed selector returns null — we swallow the
// SyntaxError because we don't want a bad user selector to crash the script.

function readValue(selector) {
  try {
    const el = document.querySelector(selector);
    return el ? el.textContent.trim() : null;
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// In-page banner UI
// ---------------------------------------------------------------------------
// We inject a red pulsing banner directly into the page as soon as a change
// is detected. This gives the user an immediate visual cue without waiting
// for the OS notification (which can be a few hundred ms behind).

// Add the pulse animation to <head> once. We namespace the id with double
// underscores to avoid colliding with anything on the host page.
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

// Remove any existing banner (idempotent).
function removeBanner() {
  document.getElementById('__value_watch_banner__')?.remove();
}

// Draw the banner. We build it programmatically using textContent (never
// innerHTML) so user-supplied strings (label, values) cannot cause XSS.
function showBanner(watch, oldVal, newVal) {
  removeBanner();
  ensurePulseStyle();

  const banner = document.createElement('div');
  banner.id = '__value_watch_banner__';
  banner.textContent = `Value Watch — "${watch.label}" changed: ${oldVal} → ${newVal}   ·   click to stop alert`;

  // Inline styles rather than a stylesheet so the banner is guaranteed to
  // look the same regardless of the host page's CSS. z-index maxed out
  // (2^31 - 1) to sit above any page overlay.
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

  // Clicking the banner counts as "I saw it, stop the alert". We remove
  // the banner locally and flip alertActive in storage; the storage
  // change fans out to background (stops siren + notification + badge)
  // and popup (hides its alert bar).
  banner.addEventListener('click', () => {
    removeBanner();
    chrome.storage.local.set({ alertActive: false });
  });

  (document.body || document.documentElement).appendChild(banner);
}


// ---------------------------------------------------------------------------
// The main check loop
// ---------------------------------------------------------------------------
// For each active watch, if its URL pattern matches this tab's URL, read
// the current value and compare against the last value we saw.

function checkWatches() {
  const url = location.href;

  for (const w of activeWatches) {
    if (!urlMatches(w.urlPattern, url)) continue;

    const current = readValue(w.selector);
    if (current === null) continue;  // element not present yet, skip

    const previous = w.lastValue;

    // If we've seen a value before and it changed → trigger the alert.
    // Note we require `previous != null` so the very first sighting after
    // page load doesn't spuriously alert (there's no "old" value to
    // compare against).
    if (previous != null && current !== previous) {
      showBanner(w, previous, current);
      chrome.runtime.sendMessage({
        type: 'valueChanged',
        watch: { id: w.id, label: w.label, selector: w.selector, urlPattern: w.urlPattern },
        oldValue: previous,
        newValue: current
      });
    }

    // Whether or not we alerted, if the value differs from what's stored,
    // update our in-memory copy and persist to storage. This runs on the
    // first sighting too (previous was null) so the popup shows a value.
    if (current !== previous) {
      w.lastValue = current;
      chrome.runtime.sendMessage({ type: 'updateLastValue', id: w.id, value: current });
    }
  }
}


// ---------------------------------------------------------------------------
// Debouncing MutationObserver callbacks
// ---------------------------------------------------------------------------
// Modern SPA frameworks (React, Emotion, etc.) can fire dozens of mutations
// per state change. We debounce by 300 ms so we only run the check once
// after a burst settles.

function scheduleCheck() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkWatches, 300);
}


// ---------------------------------------------------------------------------
// MutationObserver setup
// ---------------------------------------------------------------------------
// Watch the entire document body for any change: children added/removed
// (childList), text-node changes (characterData), and drill into every
// descendant (subtree: true). Cheap to attach; the callback is debounced.

function startObserving() {
  observer?.disconnect();
  observer = new MutationObserver(scheduleCheck);
  observer.observe(document.body || document.documentElement, {
    childList: true, subtree: true, characterData: true
  });
}

// True if any current watch applies to this page's URL. We use this to
// avoid attaching an observer on tabs where we have no work to do.
function applies() {
  return activeWatches.some(w => urlMatches(w.urlPattern, location.href));
}


// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
// On script load, pull the current watch list from storage. If any of them
// apply to this tab, attach the observer and do an initial check after a
// short delay (to let the page's own JS finish first paint).

async function init() {
  const { watches = [] } = await chrome.storage.local.get('watches');
  activeWatches = watches;
  if (applies()) {
    startObserving();
    setTimeout(checkWatches, 500);
  }
}


// ---------------------------------------------------------------------------
// React to storage changes
// ---------------------------------------------------------------------------
// If the user adds/removes a watch (via the popup), the storage listener
// fires here and we adjust our observer accordingly. Also handles the
// "alert stopped elsewhere" case — we remove our banner if the user
// clicked the OS notification or the popup's stop button.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.watches) {
    activeWatches = changes.watches.newValue || [];
    if (applies()) {
      startObserving();
      scheduleCheck();
    } else {
      // No watches apply to this tab anymore — release the observer.
      observer?.disconnect();
      observer = null;
    }
  }

  if (changes.alertActive && changes.alertActive.newValue === false) {
    removeBanner();
  }
});


// Kick things off.
init();
