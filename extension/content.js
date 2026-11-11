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
  stop: '[data-testid="stop-button"]',
  images: 'main img',
  userTurn: '[data-message-author-role="user"]',
  generatedAlt: /generated image|image g[ée]n[ée]r[ée]e/i,
  attachmentAlt: /user attachment|pi[eè]ce jointe|attachment/i,
  login: '[data-testid="login-button"], a[href*="/auth/login"], button[data-testid="welcome-login-button"]',
  // ChatGPT says the quota is used up: the queue must stop (each new try would burn more)
  quota: /(reached|hit) (your|the) .{0,30}limit|image generation limit|limit (for|on) (image|creating)|usage cap|limite (de|d.)[^.]{0,40}(atteinte|image)|atteint (la|votre) limite|plus d.images? (pour le moment|aujourd)|réessayez (plus tard|dans)|try again (later|in \d)|upgrade to (plus|pro)/i,
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
/** Set when the bridge no longer wants the running job (cancelled, timed out): every wait stops at once. */
let aborted = false;
class Stop extends Error {
  constructor(msg, pause) {
    super(msg);
    this.pause = pause;
  }
}
/** Something that must stop the queue: logged out, or the quota message. */
function blocker(answer = '') {
  if (/^\/auth\b/.test(location.pathname) || (document.querySelector(SEL.login) && !document.querySelector(SEL.composer))) return new Stop('ChatGPT déconnecté : reconnecte-toi dans l’onglet, puis relance le pont (popup : Reprendre).', 'logged out');
  // popups and banners on screen now, plus ChatGPT's answer to OUR message (never older messages of the chat)
  const zones = [...document.querySelectorAll('[role="dialog"], [role="alert"]')];
  const said = zones.map((z) => z.textContent || '').join(' ') + ' ' + answer;
  if (SEL.quota.test(said)) return new Stop(`quota ChatGPT atteint : ${said.match(SEL.quota)[0]}`, 'quota');
  return null;
}
/** Stop the answer ChatGPT is writing (used when the job is cancelled). */
function stopChatGPT() {
  const b = document.querySelector(SEL.stop);
  if (b) b.click(), say('stop clicked');
  return !!b;
}

/** What the page looks like when a step fails (to adapt the selectors). */
function probe() {
  const ce = [...document.querySelectorAll('[contenteditable="true"], textarea')].slice(0, 5).map((e) => `${e.tagName.toLowerCase()}#${e.id}.${String(e.className).split(' ').slice(0, 2).join('.')}`);
  const btn = [...document.querySelectorAll('button[data-testid]')].slice(0, 12).map((b) => b.dataset.testid);
  return `url=${location.pathname} title=${document.title.slice(0, 40)} visible=${document.visibilityState} editors=[${ce.join(' | ')}] buttons=[${btn.join(',')}] files=${document.querySelectorAll('input[type=file]').length}`;
}

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (aborted) throw new Stop('cancelled by the bridge');
    const v = fn();
    if (v) return v;
    await sleep(500);
  }
  const b = blocker();
  if (b) throw b;
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

/** A reference as a File, shrunk to `max` px on its longest side (PNG keeps the transparency). */
async function shrink(dataUrl, name, max = 1600) {
  const src = dataUrlToFile(dataUrl, name);
  const bmp = await createImageBitmap(src);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (k >= 1) return {file: src, w: bmp.width, h: bmp.height};
  const w = Math.round(bmp.width * k);
  const h = Math.round(bmp.height * k);
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const blob = await c.convertToBlob({type: 'image/png'});
  return {file: new File([blob], name.replace(/\.[a-z]+$/i, '.png'), {type: 'image/png'}), w, h};
}

/** Images that come after our last message in the page (ChatGPT echoes our references inside or near our turn). */
function afterLastUserTurn(imgs) {
  const turns = document.querySelectorAll(SEL.userTurn);
  const last = turns[turns.length - 1];
  if (!last) return imgs;
  // the references are shown in our turn; the answer's images come after it in the page
  return imgs.filter((i) => !last.contains(i) && last.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_FOLLOWING && !i.closest('[data-message-author-role="user"]'));
}

