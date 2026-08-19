// Toolbar click → inject the bundled inspector into the current page (and its
// frames). The inspector itself guards against double-injection.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ['ds-inspector.js'],
  });
});
