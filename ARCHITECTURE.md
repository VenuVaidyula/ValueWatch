# Value Watch — Architecture Blueprint

## Overview

Value Watch is a Chrome Manifest V3 extension composed of **four runtime contexts** that coordinate via `chrome.runtime` messages and a single shared state store (`chrome.storage.local`). No servers, no external calls — everything runs in the user's browser.

## Runtime Contexts

```
┌───────────────────────────────────────────────────────────────────────┐
│                          chrome.storage.local                         │
│      (single source of truth: watches, alertActive, lastAlert, …)     │
└───────────────────────────────────────────────────────────────────────┘
        ▲                    ▲                    ▲                ▲
        │ read/write         │ read/write         │ read/write     │
        │                    │                    │                │
┌───────┴────────┐   ┌───────┴────────┐   ┌───────┴────────┐   ┌───┴──────────┐
│     Popup      │   │ Content Script │   │  Service Worker│   │  Offscreen   │
│  popup.html /  │   │   content.js   │   │  background.js │   │  Document    │
│    popup.js    │   │  (per tab)     │   │  (per browser) │   │ offscreen.js │
│                │   │                │   │                │   │              │
│ • configure    │   │ • MutationObs. │   │ • orchestrator │   │ • audio      │
│ • view state   │   │ • read DOM     │   │ • notifications│   │   playback   │
│ • start test   │   │ • in-page      │   │ • badge        │   │              │
│ • stop alert   │   │   banner       │   │ • offscreen    │   │              │
│                │   │                │   │   lifecycle    │   │              │
└────────────────┘   └────────┬───────┘   └────────┬───────┘   └──────▲───────┘
                              │                    │                  │
                              │  valueChanged msg  │                  │
                              └───────────────────►│  start/stopSiren │
                                                   └─────────────────►│
```

### 1. Popup (`popup.html`, `popup.js`, `popup.css`)
The user-facing UI. It **only reads and writes `chrome.storage.local`** — it never talks to the DOM directly or to the content script. Responsibilities:
- Add / remove watches (writes to `watches`)
- Render the current watch list and last-seen values
- Show the "Alert active" bar and stop button (writes `alertActive: false`)
- Fire a test alert (sends `testAlert` msg to background)

### 2. Content Script (`content.js`)
Injected into every page (`<all_urls>`, `document_idle`). One instance per matching tab. Responsibilities:
- Read active `watches` from storage on load, subscribe to changes
- For any watch whose `urlPattern` matches the current URL, set up a `MutationObserver` on `document.body`
- On DOM change (debounced 300 ms), re-read each watched selector's `textContent`
- If a value differs from `lastValue`:
  1. Show a pulsing red banner in the page (client-side, immediate)
  2. Send a `valueChanged` message to the background worker
  3. Persist the new value via `updateLastValue`

### 3. Background Service Worker (`background.js`)
The central coordinator. Ephemeral by MV3 design — it wakes on messages / events. Responsibilities:
- Receive `valueChanged` from content scripts and trigger the alert cascade:
  - Set `alertActive: true` and record `lastAlert` in storage
  - Ensure the offscreen document exists, then tell it to `startSiren`
  - Show a `chrome.notifications` toast with `requireInteraction: true`
  - Increment the toolbar badge count
- Watch `chrome.storage.onChanged` for `alertActive` transitions and mirror them to the offscreen document (so any surface — banner click, popup button, notification click — can stop everything by flipping one flag)
- Handle `testAlert`, `clearBadge`, and the `offscreenReady` handshake

### 4. Offscreen Document (`offscreen.html`, `offscreen.js`)
Exists solely to play audio — MV3 service workers cannot use `<audio>` or Web Audio APIs. Responsibilities:
- On load, synthesize a two-tone WAV siren in memory (no bundled audio asset)
- Listen for `startSiren` / `stopSiren` messages, control looping playback
- Send `offscreenReady` back to the worker so an active alert resumes if the offscreen doc was recreated

## Shared State Schema (`chrome.storage.local`)

| Key           | Type    | Written by          | Meaning                                                             |
|---------------|---------|---------------------|---------------------------------------------------------------------|
| `watches`     | Array   | popup, background   | `{ id, label, urlPattern, selector, lastValue }` per watch          |
| `alertActive` | boolean | background, popup, content, notifications | Master alert flag — flipping to `false` stops everything |
| `lastAlert`   | object  | background          | `{ watch, oldVal, newVal, at }` — last change that triggered alert  |
| `badgeCount`  | number  | background          | Number of unread alerts shown on the toolbar badge                  |

`chrome.storage.onChanged` is the primary pub/sub mechanism — all four contexts subscribe.

## Message Protocol (`chrome.runtime.sendMessage`)

| Message           | From → To                | Purpose                                    |
|-------------------|--------------------------|--------------------------------------------|
| `valueChanged`    | content → background     | A watched value changed — start alert      |
| `updateLastValue` | content → background     | Persist a new value to `watches[i].lastValue` |
| `testAlert`       | popup → background       | Fire a synthetic alert for testing         |
| `clearBadge`      | popup → background       | Reset the badge counter when popup opens   |
| `startSiren`      | background → offscreen   | Begin looping audio                        |
| `stopSiren`       | background → offscreen   | Stop audio                                 |
| `offscreenReady`  | offscreen → background   | Handshake — resume alert if still active   |

## Key Flows

**Detecting and alerting on a change:**
```
DOM mutation on tab
  → content.js MutationObserver (debounced 300ms)
  → readValue(selector) differs from lastValue
  → content.js showBanner()                  [in-page red banner]
  → sendMessage 'valueChanged'
  → background.js startAlert()
       ├─ storage.set alertActive=true, lastAlert=…
       ├─ tellOffscreen('startSiren')        [audio via offscreen doc]
       ├─ chrome.notifications.create()      [OS notification]
       └─ chrome.action.setBadgeText()       [red badge on toolbar icon]
```

**Stopping an alert (any surface):**
```
User clicks banner  ──┐
User clicks popup   ──┤
User clicks toast   ──┼──►  storage.set alertActive=false
Notification closed ──┘
                          │
                          ▼
                storage.onChanged fires in all contexts:
                  ├─ background: clear badge + notification + siren
                  ├─ content:    remove banner
                  └─ popup:      hide alert bar
```

## Permissions (`manifest.json`)

| Permission        | Why                                                            |
|-------------------|----------------------------------------------------------------|
| `storage`         | Persist watches and alert state                                |
| `notifications`   | OS-level alert toast                                           |
| `offscreen`       | Create the audio-playback document                             |
| `<all_urls>` (host)| Content-script injection on the user-configured target URLs   |

## Design Constraints & Rationale

- **MV3 service workers are ephemeral** → all durable state lives in `chrome.storage.local`, not in worker globals.
- **MV3 service workers cannot play audio** → the offscreen document exists purely for `<audio>` playback.
- **Any UI surface can stop the alert** → we make `alertActive` a single boolean flag and let `storage.onChanged` fan out to all contexts, rather than pairwise messaging.
- **In-page banner is drawn by the content script directly** (not by injecting from the worker) so it appears with zero latency after the mutation is observed.
- **Selectors are user-supplied** → the extension has no coupling to any specific site; Twilio Flex is just the primary use case.
