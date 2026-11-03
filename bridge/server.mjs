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
let lastPoll = 0;
/** ChatGPT tabs seen by the extension, and the one chosen to do the work (null = not chosen yet). */
let tabs = [];
const WORKER = path.join(DIR, 'worker.json');
let worker = fs.existsSync(WORKER) ? JSON.parse(fs.readFileSync(WORKER, 'utf8')).tab ?? null : null;
const RUN_TIMEOUT = 10 * 60000;
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
  if (r && Date.now() - r.at > RUN_TIMEOUT) Object.assign(r, {status: 'error', error: 'timeout: no answer from the ChatGPT tab in 10 min'});
  // drop finished jobs after an hour
  for (const j of jobs.values()) if (['done', 'error'].includes(j.status) && Date.now() - j.at > 3600000) jobs.delete(j.id);
}, 5000);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/jobs') {
      const b = await body(req);
      if (!b.prompt && !b.grab) return send(res, 400, {error: 'prompt required'});
      const id = `j${++seq}`;
      jobs.set(id, {id, prompt: b.prompt, refs: b.refs ?? [], topic: b.topic ?? null, chat: b.chat ?? null, mode: b.mode ?? 'here', grab: !!b.grab, status: 'waiting', step: '', at: Date.now()});
      log('job', id, b.topic ? `topic=${b.topic}` : '(new chat)', `${(b.refs ?? []).length} refs`);
      return send(res, 200, {id});
    }
    const m = /^\/jobs\/(j\d+)$/.exec(p);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      if (!j) return send(res, 404, {error: 'unknown job'});
      return send(res, 200, {status: j.status, step: j.step, error: j.error, chatUrl: j.chatUrl, image: j.status === 'done' ? j.image : undefined, extensionSeen: Date.now() - lastPoll < 20000});
    }
    if (req.method === 'DELETE' && m) {
      const j = jobs.get(m[1]);
      if (j && ['waiting', 'running'].includes(j.status)) Object.assign(j, {status: 'error', error: 'cancelled', at: Date.now()});
      return send(res, 200, {ok: true});
    }
    if (p === '/ext/status') return send(res, 200, {waiting: waiting().length, running: running() ? {id: running().id, step: running().step} : null, extensionSeen: Date.now() - lastPoll < 20000, worker, tabs});
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
      if (worker == null || nb.tab !== worker) return send(res, 200, {job: null});
      if (running()) return send(res, 200, {job: null});
      const j = waiting()[0];
      if (!j) return send(res, 200, {job: null});
      Object.assign(j, {status: 'running', at: Date.now(), step: 'start'});
      log('start', j.id);
      // where: an explicit conversation, the topic's conversation, a new one, or the tab's current one (default)
      const chatUrl = j.chat || (j.topic && chats[j.topic]) || null;
      return send(res, 200, {job: {id: j.id, prompt: j.prompt, refs: j.refs, grab: j.grab, chatUrl, mode: chatUrl ? 'chat' : j.topic ? 'new' : j.mode}});
    }
    const pr = /^\/ext\/progress\/(j\d+)$/.exec(p);
    if (req.method === 'POST' && pr) {
      const b = await body(req);
      const j = jobs.get(pr[1]);
      if (j) (j.step = b.step), log(j.id, b.step);
      return send(res, 200, {ok: true});
    }
    const rr = /^\/ext\/result\/(j\d+)$/.exec(p);
    if (req.method === 'POST' && rr) {
      const b = await body(req);
      const j = jobs.get(rr[1]);
      if (!j) return send(res, 404, {error: 'unknown job'});
      if (b.error) Object.assign(j, {status: 'error', error: b.error, at: Date.now()});
      else {
        Object.assign(j, {status: 'done', image: b.image, chatUrl: b.chatUrl, at: Date.now()});
        if (j.topic && b.chatUrl && /\/c\//.test(b.chatUrl)) (chats[j.topic] = b.chatUrl), saveChats();
      }
      log(j.id, j.status, j.error ?? '');
      return send(res, 200, {ok: true});
    }
    send(res, 404, {error: 'not found'});
  } catch (e) {
    send(res, 500, {error: String(e)});
  }
}).listen(PORT, '127.0.0.1', () => log(`bridge on http://127.0.0.1:${PORT}`));
