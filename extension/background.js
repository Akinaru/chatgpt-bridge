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
        // every open ChatGPT tab is reported, so the owner can pick the one that works
        const tabs = (await chrome.tabs.query({url: 'https://chatgpt.com/*'})).map((t) => ({id: t.id, title: t.title, url: t.url, active: t.active}));
        reply({ok: true, job: (await call('/ext/next', {tab: sender.tab?.id, url: sender.tab?.url, tabs})).job});
      } else if (msg.type === 'getjob') {
        reply({ok: true, job: (await call(`/ext/job/${msg.id}`)).job});
      } else if (msg.type === 'progress') {
        await call(`/ext/progress/${msg.id}`, {step: msg.step});
        reply({ok: true});
      } else if (msg.type === 'result') {
        await call(`/ext/result/${msg.id}`, {image: msg.image, chatUrl: msg.chatUrl, error: msg.error});
        reply({ok: true});
      } else reply({ok: false, error: 'unknown message'});
    } catch (e) {
      console.warn('[aki-bridge] bridge call failed', String(e));
      reply({ok: false, error: String(e)});
    }
  })();
  return true;
});

// Guard (every 10 s while awake, and every 30 s through chrome.alarms, which wakes the service worker):
// - the working tab is never discarded (autoDiscardable false);
// - a job is waiting and no ChatGPT tab polls: wake the working tab (bring it to the front, focus its window); if it
//   still does not answer after 45 s, reload it; no tab at all: open one;
// - the bridge asks for an extension reload (after an update): chrome.runtime.reload().
let wokeAt = 0;
async function guard() {
  try {
    const s = await call('/ext/status');
    const ctl = await call('/ext/control').catch(() => ({}));
    if (ctl.reload) {
      console.warn('[aki-bridge] reload requested by the bridge');
      chrome.runtime.reload();
      return;
    }
    const tabs = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
    const w = tabs.find((t) => t.id === s.worker);
    if (w && w.autoDiscardable !== false) await chrome.tabs.update(w.id, {autoDiscardable: false}).catch(() => {});
    if (!s.waiting || Date.now() - lastSeen < 15000 || s.settings?.autoOpenTab === false && !w) return;
    if (!tabs.length) {
      await chrome.tabs.create({url: 'https://chatgpt.com/', active: true});
      return;
    }
    const t = w ?? tabs[0];
    if (t.discarded) {
      await chrome.tabs.reload(t.id);
      wokeAt = Date.now();
      return;
    }
    if (!wokeAt || Date.now() - wokeAt > 120000) {
      // a hidden tab is throttled by the browser: bring it to the front so its script runs at full speed
      await chrome.tabs.update(t.id, {active: true}).catch(() => {});
      await chrome.windows.update(t.windowId, {focused: true}).catch(() => {});
      wokeAt = Date.now();
    } else if (Date.now() - wokeAt > 45000) {
      await chrome.tabs.reload(t.id).catch(() => {});
      wokeAt = Date.now();
    }
  } catch {
    // bridge not running: nothing to do
  }
}
setInterval(guard, 10000);
chrome.alarms.create('aki-guard', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener((a) => a.name === 'aki-guard' && guard());
chrome.runtime.onStartup.addListener(guard);
chrome.runtime.onInstalled.addListener(guard);

// After an install / reload of the extension, the open ChatGPT tabs still run the old (dead) script: inject the new
// one so nobody has to reload the tabs.
chrome.runtime.onInstalled.addListener(async () => {
  for (const t of await chrome.tabs.query({url: 'https://chatgpt.com/*'})) {
    chrome.scripting.executeScript({target: {tabId: t.id}, files: ['content.js']}).catch(() => {});
  }
});
