# Value Watch — Security Sign-off & Threat Model

**Extension:** Value Watch (Chrome MV3)
**Scope:** Version 1.0.0
**Last reviewed:** 2026-09-15

---

## 1. What Data the Extension Accesses

Value Watch operates entirely on data that is **already visible to the user in their own browser**. It does not read cookies, network traffic, credentials, or any resource behind an authentication boundary.

| Data | How it's accessed | Where it goes |
|---|---|---|
| **Page DOM text** (`textContent` of a single user-supplied CSS selector) | `document.querySelector(selector)` in the content script, on pages matching the user's URL pattern | Compared against previous value in memory; new value written to `chrome.storage.local` |
| **Active tab URL** (`location.href`) | Read in the content script to match against the user's URL pattern | Never leaves the local machine; used only for pattern matching |
| **User-configured watches** (label, URL pattern, selector) | Entered in the popup by the user | `chrome.storage.local` |
| **Alert state** (`alertActive`, `lastAlert`, `badgeCount`) | Written by the background service worker | `chrome.storage.local` |

**Data the extension explicitly does NOT access:**

- Cookies (no `cookies` permission requested)
- Network requests, request/response bodies (no `webRequest` / `webRequestBlocking`)
- Tab metadata beyond the active URL of the tab the content script runs in (no `tabs` permission)
- Browsing history, bookmarks, downloads, form data
- Any resource requiring authentication — the extension never intercepts or reads auth tokens, session cookies, or headers

---

## 2. Permissions Required and Why

Declared in `manifest.json`:

| Permission | Why it's needed | Minimization |
|---|---|---|
| `storage` | Persist the user's watch configurations and alert state across service-worker restarts | Uses `chrome.storage.local` only — data is not synced to Google servers |
| `notifications` | Show the OS-level alert toast when a watched value changes | Uses a single fixed notification ID (`value-watch-alert`) so alerts replace rather than accumulate |
| `offscreen` | MV3 service workers cannot play audio; an offscreen document is the only supported way to play a siren | Only created lazily on first alert; only reason claimed is `AUDIO_PLAYBACK` |
| `host_permissions: ["<all_urls>"]` | The user configures arbitrary URL patterns, so the content script must be injectable on any origin they choose to watch | See Residual Risk R1 below |

**Permissions deliberately NOT requested:**
`cookies`, `webRequest`, `tabs`, `activeTab`, `history`, `bookmarks`, `downloads`, `identity`, `management`, `debugger`, `nativeMessaging`, `webNavigation`, `scripting` (dynamic injection is not used).

**`externally_connectable` is NOT declared** — this is important: web pages and other extensions cannot open a runtime message channel to this extension.

---

## 3. Data Flow

All data flow is **strictly local**. The extension performs zero network I/O — there are no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or `navigator.sendBeacon` calls anywhere in the codebase.

```
┌─────────────┐   user input    ┌──────────────────────┐
│    Popup    │────────────────►│ chrome.storage.local │
└─────────────┘                 └──────────┬───────────┘
                                           │ storage.onChanged
                                           ▼
                              ┌────────────────────────┐
                              │  Content Script (tab)  │  reads DOM
                              │  MutationObserver      │◄──── watched page
                              └──────────┬─────────────┘
                                         │ chrome.runtime.sendMessage
                                         │ (same extension ID only)
                                         ▼
                              ┌────────────────────────┐
                              │ Background Service     │
                              │ Worker                 │
                              └───┬────────────┬───────┘
                                  │            │
                    chrome.notifications   chrome.runtime.sendMessage
                                  │            │
                                  ▼            ▼
                             OS toast    Offscreen Document
                                          (audio playback)
```

**No external services are contacted.** The siren sound is synthesized in-memory as a WAV blob at runtime — no CDN, no bundled binary asset fetched.

---

## 4. Authentication

**Not applicable to the extension itself.** Value Watch has no accounts, no login, no server-side component, and does not participate in authentication of any kind. It stores no credentials.

The user-facing scenario (monitoring an authenticated site such as Twilio Flex via Okta SSO) is authenticated **by the browser and the target site**, not by the extension. The extension only reads DOM values from pages the user has already authenticated to and loaded normally. It does not access, forward, or observe auth tokens, cookies, or headers.

---

## 5. Attack Vectors Specific to Browser Extensions

### 5.1 Content-script injection into unintended origins

**Vector:** A content script declared with `<all_urls>` runs on every page the user visits, including sensitive origins (banking, webmail, corporate internal apps).
**Impact if exploited:** A bug in `content.js` could theoretically read arbitrary DOM on those pages.
**Mitigation:**
- Content script performs **no work** unless the current URL matches a user-configured `urlPattern` (`applies()` guard in `content.js`).
- `MutationObserver` is only attached when a matching watch exists; it is disconnected otherwise.
- Only `element.textContent` is read — no attribute values, no form contents, no serialization.
- Read values are stored per-watch in `chrome.storage.local` (per-profile, per-extension) and never transmitted.
- Content scripts run in an isolated world; page scripts cannot access the extension's variables.

**Residual risk:** See R1.