/** Same width/height ratio as one of our references (ChatGPT may show them resized). */
function refRatio(img, ratios) {
  const r = img.naturalWidth / img.naturalHeight;
  return ratios.some((x) => Math.abs(x - r) < 0.004);
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
  // The effort is a 3-step slider (Light · Medium · High) inside the model menu, moved with the arrow keys.
  const btn = () => document.querySelector(SEL.effort);
  if (!btn()) return 'none';
  if (btn().dataset.selectedReasoningEffort === level) return level;
  const slider = () => document.querySelector('[data-reasoning-slider="true"]');
  const value = () => Number(document.querySelector('[data-model-picker-power-slider] [role="slider"], [role="slider"][aria-valuemax]')?.getAttribute('aria-valuenow') ?? -1);
  const max = () => Number(document.querySelector('[role="slider"][aria-valuemax]')?.getAttribute('aria-valuemax') ?? 2);
  const o = {bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, isPrimary: true, pointerId: 1};
  // open the menu: several ways, one at a time (a second one would close it again)
  const openers = [
    () => btn().dispatchEvent(new PointerEvent('pointerdown', o)),
    () => btn().click(),
    () => (btn().focus(), btn().dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', code: 'ArrowDown', bubbles: true}))),
    () => (btn().focus(), btn().dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true}))),
  ];
  let opened = false;
  for (const open of openers) {
    open();
    if (await waitFor(slider, 1500, 'effort slider').catch(() => null)) {
      opened = true;
      break;
    }
  }
  if (!opened) {
    say('effort: model menu did not open');
    return btn().dataset.selectedReasoningEffort;
  }
  const target = level === 'high' ? max() : level === 'low' ? 0 : 1;
  for (let i = 0; i < 4 && value() !== target; i++) {
    const key = value() < target ? 'ArrowRight' : 'ArrowLeft';
    slider().focus();
    slider().dispatchEvent(new KeyboardEvent('keydown', {key, code: key, bubbles: true}));
    const thumb = document.querySelector('[role="slider"][aria-valuemax]');
    thumb?.dispatchEvent(new KeyboardEvent('keydown', {key, code: key, bubbles: true}));
    await sleep(250);
  }
  say('effort slider value', value(), '/', max());
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
  await sleep(400);
  if (slider()) document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', code: 'Escape', bubbles: true}));
  await sleep(300);
  return btn()?.dataset.selectedReasoningEffort ?? 'unknown';
}

