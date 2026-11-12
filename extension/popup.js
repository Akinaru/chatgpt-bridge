// Popup (owner 2026-11-12: sober, and readable at a glance): what the bridge is doing now, as steps, with what the
// extension reads in the ChatGPT tab, so a gap between the tab and the bridge is obvious. Tabs, history, settings
// and topics are folded below.
const B = 'http://127.0.0.1:3777';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
};
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const api = async (path, body) => {
  const r = await fetch(B + path, body !== undefined ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  return r.json();
};

const ASK_STEPS = ['Prompt envoyé', 'ChatGPT réfléchit', 'Réponse en cours d’écriture', 'Réponse reçue'];
const IMG_STEPS = ['Prompt envoyé', 'ChatGPT génère l’image', 'Récupération de l’image', 'Image reçue'];
const LATE_MS = 5 * 60000;

/** Reads the bridge step text: kind (ask / image), step index, characters read in the tab, last words read. */
function phase(step) {
  const s = step || '';
  const m = /^answer (\d+) chars via (\w+)(, ChatGPT busy)?/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const peek = (/« (.*) »/.exec(s) || [])[1] || '';
    return {kind: 'ask', i: n === 0 ? 1 : 2, chars: n, peek: peek.replace(/^…\s*/, ''), busy: !!m[3]};
  }
  if (/^waiting for the answer/.test(s)) return {kind: 'ask', i: 1, chars: 0};
  if (/^answer received/.test(s)) return {kind: 'ask', i: 3};
  if (/^(download|grab)/.test(s)) return {kind: 'image', i: 2};
  if (/^generating/.test(s)) return {kind: null, i: 1};
  return {kind: null, i: 0}; // start, upload, effort, waiting uploads, navigating, requeued
}

let status = null;
let hist = null;

async function refresh() {
  try {
    [status, hist] = await Promise.all([api('/ext/status'), api('/history')]);
  } catch {
    status = null;
  }
  render();
}

function renderNow() {
  const r = status.running;
  if (!r) {
    const last = (hist?.history ?? [])[0];
    $('now').innerHTML = `<div class="head"><b>Rien en cours</b></div>${
      last
        ? `<div class="idle">Dernière demande : ${esc(last.topic || 'image')} · <span class="st ${last.status}">${last.status === 'done' ? 'réussie' : 'erreur'}</span> · il y a ${ago(last.ended)}</div>`
        : ''
    }`;
    return;
  }
  const p = phase(r.step);
  const ask = p.kind === 'ask' || (p.kind === null && r.ask);
  const steps = ask ? ASK_STEPS : IMG_STEPS;
  const el = Date.now() - r.since;
  const read = ask && p.i >= 1
    ? `<div class="read">Lu dans l’onglet : <b>${p.chars ?? 0}</b> caractères${p.busy ? ' · ChatGPT travaille' : ''}${p.peek ? `<q>${esc(p.peek)}</q>` : ''}</div>`
    : '';
  const hint = ask && p.i === 1
    ? `<div class="hint">Si l’onglet ChatGPT montre déjà la réponse alors qu’ici c’est encore « ChatGPT réfléchit », la lecture a raté : dis-le à Claude.</div>`
    : '';
  $('now').innerHTML = `<div class="head"><b>${esc(r.topic || 'image')}</b><span class="time ${el > LATE_MS ? 'late' : ''}">${dur(el)}</span></div>
    <ol class="steps">${steps.map((s, i) => `<li class="${i < p.i ? 'done' : i === p.i ? 'cur' : ''}">${s}</li>`).join('')}</ol>
    ${read}${hint}
    <div class="row"><button data-goto="${status.worker ?? ''}">Voir l’onglet</button><button class="danger" data-cancel="${r.id}">Annuler</button></div>`;
}