### 5.2 Message-passing vulnerabilities

**Vector:** Background handlers that trust incoming messages could be invoked by a malicious web page or another extension to trigger privileged actions.
**Mitigation:**
- No `externally_connectable` is declared → web pages cannot `sendMessage` to this extension. Only bundled scripts (content, popup, offscreen) can.
- All `chrome.runtime.onMessage` listeners (in `background.js` and `offscreen.js`) verify `sender.id === chrome.runtime.id` and reject messages that fail the check.
- Message payload shape is validated before use (e.g. `msg.watch.id` must be a string) so a malformed message cannot inject unexpected structures into storage.

### 5.3 XSS in extension UI

**Vector:** User-supplied strings (label, URL pattern, selector, watched value) rendered into the popup or the in-page banner could be interpreted as HTML.
**Mitigation:**
- All user-supplied strings are rendered via `textContent`, never `innerHTML` or `insertAdjacentHTML`.
- No `eval`, `new Function()`, or dynamic `<script>` injection anywhere in the codebase.
- MV3's default Content Security Policy for extension pages prohibits inline scripts and remote scripts; the extension does not override it.
- `popup.html` and `offscreen.html` load only same-origin, bundled `<script src="…">` files.

### 5.4 Selector injection

**Vector:** A user-supplied selector is passed to `document.querySelector`.
**Analysis:** CSS selectors are not an execution vector — `querySelector` does not interpret strings as code. Invalid selectors throw a `SyntaxError`, which is caught (`readValue` in `content.js`). No sanitization is required beyond the existing try/catch.

### 5.5 Extension-to-extension attacks

**Vector:** Another installed extension attempting to read or write this extension's storage or message its background worker.
**Mitigation:**
- Chrome isolates `chrome.storage.local` per extension ID — no other extension can read or write it.
- Sender validation (5.2) rejects messages originating from a different extension ID.

### 5.6 Storage tampering by local malware

**Vector:** Malware with local file-system access could modify the on-disk store backing `chrome.storage.local`.
**Analysis:** Any process with the ability to modify Chrome's profile directory can already compromise the entire browser session — this is outside the extension's threat boundary. Chrome's profile is protected at the OS level (file permissions, FileVault / BitLocker at rest).

### 5.7 Denial of attention (notification / audio abuse)

**Vector:** A page that rapidly mutates a watched value could produce a stream of overlapping notifications and siren restarts.
**Mitigation:**
- Content-script `MutationObserver` output is debounced (300 ms) before comparing values.
- `startAlert` in `background.js` is idempotent while `alertActive` is `true` — a re-entrant call updates `lastAlert` and bumps the badge count but does not re-fire the siren or create a duplicate notification.
- A single fixed `NOTIFICATION_ID` means new alerts replace prior ones rather than stacking.
- The user can silence everything by flipping `alertActive` to `false` from any surface (banner, popup, notification click).

### 5.8 Supply chain

**Vector:** Compromise via a third-party dependency.
**Analysis:** The extension has **zero runtime dependencies** — no npm packages, no bundled libraries, no CDN scripts. All code is hand-written vanilla JS/HTML/CSS. Nothing to compromise upstream.

---

## 6. Residual Risks (Accepted)

| ID | Risk | Rationale for accepting |
|----|------|--------------------------|
| **R1** | Content script runs on `<all_urls>` — broader host access than strictly needed for a given user's actual watches. Chrome Web Store will show a "read data on all websites" warning at install. | Users configure arbitrary URL patterns after install; requesting host permission dynamically per watch is possible via `optional_host_permissions` + `chrome.scripting.registerContentScripts` and is tracked as a future hardening (see roadmap). Current design is safe because the script does no work on non-matching URLs. |
| **R2** | Watched values are stored in `chrome.storage.local` in plaintext. | Chrome provides no encrypted per-extension storage API. Data is isolated per extension per user profile and sits on the OS-level encrypted disk of any modern managed device. Values are low-sensitivity by design (queue counters and similar). Encrypting with a user-supplied passphrase would be a significant UX regression for this use case. |
| **R3** | Any process running as the user can read the extension's `chrome.storage.local` file. | Same threat boundary as R2; local root/user compromise is out of scope. |

---

## 7. Security-Relevant Design Decisions

- **All persistent state lives in `chrome.storage.local`.** Service workers are ephemeral in MV3, and putting state in worker globals would create race conditions after restart. Storage is the single source of truth and is watched by all contexts via `chrome.storage.onChanged`.
- **`alertActive` is a single boolean fan-out flag.** Any UI surface (banner, popup, notification) stops the alert by flipping this flag. This avoids a proliferation of pairwise stop-messages and eliminates the possibility that one surface stops the alert while another leaves it running.
- **The offscreen document exists solely for audio.** It has no other capability, no storage access it wouldn't already have, and no network access.
- **The siren is synthesized in-memory at runtime.** No audio asset is bundled or fetched, removing an entire class of supply-chain and tampering concerns.

---

## 8. Reporting Security Issues

If you discover a vulnerability, please report it privately by opening a GitHub security advisory on the repository rather than filing a public issue.
