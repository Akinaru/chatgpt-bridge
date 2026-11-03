// Runs in the ChatGPT tab. Asks the bridge (through the background) for a job, then: opens the job's conversation
// (same topic = same chat), attaches the reference images, types the prompt, sends, waits for the generated image and
// sends it back. One job at a time. Selectors live at the top: adapt them when ChatGPT changes its interface.
const SEL = {
  composer: '#prompt-textarea',
  fileInput: 'input[type="file"]',
  send: '[data-testid="send-button"]',
  stop: '[data-testid="stop-button"]',
  images: 'main img',
};
const JOB_KEY = 'aki-bridge-job';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (x) => r(x ?? {ok: false})));
let busy = false;

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timeout: ${what}`);
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

async function run(job) {
  const progress = (step) => send({type: 'progress', id: job.id, step});
  // 1. right conversation: the topic's chat, or a fresh one
  const target = job.chatUrl || 'https://chatgpt.com/';
  const here = location.href.split('?')[0];
  if (!job.navigated && (job.chatUrl ? here !== job.chatUrl : /\/c\//.test(here))) {
    sessionStorage.setItem(JOB_KEY, JSON.stringify({...job, navigated: true}));
    location.href = target;
    return 'navigating';
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
    await sleep(3000);
    await waitFor(() => {
      const b = document.querySelector(SEL.send);
      return b && !b.disabled;
    }, 180000, 'uploads');
  }
  // 3. prompt
  const before = new Set([...document.querySelectorAll(SEL.images)].map((i) => i.src));
  box.focus();
  document.execCommand('insertText', false, job.prompt);
  await sleep(600);
  const sendBtn = await waitFor(() => {
    const b = document.querySelector(SEL.send);
    return b && !b.disabled && b;
  }, 20000, 'send button');
  sendBtn.click();
  await progress('generating');
  // 4. the new image: large, loaded, unchanged for a few checks, generation finished
  let src = null;
  let stable = 0;
  const end = Date.now() + 8 * 60000;
  while (Date.now() < end) {
    await sleep(3000);
    const imgs = [...document.querySelectorAll(SEL.images)].filter((i) => !before.has(i.src) && i.complete && i.naturalWidth >= 600);
    const cand = imgs.length ? imgs[imgs.length - 1].src : null;
    const busyGen = !!document.querySelector(SEL.stop);
    if (cand && cand === src && !busyGen) {
      if (++stable >= 3) break;
    } else {
      stable = 0;
      src = cand;
    }
  }
  if (!src) throw new Error('timeout: no generated image');
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
      job = r.ok ? r.job : null;
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

setInterval(tick, 3000);
tick();
