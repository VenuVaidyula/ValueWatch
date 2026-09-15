# Value Watch — Privacy Notice

**Extension:** Value Watch (Chrome MV3)
**Version:** 1.0.0
**Last updated:** 2026-09-15

## Summary

**Value Watch collects, transmits, and stores zero personal data outside the user's own browser profile.** It makes no network requests, has no analytics or telemetry, uses no third-party services, and has no runtime dependencies. All data handled by the extension stays on the user's local device.

## 1. What data the extension accesses

The extension only accesses data that the user themselves configures it to watch:

| Data | How it's accessed | Purpose |
|---|---|---|
| **`textContent` of a single DOM element** identified by a user-supplied CSS selector | `document.querySelector(selector)` in the content script | Compare against the previous value to detect a change |
| **Active tab URL** (`location.href`) | Read in the content script | Match against the user's URL pattern to decide whether a watch applies |

The extension deliberately does **not** access:

- Cookies (no `cookies` permission)
- Network requests, request/response bodies (no `webRequest` permission)
- Tab metadata beyond the active tab's URL (no `tabs` permission)
- Browsing history, bookmarks, downloads, form data, credentials, or auth tokens
- Any resource behind an authentication boundary

## 2. What data is stored

All data is stored locally in `chrome.storage.local`, which is scoped per browser profile per extension. Data is **not** synced to Google's servers — the extension does not use `chrome.storage.sync`.

| Key | Contents |
|---|---|
| `watches` | User-defined `{ label, urlPattern, selector, lastValue }` entries |
| `alertActive` | Boolean — whether an alert is currently active |
| `lastAlert` | `{ watch, oldVal, newVal, at }` — most recent triggering change |
| `badgeCount` | Number of unread alerts on the toolbar icon |

The only user-authored fields are `label`, `urlPattern`, and `selector`. `lastValue` is the most recent value read from the watched DOM element.

## 3. Could stored data contain personal data?

Only if the user deliberately configures a watch on a page element that displays personal data — in which case the plain-text value of that element would be written to `chrome.storage.local` as `lastValue`. The extension's intended use case (numeric queue counters and similar metrics) does not involve personal data.

**Guidance for users:** configure watches only on non-sensitive values such as counters and metrics. Do not point watches at elements displaying PII, credentials, or confidential content.

## 4. Data flow

All data flow is strictly local. There are no `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or equivalent network calls anywhere in the codebase.

```
User configures watch  ──►  chrome.storage.local  ──►  content script (in tab)
                                                              │
                                                              ▼
                                                     reads DOM element
                                                              │
                                                              ▼
                                                     detects change
                                                              │
                                                              ▼
                            background service worker  ──►  local alerts:
                                                             • in-page banner
                                                             • OS notification
                                                             • toolbar badge
                                                             • audio siren (offscreen)
```

For a detailed component and message flow diagram, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 5. Third parties

**None.** The extension has zero third-party services, SDKs, CDNs, analytics providers, or external endpoints. It has zero runtime dependencies — all code is vanilla JavaScript, HTML, and CSS written in-house.

## 6. Cross-border data transfer

Not applicable — data does not leave the user's device.

## 7. Data retention

Values persist in the local store until:
- The user removes the specific watch via the popup, or
- The user clears the extension's storage (via `chrome://extensions` → Details → Site data), or
- The user uninstalls the extension (which purges all extension storage)

There is no server-side retention because there is no server.

## 8. Data subject rights

All data handled by the extension is directly under the user's control:

| Right | How it is served |
|---|---|
| **Access** | View all stored watches and their last-seen values in the extension popup |
| **Rectification** | Edit or replace any watch by removing and re-adding it |
| **Deletion** | Remove individual watches from the popup, or uninstall the extension to purge everything |
| **Portability** | Not applicable — data is local, user-authored, and low-volume |
| **Objection / withdrawal** | Uninstall the extension |

## 9. Consent and notice

Users install the extension knowingly and configure each watch themselves. There is no passive, automated, or background data collection. The extension does not present a consent dialog because it does not process personal data on behalf of Twilio.

## 10. Authentication and identity

The extension has no login, no accounts, and no session tokens. It does not access, read, forward, or persist cookies, auth headers, session credentials, or any identity data from the pages it runs on.

## 11. Security controls

Full threat model in [`SECURITY.md`](SECURITY.md). Key privacy-relevant controls:

- Chrome Manifest V3 with a minimal permission set (`storage`, `notifications`, `offscreen`)
- No `cookies`, `webRequest`, `tabs`, `history`, `identity`, or `scripting` permissions
- No `externally_connectable` — external web pages cannot message the extension
- Runtime message handlers validate `sender.id === chrome.runtime.id`
- All UI rendering uses `textContent` — no XSS surface
- No `eval` or dynamic script; MV3 default Content Security Policy is unmodified
- Zero third-party dependencies

## 12. Known limitations (disclosed)

- The content script is declared with `<all_urls>` host access so that users can configure watches on any origin they visit. The script performs no work on non-matching URLs, but the broad declaration is visible to Chrome and appears in the install-time permission warning.
- `chrome.storage.local` is written in plaintext by the Chrome API. Any process running as the user can read the underlying store; this is inherent to Chrome extensions and outside the extension's threat boundary. Chrome does not offer an encrypted per-extension storage API.

## 13. Contact

For privacy questions or concerns about this extension, open an issue or security advisory on the [GitHub repository](https://github.com/VenuVaidyula/ValueWatch).
