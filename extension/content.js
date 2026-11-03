// Runs in the ChatGPT tab. Asks the bridge (through the background) for a job, then: opens the job's conversation
// (same topic = same chat), attaches the reference images, types the prompt, sends, waits for the generated image and
// sends it back. One job at a time. Selectors live at the top: adapt them when ChatGPT changes its interface.
// one live copy per tab (the extension can re-inject it after a reload)
(() => {
if (window.__akiBridgeStop) window.__akiBridgeStop();
const SEL = {
  composer: '#prompt-textarea, div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea[name="prompt-textarea"], form textarea',
  fileInput: 'input[type="file"]',
  send: '[data-testid="send-button"], button[type="submit"][aria-label="Send"], button[aria-label="Envoyer"], form button[type="submit"]',
  effort: 'button[data-composer-navigation-target="reasoning"]',
  menuItem: '[role^="menuitem"], [role="option"], [data-radix-collection-item]',
  stop: '[data-testid="stop-button"]',
  images: 'main img',
  userTurn: '[data-message-author-role="user"]',
};
const JOB_KEY = 'aki-bridge-job';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.info('[aki-bridge]', ...a);
const send = (msg) =>
  new Promise((r) => {
    try {
      chrome.runtime.sendMessage(msg, (x) => {
        const err = chrome.runtime.lastError;
        if (err) say('message error:', err.message);
        r(x ?? {ok: false, error: err?.message});
      });
    } catch (e) {
      say('extension unreachable (reload this tab):', String(e));
      r({ok: false, error: String(e)});
    }
  });
let busy = false;

/** What the page looks like when a step fails (to adapt the selectors). */
function probe() {
  const ce = [...document.querySelectorAll('[contenteditable="true"], textarea')].slice(0, 5).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).split(' ').slice(0, 2).join('.')}`);
  const btn = [...document.querySelectorAll('button[data-testid]')].slice(0, 12).map((b) => b.dataset.testid);
  return `url=${location.pathname} title=${document.title.slice(0, 40)} visible=${document.visibilityState} editors=[${ce.join(' | ')}] buttons=[${btn.join(',')}] files=${document.querySelectorAll('input[type=file]').length}`;
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout: ${what} — ${probe()}`);
}

function dataUrlToFile(d, name) {
  const [head, b64] = d.split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], name, {type: mime});
}

async function blobToDataUrl(b) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(b);
  });
}

/** Radix menus open on pointer events, not on a plain click. */
function press(el) {
  const o = {bubbles: true, cancelable: true, pointerType: 'mouse', button: 0};
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
}

/** Thinking effort of the composer (owner rule: always "high"). Returns the effort finally selected. */
async function ensureEffort(level) {
  const btn = () => document.querySelector(SEL.effort);
  if (!btn()) return 'none';
  if (btn().dataset.selectedReasoningEffort === level) return level;
  const want = level === 'high' ? /^\s*(high|élevé|haut)/i : new RegExp('^\\s*' + level, 'i');
  const find = () => [...document.querySelectorAll(SEL.menuItem)].find((m) => want.test(m.textContent));
  // open the menu: pointer events first, then the keyboard (Radix accepts both)
  press(btn());
  let item = await waitFor(find, 2500, 'effort menu').catch(() => null);
  if (!item) {
    btn().focus();
    btn().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
    item = await waitFor(find, 2500, 'effort menu').catch(() => null);
  }
  if (!item) {
    const seen = [...document.querySelectorAll(SEL.menuItem)].map((m) => m.textContent.trim().slice(0, 24));
    say('effort menu: "' + level + '" not found; items seen:', seen.join(' | ') || '(no menu opened)');
  } else {
    press(item);
    item.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}));
  }
  await sleep(600);
  if (document.querySelector('[role="menu"]')) document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
  return btn()?.dataset.selectedReasoningEffort ?? 'unknown';
}

