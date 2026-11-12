#!/usr/bin/env node
/**
 * Local bridge between scripts (submit.mjs, Claude Code…) and the browser extension, which does the work in an open
 * ChatGPT tab. In-memory queue, one job at a time, 127.0.0.1 only. Topic → conversation URLs are kept in
 * ~/.aki-chatgpt/chats.json (same topic = same ChatGPT conversation).
 *   node bridge/server.mjs [--port 3777]
 */
import {createServer} from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 3777));
const DIR = path.join(os.homedir(), '.aki-chatgpt');
const CHATS = path.join(DIR, 'chats.json');
fs.mkdirSync(DIR, {recursive: true});
const chats = fs.existsSync(CHATS) ? JSON.parse(fs.readFileSync(CHATS, 'utf8')) : {};
const saveChats = () => fs.writeFileSync(CHATS, JSON.stringify(chats, null, 1));

/** id → {id, prompt, refs, topic, status: waiting|running|done|error, step, image, chatUrl, error, at} */
const jobs = new Map();
let seq = 0;
const control = {reload: false};
/** Pause: no job is handed to the tab (set when ChatGPT says the quota is reached or the account is logged out). */
const PAUSE = path.join(DIR, 'pause.json');
let paused = fs.existsSync(PAUSE) ? JSON.parse(fs.readFileSync(PAUSE, 'utf8')) : null;
const setPause = (p) => {
  paused = p;
  if (p) fs.writeFileSync(PAUSE, JSON.stringify(p));
  else fs.rmSync(PAUSE, {force: true});
  log('pause', p ? p.reason : 'off');
};
let lastPoll = 0;
/** ChatGPT tabs seen by the extension, and the one chosen to do the work (null = not chosen yet). */
let tabs = [];
const WORKER = path.join(DIR, 'worker.json');
let worker = fs.existsSync(WORKER) ? JSON.parse(fs.readFileSync(WORKER, 'utf8')).tab ?? null : null;
const RUN_TIMEOUT = 10 * 60000;
const IMAGES = path.join(DIR, 'images');
fs.mkdirSync(IMAGES, {recursive: true});
const HISTORY = path.join(DIR, 'history.json');
/** Last 50 finished jobs (no image data: the image is a file in ~/.aki-chatgpt/images). */
const history = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, 'utf8')) : [];
const SETTINGS = path.join(DIR, 'settings.json');
const settings = {effort: 'high', autoOpenTab: true, newChat: false, ...(fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {})};
function remember(j) {
  const h = {id: j.id, sends: j.sends || 0, topic: j.topic, kind: j.ask ? 'ask' : j.grab ? 'grab' : j.capture ? 'capture' : 'image', status: j.status, error: j.error, chatUrl: j.chatUrl, prompt: (j.prompt || '').slice(0, 140), refs: (j.refs || []).length, created: j.created, ended: Date.now(), image: j.file ? path.basename(j.file) : null};
  history.unshift(h);
  history.splice(50);
  fs.writeFileSync(HISTORY, JSON.stringify(history, null, 1));
}
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function send(res, code, body) {
  res.writeHead(code, {'content-type': 'application/json'});
  res.end(JSON.stringify(body));
}
function body(req) {
  return new Promise((ok, ko) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > 80 * 1024 * 1024) ko(new Error('too large'));
      else parts.push(c);
    });
    req.on('end', () => {
      try {
        ok(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {});
      } catch (e) {
        ko(e);
      }
    });
  });
}
const running = () => [...jobs.values()].find((j) => j.status === 'running');
const waiting = () => [...jobs.values()].filter((j) => j.status === 'waiting');

