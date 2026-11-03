// Talks to the local bridge (http://127.0.0.1:3777) for the ChatGPT tab's content script, which cannot reach it itself.
// If a job is waiting and no ChatGPT tab is open, it opens one in the background.
const BRIDGE = 'http://127.0.0.1:3777';
let lastSeen = 0;

async function call(path, body) {
  const r = await fetch(BRIDGE + path, body ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  if (!r.ok) throw new Error(`bridge ${path}: ${r.status}`);
  return r.json();
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'poll') {
        lastSeen = Date.now();
        reply({ok: true, job: (await call('/ext/next', {tab: sender.tab?.id, url: sender.tab?.url})).job});
      } else if (msg.type === 'progress') {
        await call(`/ext/progress/${msg.id}`, {step: msg.step});
        reply({ok: true});
      } else if (msg.type === 'result') {
        await call(`/ext/result/${msg.id}`, {image: msg.image, chatUrl: msg.chatUrl, error: msg.error});
        reply({ok: true});
      } else reply({ok: false, error: 'unknown message'});
    } catch (e) {
      reply({ok: false, error: String(e)});
    }
  })();
  return true;
});

// Guard: a job is waiting but no ChatGPT tab is polling → open one (in the background).
async function guard() {
  try {
    const s = await call('/ext/status');
    if (!s.waiting || Date.now() - lastSeen < 15000) return;
    const tabs = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
    if (!tabs.length) await chrome.tabs.create({url: 'https://chatgpt.com/', active: false});
    else if (tabs[0].discarded) await chrome.tabs.reload(tabs[0].id);
  } catch {
    // bridge not running: nothing to do
  }
}
setInterval(guard, 10000);
chrome.runtime.onStartup.addListener(guard);
chrome.runtime.onInstalled.addListener(guard);