function render() {
  const pill = $('pill');
  if (!status) {
    pill.className = 'pill ko';
    pill.textContent = 'Pont éteint';
    $('now').innerHTML = '<div class="head"><b>Le pont ne répond pas</b></div><div class="idle">Lance <code>node bridge/server.mjs</code> (une demande <code>submit.mjs</code> le démarre aussi).</div>';
    $('foot').textContent = '';
    return;
  }
  pill.className = `pill ${status.paused ? 'ko' : status.running ? 'run' : status.worker != null ? 'ok' : 'ko'}`;
  pill.textContent = status.paused ? 'En pause' : status.running ? 'En cours' : status.worker != null ? 'Prêt' : 'Aucun onglet';
  const why = {quota: 'quota ChatGPT atteint', 'logged out': 'ChatGPT déconnecté'};
  $('pause').innerHTML = status.paused
    ? `<div class="alert"><b>En pause : ${esc(why[status.paused.reason] ?? status.paused.reason)}</b><div class="muted">${esc(status.paused.detail || '')}</div><div class="row"><button class="primary" id="resume">Reprendre</button></div></div>`
    : '';
  renderNow();
  $('queue').textContent = status.waiting ? `En attente : ${status.queue.map((q) => q.topic || 'image').join(', ')}` : '';
  $('foot').textContent = status.extensionSeen ? 'Onglet de travail connecté.' : 'L’onglet de travail ne répond pas.';
  renderTabs();
  for (const b of $('effort').children) b.classList.toggle('on', b.dataset.v === (status.settings?.effort ?? 'high'));
  $('autoopen').checked = status.settings?.autoOpenTab !== false;
  $('newchat').checked = !!status.settings?.newChat;
  const topics = Object.entries(hist?.topics ?? {});
  $('topics').innerHTML = topics.length
    ? topics.slice(0, 30).map(([t, u]) => `<div class="item"><div class="t"><b>${esc(t)}</b></div><button data-open="${esc(u)}">Ouvrir</button><button class="danger" data-forget="${esc(t)}">Oublier</button></div>`).join('')
    : '<span class="muted">Aucun sujet.</span>';
  const h = hist?.history ?? [];
  $('history').innerHTML = h.length
    ? h.slice(0, 12).map((j) => {
        const img = j.image && /\.(png|jpg|webp)$/.test(j.image) ? `<img src="${B}/images/${esc(j.image)}" alt="" />` : '';
        const d = j.created ? dur(j.ended - j.created) : '';
        return `<div class="item">${img}<div class="t"><b>${esc(j.topic || (j.kind === 'ask' ? 'question' : 'image'))} <span class="st ${j.status}">${j.status === 'done' ? 'réussie' : 'erreur'}</span></b>
          <span>${esc(j.error || '')}${j.error ? ' · ' : ''}il y a ${ago(j.ended)}${d ? ` · ${d}` : ''}</span></div>${j.chatUrl ? `<button data-open="${esc(j.chatUrl)}">Chat</button>` : ''}</div>`;
      }).join('')
    : '<span class="muted">Pas encore de demande.</span>';
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
  $('tabs').innerHTML = tabs.length
    ? tabs.map((t) => `<div class="item ${t.id === status?.worker ? 'on' : ''}"><div class="t"><b>${t.id === status?.worker ? '★ ' : ''}${esc(t.title || 'ChatGPT')}</b><span>${esc(new URL(t.url).pathname === '/' ? 'nouvelle conversation' : new URL(t.url).pathname)}</span></div>${t.id === status?.worker ? '' : `<button data-tab="${t.id}">Choisir</button>`}<button data-goto="${t.id}">Aller</button></div>`).join('')
    : '<span class="muted">Aucun onglet ChatGPT ouvert.</span>';
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-goto],[data-cancel],[data-open],[data-forget],[data-v],#newtab,#untarget,#clear,#resume');
  if (!el) return;
  if (el.dataset.goto !== undefined) {
    const id = Number(el.dataset.goto);
    if (!id) return;
    const t = await chrome.tabs.get(id);
    await chrome.windows.update(t.windowId, {focused: true});
    await chrome.tabs.update(id, {active: true});
    return;
  }
  if (el.dataset.tab) await api('/worker', {tab: Number(el.dataset.tab)});
  else if (el.id === 'untarget') await api('/worker', {tab: null});
  else if (el.id === 'newtab') {
    const t = await chrome.tabs.create({url: 'https://chatgpt.com/', active: false});
    await api('/worker', {tab: t.id});
  } else if (el.dataset.cancel) await fetch(`${B}/jobs/${el.dataset.cancel}`, {method: 'DELETE'});
  else if (el.dataset.open) chrome.tabs.create({url: el.dataset.open});
  else if (el.dataset.forget) await api('/topics/forget', {topic: el.dataset.forget});
  else if (el.dataset.v) await api('/settings', {effort: el.dataset.v});
  else if (el.id === 'clear') await api('/history/clear', {});
  else if (el.id === 'resume') await api('/resume', {});
  refresh();
});
$('newchat').addEventListener('change', async (e) => {
  await api('/settings', {newChat: e.target.checked});
  refresh();
});
$('autoopen').addEventListener('change', async (e) => {
  await api('/settings', {autoOpenTab: e.target.checked});
  refresh();
});

refresh();
setInterval(refresh, 1500);
