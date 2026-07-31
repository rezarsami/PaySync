// background.js — MV3 service worker. Its only job is to reflect the number of
// pending purchase captures on the toolbar icon badge, so the user notices there
// is something to confirm. No network, no data leaves the device.

function refreshBadge() {
  chrome.storage.local.get(["pendingCaptures"], (r) => {
    const n = (r.pendingCaptures || []).length;
    chrome.action.setBadgeText({ text: n ? String(n) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#F0553A" });
  });
}

// Content scripts ask us to refresh after stashing a capture.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "REFRESH_BADGE") { refreshBadge(); sendResponse?.({ ok: true }); }
  return true;
});

// Keep the badge in sync if captures change from anywhere (e.g. popup confirms).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.pendingCaptures) refreshBadge();
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