setInterval(() => {
  const r = running();
  if (r && Date.now() - r.at > RUN_TIMEOUT) Object.assign(r, {status: 'error', error: 'timeout: no news from the ChatGPT tab for 10 min'}), remember(r);
  // drop finished jobs after an hour
  for (const j of jobs.values()) if (['done', 'error'].includes(j.status) && Date.now() - j.at > 3600000) jobs.delete(j.id);
}, 5000);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/jobs') {
      const b = await body(req);
      if (!b.prompt && !b.grab && !b.capture) return send(res, 400, {error: 'prompt required'});
      if (paused) return send(res, 409, {error: `bridge paused: ${paused.reason}`, paused});
      // the same request already queued or running (a retried script): reuse it, never generate twice
      const sig = JSON.stringify([b.prompt ?? '', b.topic ?? null, b.chat ?? null, (b.refs ?? []).map((r) => (r.data ?? '').length), !!b.grab, Number(b.back) || 1, !!b.ask]);
      const same = [...jobs.values()].find((j) => j.sig === sig && ['waiting', 'running'].includes(j.status));
      if (same) {
        log('duplicate request, reusing', same.id);
        return send(res, 200, {id: same.id, duplicate: true});
      }
      const id = `j${Date.now().toString(36)}${(++seq).toString(36)}`;
      jobs.set(id, {id, prompt: b.prompt, refs: b.refs ?? [], topic: b.topic ?? null, chat: b.chat ?? null, mode: b.mode ?? 'here', grab: !!b.grab, back: Number(b.back) || 1, capture: !!b.capture, ask: !!b.ask, sig, sends: 0, status: 'waiting', step: '', at: Date.now(), created: Date.now()});
      log('job', id, b.topic ? `topic=${b.topic}` : '(new chat)', `${(b.refs ?? []).length} refs`);
      return send(res, 200, {id});
    }
    const m = /^\/jobs\/(j[a-z0-9]+)$/.exec(p);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      if (!j) return send(res, 404, {error: 'unknown job'});
      return send(res, 200, {status: j.status, step: j.step, error: j.error, chatUrl: j.chatUrl, image: j.status === 'done' ? j.image : undefined, extensionSeen: Date.now() - lastPoll < 20000});
    }
    if (req.method === 'DELETE' && m) {
      const j = jobs.get(m[1]);
      if (j && ['waiting', 'running'].includes(j.status)) Object.assign(j, {status: 'error', error: 'cancelled', at: Date.now()}), remember(j);
      return send(res, 200, {ok: true});
    }
    if (p === '/ext/status') {
      const r = running();
      return send(res, 200, {
        waiting: waiting().length,
        queue: waiting().map((j) => ({id: j.id, topic: j.topic, prompt: (j.prompt || '').slice(0, 80)})),
        running: r ? {id: r.id, step: r.step, topic: r.topic, since: r.at, prompt: (r.prompt || '').slice(0, 80)} : null,
        extensionSeen: Date.now() - lastPoll < 20000,
        paused,
        worker,
        tabs,
        settings,
      });
    }
    // remote control of the extension (agents can update and reload it without touching the browser)
    if (req.method === 'POST' && p === '/ext/control') {
      const b = await body(req);
      if (b.reload) control.reload = true;
      log('control', JSON.stringify(b));
      return send(res, 200, {ok: true});
    }
    if (p === '/ext/control') {
      const c = {...control};
      control.reload = false;
      return send(res, 200, c);
    }
    if (req.method === 'POST' && p === '/resume') {
      setPause(null);
      return send(res, 200, {ok: true});
    }
    // the tab asks, while it works, whether its job is still wanted (cancelled / timed out: it stops ChatGPT at once)
    const al = /^\/ext\/alive\/(j[a-z0-9]+)$/.exec(p);
    if (al) {
      lastPoll = Date.now(); // a working tab asks every 5 s: it is alive (only /ext/next counted before, so a long job read as "extension unseen")
      const j = jobs.get(al[1]);
      return send(res, 200, {alive: !!j && j.status === 'running'});
    }
    if (p === '/history') return send(res, 200, {history, topics: chats, settings});
    const im = /^\/images\/(j[a-z0-9]+\.(png|jpg|webp))$/.exec(p);
    if (im && fs.existsSync(path.join(IMAGES, im[1]))) {
      res.writeHead(200, {'content-type': im[2] === 'jpg' ? 'image/jpeg' : `image/${im[2]}`});
      return res.end(fs.readFileSync(path.join(IMAGES, im[1])));
    }
    if (req.method === 'POST' && p === '/settings') {
      Object.assign(settings, await body(req));
      fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 1));
      return send(res, 200, settings);
    }
    if (req.method === 'POST' && p === '/topics/forget') {
      const b = await body(req);
      delete chats[b.topic];
      saveChats();
      return send(res, 200, chats);
    }
    if (req.method === 'POST' && p === '/history/clear') {
      history.splice(0);
      fs.writeFileSync(HISTORY, '[]');
      return send(res, 200, {ok: true});
    }
    if (req.method === 'POST' && p === '/worker') {
      const b = await body(req);
      worker = b.tab == null ? null : Number(b.tab);
      fs.writeFileSync(WORKER, JSON.stringify({tab: worker}));
      log('worker tab', worker);
      return send(res, 200, {worker});
    }
    if (req.method === 'POST' && p === '/ext/next') {
      const nb = await body(req);
      lastPoll = Date.now();
      if (Array.isArray(nb.tabs)) tabs = nb.tabs;
      if (worker != null && !tabs.some((t) => t.id === worker)) worker = null; // the chosen tab was closed
      // only the chosen tab works (never someone's other conversation)
      if (worker == null || nb.tab !== worker || paused) return send(res, 200, {job: null});
      const r = running();
      // the working tab asks for a new job while one runs: its page was reloaded (by ChatGPT or by hand) and the
      // script that ran the job is gone. Nothing sent yet: hand it out again once. Sent: never resend, fail it.
      if (r && Date.now() - r.at > 5000) {
        if (!r.sends && !r.requeued) {
          Object.assign(r, {status: 'waiting', step: 'requeued (tab reloaded)', requeued: true});
          log(r.id, 'tab reloaded before sending: requeued');
        } else {
          Object.assign(r, {status: 'error', at: Date.now(), error: r.sends ? 'tab reloaded while ChatGPT was generating: the image may be in the conversation, fetch it with --grab, do not resubmit blindly' : 'tab reloaded twice before sending'});
          remember(r);
          log(r.id, 'error', r.error);
        }
      }
      if (running()) return send(res, 200, {job: null});
      const j = waiting()[0];
      if (!j) return send(res, 200, {job: null});
      Object.assign(j, {status: 'running', at: Date.now(), step: 'start'});
      log('start', j.id);
      // where: an explicit conversation, the topic's conversation, a new one, or the tab's current one (default)
      const chatUrl = j.chat || (j.topic && chats[j.topic]) || null;
      j.payload = {id: j.id, prompt: j.prompt, refs: j.refs, grab: j.grab, back: j.back, capture: j.capture, ask: j.ask, effort: settings.effort, chatUrl, mode: chatUrl ? 'chat' : j.topic || settings.newChat ? 'new' : j.mode};
      return send(res, 200, {job: j.payload});
    }
    // the tab reloads while opening a conversation: it asks again for its running job (too big for sessionStorage)
    const gj = /^\/ext\/job\/(j[a-z0-9]+)$/.exec(p);
    if (gj) {
      const j = jobs.get(gj[1]);
      return send(res, 200, {job: j && j.status === 'running' ? {...j.payload, navigated: true} : null});
    }
    const pr = /^\/ext\/progress\/(j[a-z0-9]+)$/.exec(p);
    if (req.method === 'POST' && pr) {
      const b = await body(req);
      const j = jobs.get(pr[1]);
      if (j) (j.step = b.step), (j.at = Date.now()), log(j.id, b.step); // any news from the tab keeps the job alive
      if (j && b.sent) j.sends = (j.sends || 0) + 1; // one more message sent to ChatGPT (each one can make an image)
      return send(res, 200, {ok: true});
    }
    const rr = /^\/ext\/result\/(j[a-z0-9]+)$/.exec(p);
    if (req.method === 'POST' && rr) {
      const b = await body(req);
      const j = jobs.get(rr[1]);
      if (!j) return send(res, 404, {error: 'unknown job'});
      if (b.pause) setPause({reason: b.pause, at: Date.now(), detail: String(b.error || '').slice(0, 300)});
      if (j.status !== 'running') {
        // cancelled or timed out meanwhile: keep that status, only log what the tab did
        // an image that arrives late was still paid with quota: keep the file so it is not lost
        if (b.image && String(b.image).startsWith('data:image/')) fs.writeFileSync(path.join(IMAGES, `${j.id}-late.png`), Buffer.from(String(b.image).split(',')[1] ?? '', 'base64'));
        log(j.id, 'late result ignored', b.error ?? 'image kept as late');
        return send(res, 200, {ok: true});
      }
      if (b.error) Object.assign(j, {status: 'error', error: b.error, at: Date.now()});
      else {
        Object.assign(j, {status: 'done', image: b.image, chatUrl: b.chatUrl, at: Date.now()});
        const [head, b64] = String(b.image).split(',');
        const ext = /image\/(png|jpeg|webp)/.exec(head)?.[1]?.replace('jpeg', 'jpg') ?? (head.includes('html') ? 'html' : head.includes('text/plain') ? 'txt' : 'bin');
        j.file = path.join(IMAGES, `${j.id}.${ext}`);
        fs.writeFileSync(j.file, Buffer.from(b64 ?? '', 'base64'));
        if (j.topic && b.chatUrl && /\/c\//.test(b.chatUrl)) (chats[j.topic] = b.chatUrl), saveChats();
      }
      remember(j);
      log(j.id, j.status, j.error ?? '');
      return send(res, 200, {ok: true});
    }
    send(res, 404, {error: 'not found'});
  } catch (e) {
    send(res, 500, {error: String(e)});
  }
}).listen(PORT, '127.0.0.1', () => log(`bridge on http://127.0.0.1:${PORT}`));