async function run(job) {
  const progress = (step) => send({type: 'progress', id: job.id, step});
  // 1. right conversation: a given one (chat), a fresh one (new), or the one open in this tab (here)
  const here = location.href.split('?')[0];
  const target = job.mode === 'chat' ? job.chatUrl : job.mode === 'new' ? 'https://chatgpt.com/' : null;
  const there = target && (job.mode === 'new' ? /\/c\//.test(here) : here !== target);
  if (!job.navigated && there) {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({...job, navigated: true}));
    location.href = target;
    return 'navigating';
  }
  // capture: wait for the owner to open a menu by hand, then send its HTML back (to learn the selectors)
  if (job.capture) {
    await progress('capture: open the menu now');
    const q = '[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],[data-side]';
    const el = await waitFor(() => document.querySelector(q), 60000, 'a menu opened by hand');
    await sleep(400);
    const html = [...document.querySelectorAll(q)].map((e) => e.outerHTML).join('\n\n');
    return {image: 'data:text/html;base64,' + btoa(unescape(encodeURIComponent(html))), chatUrl: location.href.split('?')[0], el: !!el};
  }
  // grab: no generation, just bring back the last generated image of this conversation
  if (job.grab) {
    await progress('grab');
    const img = await waitFor(() => {
      const all = [...document.querySelectorAll(SEL.images)].filter((i) => i.complete && i.naturalWidth >= 600 && !i.closest(SEL.userTurn));
      return all[all.length - 1];
    }, 30000, 'an image in this conversation');
    const blob = await (await fetch(img.src, {credentials: 'include'})).blob();
    return {image: await blobToDataUrl(blob), chatUrl: location.href.split('?')[0]};
  }
  const box = await waitFor(() => document.querySelector(SEL.composer), 60000, 'composer');
  // 2. reference images
  if (job.refs?.length) {
    await progress('upload');
    const input = await waitFor(() => document.querySelector(SEL.fileInput), 20000, 'file input');
    const dt = new DataTransfer();
    job.refs.forEach((r, i) => dt.items.add(dataUrlToFile(r.data, r.name || `ref-${i + 1}.png`)));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await sleep(1500);
  }
  // 3. prompt (the send button only appears once there is text), then wait for the uploads to finish
  box.focus();
  if (box.tagName === 'TEXTAREA') {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(box, job.prompt);
    box.dispatchEvent(new Event('input', {bubbles: true}));
  } else document.execCommand('insertText', false, job.prompt);
  await sleep(800);
  const effort = await ensureEffort('high');
  say('thinking effort:', effort);
  await progress(`effort ${effort}`);
  await progress('waiting uploads');
  const sendBtn = await waitFor(() => {
    const b = document.querySelector(SEL.send);
    return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b;
  }, 180000, 'send button');
  const before = new Set([...document.querySelectorAll(SEL.images)].map((i) => i.src));
  const refSizes = new Set(
    await Promise.all(
      (job.refs ?? []).map(
        (r) =>
          new Promise((ok) => {
            const im = new Image();
            im.onload = () => ok(`${im.naturalWidth}x${im.naturalHeight}`);
            im.onerror = () => ok('');
            im.src = r.data;
          }),
      ),
    ),
  );
  sendBtn.click();
  const sentAt = Date.now();
  let started = false;
  await progress('generating');
  const refNames = new Set((job.refs ?? []).map((r) => r.name));
  // 4. the new image: large, loaded, unchanged for a few checks, generation finished
  let src = null;
  let stable = 0;
  const end = Date.now() + 8 * 60000;
  while (Date.now() < end) {
    await sleep(3000);
    // new, large, loaded images that are not one of our references in the user turn
    // the answer must have started (stop button seen) and an image must be new, large, loaded, and not one of our
    // references echoed in the conversation (same pixel size or inside the user turn)
    if (document.querySelector(SEL.stop)) started = true;
    if (!started && Date.now() - sentAt < 45000) continue;
    const imgs = [...document.querySelectorAll(SEL.images)].filter(
      (i) => !before.has(i.src) && i.complete && i.naturalWidth >= 600 && !i.closest(SEL.userTurn) && !refNames.has(i.alt) && !refSizes.has(`${i.naturalWidth}x${i.naturalHeight}`),
    );
    const cand = imgs.length ? imgs[imgs.length - 1].src : null;
    const busyGen = !!document.querySelector(SEL.stop);
    if (cand && cand === src && !busyGen) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      src = cand;
    }
  }
  if (!src) {
    const all = [...document.querySelectorAll('main img')].slice(-6).map((i) => `${i.naturalWidth}x${i.naturalHeight} alt=${(i.alt || '').slice(0, 20)} user=${!!i.closest(SEL.userTurn)} src=${i.src.slice(0, 60)}`);
    throw new Error(`timeout: no generated image — last images: ${all.join(' | ')}`);
  }
  await progress('download');
  const blob = await (await fetch(src, {credentials: 'include'})).blob();
  return {image: await blobToDataUrl(blob), chatUrl: location.href.split('?')[0]};
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    let job = null;
    const saved = sessionStorage.getItem(JOB_KEY);
    if (saved) {
      sessionStorage.removeItem(JOB_KEY);
      job = JSON.parse(saved);
    } else {
      const r = await send({type: 'poll'});
      if (!r.ok) say('poll failed:', r.error);
      job = r.ok ? r.job : null;
      if (job) say('job', job.id);
    }
    if (!job) return;
    try {
      const out = await run(job);
      if (out === 'navigating') return;
      await send({type: 'result', id: job.id, ...out});
    } catch (e) {
      await send({type: 'result', id: job.id, error: String(e.message || e)});
    }
  } finally {
    busy = false;
  }
}

say('content script ready on', location.pathname);
const timer = setInterval(() => {
  // the extension was reloaded: this copy is dead, stop quietly (the new copy takes over)
  if (!chrome.runtime?.id) return window.__akiBridgeStop?.();
  tick();
}, 3000);
window.__akiBridgeStop = () => clearInterval(timer);
tick();
})();
