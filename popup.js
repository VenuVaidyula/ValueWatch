// ============================================================================
// popup.js — The extension's toolbar popup UI
// ----------------------------------------------------------------------------
// This script runs inside popup.html, which Chrome shows when the user clicks
// the extension icon in the toolbar. The popup is destroyed and re-created
// every time it opens, so all state must come from chrome.storage.local — not
// from module-level variables.
//
// Responsibilities:
//   1. Render the current list of watches, and each watch's last-seen value.
//   2. Let the user add and remove watches (writes to chrome.storage.local).
//   3. Show an "Alert active" bar when an alert is in progress, with a stop
//      button that flips alertActive to false.
//   4. Provide a "Test alert sound" button (sends a testAlert message to the
//      background worker).
// ============================================================================


// ---------------------------------------------------------------------------
// DOM element references — the popup's static UI (defined in popup.html)
// ---------------------------------------------------------------------------

const listEl = document.getElementById('watch-list');       // <ul> of watches
const form = document.getElementById('add-form');           // add-watch form
const alertBar = document.getElementById('alert-bar');      // red pulsing bar
const alertText = alertBar.querySelector('.alert-text');    // text inside it
const stopBtn = document.getElementById('stop-alert');      // stop button


// ---------------------------------------------------------------------------
// Render the list of watches
// ---------------------------------------------------------------------------
// Called on popup open and whenever the `watches` key in storage changes.
// We build the DOM element-by-element using textContent (never innerHTML)
// so user-supplied strings can never be interpreted as HTML.

async function load() {
  const { watches = [] } = await chrome.storage.local.get('watches');

  listEl.innerHTML = '';  // safe: we're clearing, not injecting user content

  // Empty state — first-time or all-removed.
  if (watches.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.border = 'none';
    li.textContent = 'No watches yet. Add one above.';
    listEl.appendChild(li);
    return;
  }

  // Render each watch as a list item with a remove button, label, meta
  // line (URL pattern + selector), and current value.
  for (const w of watches) {
    const li = document.createElement('li');

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.textContent = 'Remove';
    remove.dataset.id = w.id;  // store the watch id for the click handler

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


// ---------------------------------------------------------------------------
// Show/hide the "alert active" bar at the top of the popup
// ---------------------------------------------------------------------------

async function refreshAlertBar() {
  const { alertActive, lastAlert } = await chrome.storage.local.get(['alertActive', 'lastAlert']);
  if (alertActive) {
    alertBar.hidden = false;
    // If we have details about the triggering change, show them; otherwise
    // fall back to a generic message.
    alertText.textContent = lastAlert
      ? `${lastAlert.watch.label}: ${lastAlert.oldVal} → ${lastAlert.newVal}`
      : 'Alert active';
  } else {
    alertBar.hidden = true;
  }
}


// ---------------------------------------------------------------------------
// Adding a new watch — form submit handler
// ---------------------------------------------------------------------------

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  // Read + trim the three inputs.
  const label = document.getElementById('label').value.trim();
  const urlPattern = document.getElementById('urlPattern').value.trim();
  const selector = document.getElementById('selector').value.trim();
  if (!label || !urlPattern || !selector) return;  // all required

  // Append a new watch to the array. crypto.randomUUID() gives us a stable
  // id we can use as a React-style key for updates/removals.
  const { watches = [] } = await chrome.storage.local.get('watches');
  watches.push({
    id: crypto.randomUUID(),
    label, urlPattern, selector,
    lastValue: null   // no value observed yet
  });
  await chrome.storage.local.set({ watches });

  form.reset();
  load();  // re-render the list immediately
});


// ---------------------------------------------------------------------------
// Removing a watch — event delegation on the list
// ---------------------------------------------------------------------------
// Instead of attaching a click handler to every Remove button, we listen on
// the <ul> and check whether the click landed on a `.remove` button. This
// keeps the code simple and handles dynamically-added items automatically.

listEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.remove');
  if (!btn) return;

  const id = btn.dataset.id;
  const { watches = [] } = await chrome.storage.local.get('watches');
  await chrome.storage.local.set({ watches: watches.filter(w => w.id !== id) });
  load();
});


// ---------------------------------------------------------------------------
// Stop button on the alert bar
// ---------------------------------------------------------------------------
// Flipping alertActive to false is enough — the storage.onChanged listener
// in background.js will pick up the change, clear the badge, dismiss the
// notification, and stop the siren.

stopBtn.addEventListener('click', () => {
  chrome.storage.local.set({ alertActive: false });
});


// ---------------------------------------------------------------------------
// "Test alert sound" button
// ---------------------------------------------------------------------------
// Sends a message to the background worker asking it to fire a synthetic
// alert. Useful for the user to verify OS notification and audio
// permissions are working, without waiting for a real change.

document.getElementById('test-alert').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'testAlert' });
});


// ---------------------------------------------------------------------------
// Live updates while the popup is open
// ---------------------------------------------------------------------------
// If storage changes while the popup is visible (e.g. a watch's lastValue
// updates because the content script saw a new number, or the user stops
// the alert from the banner), we re-render.

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.alertActive || changes.lastAlert) refreshAlertBar();
  if (changes.watches) load();
});


// ---------------------------------------------------------------------------
// Popup-open side effects
// ---------------------------------------------------------------------------
// The user is looking at the popup right now, so any accumulated alerts
// have been "seen". Clear the badge counter.
chrome.runtime.sendMessage({ type: 'clearBadge' });

// Initial render.
load();
refreshAlertBar();
