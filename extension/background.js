// Talks to the local bridge (http://127.0.0.1:3777) for the ChatGPT tab's content script, which cannot reach it itself.
// If a job is waiting and no ChatGPT tab is open, it opens one in the background (never brings Chrome to the front).
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
      } else if (msg.type === 'alive') {
        reply({ok: true, alive: (await call(`/ext/alive/${msg.id}`)).alive});
      } else if (msg.type === 'getjob') {
        reply({ok: true, job: (await call(`/ext/job/${msg.id}`)).job});
      } else if (msg.type === 'progress') {
        await call(`/ext/progress/${msg.id}`, {step: msg.step, sent: !!msg.sent});
        reply({ok: true});
      } else if (msg.type === 'result') {
        await call(`/ext/result/${msg.id}`, {image: msg.image, chatUrl: msg.chatUrl, error: msg.error, pause: msg.pause});
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
// - it is woken by a message (a hidden tab's own timers are slowed down), never by bringing Chrome to the front: the
//   owner's screen must not jump to the browser;
// - a job is waiting and the working tab does not poll for 45 s (and nothing is running): reload it; no tab at all:
//   open one in the background (if allowed in the settings);
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
    if (w && !w.discarded && (s.waiting || s.running)) chrome.tabs.sendMessage(w.id, {type: 'wake'}).catch(() => {});
    if (Date.now() - lastSeen < 15000) wokeAt = 0; // the tab answers: no reload pending
    if (s.paused || !s.waiting || s.running || Date.now() - lastSeen < 15000) return;
    if (!tabs.length) {
      if (s.settings?.autoOpenTab !== false) await chrome.tabs.create({url: 'https://chatgpt.com/', active: false});
      return;
    }
    if (!w) return; // no working tab chosen: never use another conversation on our own
    if (w.discarded) {
      await chrome.tabs.reload(w.id);
      wokeAt = Date.now();
      return;
    }
    if (!wokeAt) wokeAt = Date.now();
    else if (Date.now() - wokeAt > 45000) {
      await chrome.tabs.reload(w.id).catch(() => {});
      wokeAt = 0;
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