async function run(job) {
  const progress = (step) => send({type: 'progress', id: job.id, step});
  // 1. right conversation: a given one (chat), a fresh one (new), or the one open in this tab (here)
  const here = location.href.split('?')[0];
  const target = job.mode === 'chat' ? job.chatUrl : job.mode === 'new' ? 'https://chatgpt.com/' : null;
  const there = target && (job.mode === 'new' ? /\/c\//.test(here) : here !== target);
  if (!job.navigated && there) {
    sessionStorage.setItem(JOB_KEY, job.id); // only the id: the job comes back from the bridge after the reload
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
      const all0 = [...document.querySelectorAll(SEL.images)].filter((i) => i.complete && i.naturalWidth >= 512 && !SEL.attachmentAlt.test(i.alt || ''));
      const lab = all0.filter((i) => SEL.generatedAlt.test(i.alt || ''));
      const all = lab.length ? lab : afterLastUserTurn(all0);
      return all[all.length - (job.back || 1)];
    }, 30000, 'an image in this conversation');
    const blob = await (await fetch(img.src, {credentials: 'include'})).blob();
    return {image: await blobToDataUrl(blob), chatUrl: location.href.split('?')[0]};
  }
  const box = await waitFor(() => document.querySelector(SEL.composer), 60000, 'composer');
  const b0 = blocker();
  if (b0) throw b0;
  const refNames = new Set((job.refs ?? []).map((r) => r.name));
  const refRatios = [];
  const refSizes = new Set();
  const composerImgs = () => (box.closest('form') ?? document).querySelectorAll('img').length;

  // 2. references: shrunk to 1600 px max (big files fail to upload), attached, then we wait until they show
  async function attach() {
    if (!job.refs?.length) return;
    await progress('upload');
    const input = await waitFor(() => document.querySelector(SEL.fileInput), 20000, 'file input');
    const n0 = composerImgs();
    const dt = new DataTransfer();
    for (const [i, r] of job.refs.entries()) {
      const f = await shrink(r.data, r.name || `ref-${i + 1}.png`);
      refSizes.add(`${f.w}x${f.h}`);
      refRatios.push(f.w / f.h);
      dt.items.add(f.file);
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    let ok = await waitFor(() => composerImgs() - n0 >= job.refs.length, 90000, 'reference thumbnails').catch(() => false);
    if (!ok) {
      // never send a prompt without its references: one more try, then the job fails (the agent retries it)
      say('only', composerImgs() - n0, 'of', job.refs.length, 'references visible; attaching again');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', {bubbles: true}));
      ok = await waitFor(() => composerImgs() - n0 >= job.refs.length, 60000, 'reference thumbnails').catch(() => false);
      if (!ok) throw new Error(`references not attached (${composerImgs() - n0}/${job.refs.length} visible): prompt NOT sent`);
    }
    await sleep(1500);
  }

  // 3. type a message and send it (the send button appears with the text and stays disabled while uploading)
  async function typeAndSend(text, withRefs = true) {
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(box, text);
      box.dispatchEvent(new Event('input', {bubbles: true}));
    } else document.execCommand('insertText', false, text);
    await sleep(800);
    const effort = await ensureEffort(job.effort || 'high');
    say('thinking effort:', effort);
    await progress(`effort ${effort}`);
    await progress('waiting uploads');
    const sendBtn = await waitFor(() => {
      const b = document.querySelector(SEL.send);
      return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b;
    }, 180000, 'send button');
    if (aborted) throw new Stop('cancelled by the bridge');
    before = new Set([...document.querySelectorAll(SEL.images)].map((i) => i.src));
    const turns0 = document.querySelectorAll(SEL.userTurn).length;
    sendBtn.click();
    sentAt = Date.now();
    started = false;
    sends++;
    await send({type: 'progress', id: job.id, step: `generating (message ${sends})`, sent: true});
    // the message really left with its references: our new turn shows them, else stop ChatGPT and fail
    if (withRefs && job.refs?.length) {
      const turn = await waitFor(() => {
        const t = document.querySelectorAll(SEL.userTurn);
        return t.length > turns0 && t[t.length - 1];
      }, 30000, 'our message in the conversation').catch(() => null);
      const n = turn ? turn.querySelectorAll('img').length : -1;
      if (turn && n < job.refs.length) {
        stopChatGPT();
        throw new Error(`message sent with ${n}/${job.refs.length} references: ChatGPT stopped, job failed (nothing to retry by hand)`);
      }
      if (!turn) say('could not find our message to count its references');
    }
  }

  let before = new Set();
  let sends = 0;
  let sentAt = 0;
  let started = false;
  await attach();
  await typeAndSend(job.prompt);

  // ask mode: a text question about the attached images (a review). Wait for the written answer to finish, return it.
  if (job.ask) {
    await progress('waiting for the answer');
    const answer = () => {
      const a = document.querySelectorAll('[data-message-author-role="assistant"]');
      const u = document.querySelectorAll(SEL.userTurn);
      const ans = a[a.length - 1];
      const mine = u[u.length - 1];
      if (!ans || (mine && !(mine.compareDocumentPosition(ans) & Node.DOCUMENT_POSITION_FOLLOWING))) return '';
      return (ans.innerText ?? ans.textContent ?? '').trim();
    };
    let prev = '';
    let same = 0;
    const until = Date.now() + 15 * 60000; // thinking models can reason for many minutes before writing
    while (Date.now() < until) {
      await sleep(2000);
      if (aborted) {
        stopChatGPT();
        throw new Stop('cancelled by the bridge');
      }
      const txt = answer();
      const busyAns = !!document.querySelector(SEL.stop);
      if (txt.length !== prev.length) await progress(`answer ${txt.length} chars${busyAns ? ' (writing)' : ''}`);
      if (txt && txt === prev && !busyAns) {
        if (++same >= 3) {
          const bl = blocker(txt);
          if (bl) throw bl;
          return {image: 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(txt))), chatUrl: location.href.split('?')[0]};
        }
      } else same = 0;
      prev = txt;
    }
    throw new Error('timeout: no written answer');
  }

  // 4. wait for the image; if ChatGPT answers with text instead (asks for the references, a question, a failure),
  // answer it and try again (2 times at most), so a job never stays blocked
  let src = null;
  let stable = 0;
  let retries = 0;
  let quietSince = 0;
  // ChatGPT's answer to OUR last message only (an older answer of the conversation must never be read as one)
  const lastAnswer = () => {
    const a = document.querySelectorAll('[data-message-author-role="assistant"]');
    const u = document.querySelectorAll(SEL.userTurn);
    const ans = a[a.length - 1];
    const mine = u[u.length - 1];
    if (!ans || (mine && !(mine.compareDocumentPosition(ans) & Node.DOCUMENT_POSITION_FOLLOWING))) return '';
    return (ans.textContent ?? '').trim();
  };
  const end = Date.now() + 10 * 60000;
  while (Date.now() < end) {
    await sleep(3000);
    if (aborted) {
      stopChatGPT();
      throw new Stop('cancelled by the bridge');
    }
    const busyGen = !!document.querySelector(SEL.stop);
    if (busyGen) started = true;
    if (!started && Date.now() - sentAt < 45000) continue;
    // ChatGPT labels its images: alt "Generated image N" for results, "User attachment" for our references
    const fresh = [...document.querySelectorAll(SEL.images)].filter((i) => !before.has(i.src) && i.complete && i.naturalWidth >= 512 && !SEL.attachmentAlt.test(i.alt || '') && !refNames.has(i.alt));
    const labelled = fresh.filter((i) => SEL.generatedAlt.test(i.alt || ''));
    const imgs = labelled.length ? labelled : afterLastUserTurn(fresh).filter((i) => !refSizes.has(`${i.naturalWidth}x${i.naturalHeight}`));
    const cand = imgs.length ? imgs[imgs.length - 1].src : null;
    if (cand && cand === src && !busyGen) {
      if (++stable >= 3) break;
      continue;
    }
    stable = 0;
    src = cand;
    if (cand || busyGen) {
      quietSince = 0;
      continue;
    }
    // no image yet and no stop button: image generation keeps going after the text answer ends (placeholder,
    // "Creating image…"), so only act on a real text reply: a question, a request for files, or a failure
    const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
    const lastTurn = turns[turns.length - 1];
    const inImage = !!lastTurn && (lastTurn.querySelector('img, canvas, [aria-busy="true"]') || /creating image|création de l.image|génération de l.image|generating image/i.test(lastTurn.textContent));
    if (inImage) {
      quietSince = 0;
      continue;
    }
    quietSince ||= Date.now();
    if (Date.now() - quietSince < 45000) continue;
    const said = lastAnswer();
    const bl = blocker(said);
    if (bl) throw bl;
    // Only ONE automatic retry, and only when ChatGPT clearly did not make an image: it asks for the references, or
    // it reports a failure with a retry button. A question or anything else fails the job: a blind re-send can make a
    // second image (and burn quota) when the first one is only slow to show.
    const askRefs = /joindre|joins|attach|upload|images? (de )?r[ée]f[ée]rence|reference images?/i.test(said);
    const retry = [...document.querySelectorAll('button')].find((b) => /^(try again|réessayer|regenerate|régénérer)$/i.test(b.textContent.trim()));
    const failed = retry && /fail|échou|error|erreur|went wrong|problème/i.test(said);
    if (retries >= 1 || !(askRefs || failed)) throw new Error(`ChatGPT answered without an image: ${said.slice(0, 300)}`);
    retries++;
    say('no image, answer was:', said.slice(0, 200));
    if (askRefs) {
      await progress('retry: references again');
      await attach();
      await typeAndSend('Voici les images de référence en pièces jointes. Génère l’image maintenant, avec les consignes précédentes, sans poser de question.');
    } else {
      await progress('retry: try again');
      retry.click();
      sends++;
      await send({type: 'progress', id: job.id, step: 'generating (retry)', sent: true});
      sentAt = Date.now();
      started = false;
    }
    quietSince = 0;
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
      const r = await send({type: 'getjob', id: saved});
      job = r.ok ? r.job : null;
    } else {
      const r = await send({type: 'poll'});
      if (!r.ok) say('poll failed:', r.error);
      job = r.ok ? r.job : null;
      if (job) say('job', job.id);
    }
    if (!job) return;
    aborted = false;
    // every 5 s: is the job still wanted? (cancelled or timed out on the bridge = stop at once, no new message)
    const watch = setInterval(async () => {
      const r = await send({type: 'alive', id: job.id});
      if (r.ok && r.alive === false && !aborted) {
        aborted = true;
        say('job no longer wanted by the bridge: stopping');
        stopChatGPT();
      }
    }, 5000);
    try {
      const out = await run(job);
      if (out === 'navigating') return;
      await send({type: 'result', id: job.id, ...out});
    } catch (e) {
      await send({type: 'result', id: job.id, error: String(e.message || e), pause: e.pause});
    } finally {
      clearInterval(watch);
    }
  } finally {
    busy = false;
  }
}

say('content script ready on', location.pathname);
// the background wakes the working tab (a hidden tab's own timers are slowed down by the browser)
const onWake = (m) => m?.type === 'wake' && tick();
chrome.runtime.onMessage.addListener(onWake);
const timer = setInterval(() => {
  // the extension was reloaded: this copy is dead, stop quietly (the new copy takes over)
  if (!chrome.runtime?.id) return window.__akiBridgeStop?.();
  tick();
}, 3000);
window.__akiBridgeStop = () => {
  clearInterval(timer);
  try {
    chrome.runtime.onMessage.removeListener(onWake);
  } catch {}
};
tick();
})();
