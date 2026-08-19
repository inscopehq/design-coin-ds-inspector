// Toolbar click → inject the inspector into the current page and its frames.
// Always fetches the LATEST hosted build first, so tool/registry updates reach
// every dev the moment they are pushed — no extension re-install. The bundled
// copy is only the offline fallback.
const HOSTED = 'https://inscopehq.github.io/design-coin-ds-inspector/ds-inspector.js';

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  let code = null;
  try {
    const r = await fetch(HOSTED, { cache: 'no-store' });
    if (r.ok) code = await r.text();
  } catch {}
  if (code) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: 'MAIN',
        func: (src) => {
          try {
            if (window.__DSI_LOADED__) return;
            const s = document.createElement('script');
            s.textContent = src;
            document.documentElement.appendChild(s);
          } catch {}
        },
        args: [code],
      });
      return;
    } catch {}
  }
  // Offline / fetch blocked: use the copy bundled at zip time.
  chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['ds-inspector.js'] });
});
