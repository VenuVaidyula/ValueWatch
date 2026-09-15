# Value Watch

A Chrome extension (Manifest V3) that watches a chosen element on a webpage and alerts you the moment its text value changes. When a change is detected, Value Watch fires a page banner, an OS notification, a beep, and a toolbar badge — so you don't have to keep the tab in focus.

It was built for monitoring live counters that update in place - for example, the **Waiting Tasks** cell for a queue in Twilio Flex — but it works on any page where the element you care about can be pinned down with a CSS selector.

## Features

- Watch any element on any URL via a CSS selector
- Multi-signal alerting: in-page banner, desktop notification, audio beep, and badge on the extension icon
- Add, label, and manage multiple watches from a simple popup UI
- Settings persist in `chrome.storage.local`

## Installation and Setup

### 1. Install the extension

1. Download and extract the extension package to a local directory.
2. In Chrome, navigate to `chrome://extensions/` and toggle **Developer mode** on (upper-right).
3. Click **Load unpacked** (upper-left) and select the unzipped extension directory.
4. Confirm that **Value Watch** appears in the installed extensions list.
5. Open **Details** on the Value Watch card and enable **Pin to toolbar** for quick access.

### 2. Open the page you want to monitor

Launch Support on Flex via Okta SSO and navigate to the **Queue Stats** monitoring section (or any other page whose values you want to watch).

### 3. Configure a watch

1. Open the Value Watch popup from the browser toolbar.
2. In the **Label** field, enter a descriptive name (e.g. `Test`).
3. In the **URL** field, enter the target monitoring URL, e.g.:

   ```
   https://flex.twilio.com/queues-stats/
   ```

4. In the **CSS Selector** field, enter the selector for the element you want to watch. For the Flex Voice queue's Waiting Tasks cell:

   ```
   [data-testid="Waiting-Tasks"] li[data-queue-name="Voice"]
   ```

5. Click **Add watch** to register the monitoring parameters.
6. Refresh the target page to confirm the watch is active.

> **Tip:** Have the URL and CSS selector handy in a separate tab before you open the popup. If you click away from the popup while adding a watch, the fields reset.
