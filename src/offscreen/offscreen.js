// Clipboard fallback for gestures that happen outside the popup (context
// menu, keyboard command). Copying from a focused textarea via
// document.execCommand('copy') is the documented MV3 offscreen recipe; the
// popup — with its own DOM and gesture — remains the primary path, and
// nothing here runs except in direct response to one of those gestures.

const area = document.getElementById('copy-area');

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ferry-cookie-copy') return;
  area.value = message.text;
  area.focus();
  area.select();
  const ok = document.execCommand('copy');
  area.value = '';
  sendResponse({ ok });
});
