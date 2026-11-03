// Popup: pick the working ChatGPT tab, follow the current job, settings, topics and a small history.
const B = 'http://127.0.0.1:3777';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const ago = (t) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const STEP = {start: 'démarrage', upload: 'envoi des références', 'waiting uploads': 'références en cours d’envoi', generating: 'génération', download: 'récupération', grab: 'récupération', navigating: 'ouverture de la conversation'};
const api = async (path, body) => {
  const r = await fetch(B + path, body !== undefined ? {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {});
  return r.json();
};

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

function render() {
  const pill = $('pill');
  if (!status) {
    pill.className = 'pill ko';
    pill.textContent = 'pont éteint';
    $('foot').innerHTML = 'Lance le pont : <code>node bridge/server.mjs</code> (ou toute demande <code>submit.mjs</code> le démarre).';
    $('tabs').innerHTML = $('history').innerHTML = $('topics').innerHTML = '';
    $('now').textContent = '—';
    return;
  }
  pill.className = `pill ${status.running ? 'run' : status.worker != null ? 'ok' : 'ko'}`;
  pill.textContent = status.running ? 'génération…' : status.worker != null ? 'prêt' : 'choisis un onglet';
  $('foot').textContent = status.extensionSeen ? 'Onglet de travail connecté.' : 'Aucun onglet ne répond pour l’instant.';
  renderTabs();
  // current job + queue
  const r = status.running;
  $('now').className = r ? 'card' : 'card muted';
  $('now').innerHTML = r
    ? `<div class="row between" style="margin:0"><b>${esc(r.topic || 'image')}</b><span class="small muted">${ago(r.since)}</span></div>
       <div class="small">${esc(STEP[r.step] ?? r.step)}</div><div class="small muted">${esc(r.prompt)}</div>
       <div class="bar"><i></i></div><div class="row"><button class="danger" data-cancel="${r.id}">Annuler</button></div>`
    : 'Rien en cours.';
  $('queue').textContent = status.waiting ? `${status.waiting} en attente : ${status.queue.map((q) => q.topic || 'image').join(', ')}` : '';
  // settings
  for (const b of $('effort').children) b.classList.toggle('on', b.dataset.v === (status.settings?.effort ?? 'high'));
  $('autoopen').checked = status.settings?.autoOpenTab !== false;
  $('newchat').checked = !!status.settings?.newChat;
  // topics
  const topics = Object.entries(hist?.topics ?? {});
  $('topics').innerHTML = topics.length
    ? topics.map(([t, u]) => `<div class="row between" style="margin:0"><b>${esc(t)}</b><span class="acts"><button data-open="${esc(u)}">Ouvrir</button><button class="danger" data-forget="${esc(t)}">Oublier</button></span></div>`).join('')
    : '<span class="muted">Aucun sujet pour l’instant.</span>';
  // history
  const h = hist?.history ?? [];
  $('history').innerHTML = h.length
    ? h
        .slice(0, 20)
        .map((j) => {
          const img = j.image && !j.image.endsWith('.html') ? `<img src="${B}/images/${esc(j.image)}" alt="" />` : `<div class="ph">${j.kind === 'capture' ? '⌘' : j.status === 'error' ? '!' : '·'}</div>`;
          const dur = j.created ? `${Math.round((j.ended - j.created) / 1000)} s` : '';
          return `<div class="job">${img}<div class="t"><b>${esc(j.topic || (j.kind === 'grab' ? 'récupération' : j.kind === 'capture' ? 'capture' : 'image'))} <span class="st ${j.status}">${j.status === 'done' ? 'ok' : 'erreur'}</span></b>
            <span>${esc(j.error || j.prompt || '')}</span><span>il y a ${ago(j.ended)} · ${dur}${j.refs ? ` · ${j.refs} réf.` : ''}</span></div>
            <span class="acts">${j.image && !j.image.endsWith('.html') ? `<button data-url="${B}/images/${esc(j.image)}">Voir</button>` : ''}${j.chatUrl ? `<button data-open="${esc(j.chatUrl)}">Chat</button>` : ''}</span></div>`;
        })
        .join('')
    : '<span class="muted small">Pas encore d’image.</span>';
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({url: 'https://chatgpt.com/*'});
  $('tabs').innerHTML = tabs.length
    ? tabs
        .map((t) => `<div class="tab ${t.id === status?.worker ? 'on' : ''}" data-tab="${t.id}"><i class="dot"></i><div class="t"><b>${esc(t.title || 'ChatGPT')}</b><span>${esc(new URL(t.url).pathname === '/' ? 'nouvelle conversation' : new URL(t.url).pathname)}</span></div><button data-goto="${t.id}">Aller</button></div>`)
        .join('')
    : '<span class="muted small">Aucun onglet ChatGPT ouvert.</span>';
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-tab],[data-goto],[data-cancel],[data-open],[data-url],[data-forget],[data-v],#newtab,#untarget,#clear');
  if (!el) return;
  if (el.dataset.goto) {
    e.stopPropagation();
    const id = Number(el.dataset.goto);
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
  else if (el.dataset.url) chrome.tabs.create({url: el.dataset.url});
  else if (el.dataset.forget) await api('/topics/forget', {topic: el.dataset.forget});
  else if (el.dataset.v) await api('/settings', {effort: el.dataset.v});
  else if (el.id === 'clear') await api('/history/clear', {});
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
