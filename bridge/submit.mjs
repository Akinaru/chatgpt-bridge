#!/usr/bin/env node
/**
 * Sends one image job to the bridge and waits for the result.
 *   node bridge/submit.mjs <jobDir> <out.png> [--topic <name>]
 *   node bridge/submit.mjs <jobDir> <answer.txt> --ask [--topic <name>]   text question about refs/ (image review)
 * <jobDir> holds prompt.txt and refs/ (attached in name order). Starts the bridge if it is not running.
 * Guard: if no ChatGPT tab answers, it says so (open Dia / Chrome with a chatgpt.com tab and the extension).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BRIDGE = process.env.AKI_BRIDGE || 'http://127.0.0.1:3777';
const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  if (i < 0) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const flag = (k) => {
  const i = argv.indexOf(k);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const topic = opt('--topic');
const chat = opt('--chat');
const mode = flag('--new') ? 'new' : 'here';
const back = Number(opt('--back')) || 1;
const grab = flag('--grab');
const capture = flag('--capture');
const ask = flag('--ask');
const [jobDir, out] = argv;
if (!jobDir || !out) {
  console.log('usage: node bridge/submit.mjs <jobDir> <out.png> [--new | --chat <url> | --topic <name>] [--grab]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function up() {
  try {
    return (await fetch(`${BRIDGE}/ext/status`)).ok;
  } catch {
    return false;
  }
}
if (!(await up())) {
  const server = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  spawn(process.execPath, [server], {detached: true, stdio: 'ignore'}).unref();
  for (let i = 0; i < 20 && !(await up()); i++) await sleep(250);
  if (!(await up())) throw new Error('bridge did not start');
  log('bridge started on', BRIDGE);
}

const prompt = grab || capture ? '' : fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8').trim();
const refDir = path.join(jobDir, 'refs');
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const refs = !grab && !capture && fs.existsSync(refDir)
  ? fs.readdirSync(refDir).filter((f) => MIME[path.extname(f).toLowerCase()]).sort().map((f) => ({name: f, data: `data:${MIME[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(path.join(refDir, f)).toString('base64')}`}))
  : [];
// guard: a tab must be chosen (never work in someone's conversation by surprise)
const st = await (await fetch(`${BRIDGE}/ext/status`)).json();
if (st.worker == null) {
  console.error('Aucun onglet de travail choisi. Onglets ChatGPT vus :');
  for (const t of st.tabs ?? []) console.error(`  ${t.id}\t${t.title}\t${t.url}`);
  console.error('Choisis-en un : node bridge/tabs.mjs use <id>');
  process.exit(3);
}
if (st.paused) {
  console.error(`ERREUR : pont en pause (${st.paused.reason}) : ${st.paused.detail || ''}`);
  console.error('Rien n’est envoyé. Quand c’est réglé : bouton « Reprendre » dans la popup, ou curl -X POST http://127.0.0.1:3777/resume');
  process.exit(4);
}
const created = await (await fetch(`${BRIDGE}/jobs`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt, refs, topic, chat, mode, grab, back, capture, ask})})).json();
if (created.error) {
  console.error('ERREUR :', created.error);
  process.exit(4);
}
const {id} = created;
log('job', id, created.duplicate ? '(même demande déjà en cours : on l’attend, pas de 2e image)' : '', topic ? `topic « ${topic} »` : '(new conversation)', `${refs.length} refs`);
// this script stopped (Ctrl-C, killed by an agent): cancel the job, so the tab stops instead of generating in the dark
let finished = false;
const cancel = async (sig) => {
  if (!finished) await fetch(`${BRIDGE}/jobs/${id}`, {method: 'DELETE'}).catch(() => {});
  console.error(`arrêté (${sig}) : job ${id} annulé`);
  process.exit(130);
};
process.on('SIGINT', () => cancel('SIGINT'));
process.on('SIGTERM', () => cancel('SIGTERM'));
process.on('SIGHUP', () => cancel('SIGHUP'));

let last = '';
let warned = false;
const t0 = Date.now();
let tRun = 0;
let downSince = 0;
for (;;) {
  await sleep(2000);
  let j;
  try {
    j = await (await fetch(`${BRIDGE}/jobs/${id}`)).json();
    downSince = 0;
  } catch {
    // the bridge stopped: do not resend (an image may still be on its way in the tab), say it and stop
    downSince ||= Date.now();
    if (Date.now() - downSince > 30000) {
      console.error('ERREUR : le pont ne répond plus. Une image a peut-être quand même été générée : vérifie la conversation (--grab) avant de relancer.');
      process.exit(1);
    }
    continue;
  }
  if (j.error === 'unknown job') {
    console.error('ERREUR : le pont a redémarré et ne connaît plus ce job. Vérifie la conversation (--grab) avant de relancer.');
    process.exit(1);
  }
  const line = `${j.status}${j.step ? ' · ' + j.step : ''}`;
  if (line !== last) log(line), (last = line);
  if (j.status === 'waiting' && !j.extensionSeen && Date.now() - t0 > 20000 && !warned) {
    warned = true;
    log('⚠ aucun onglet ChatGPT ne répond : ouvre Dia (ou Chrome) avec un onglet chatgpt.com connecté et l’extension Aki Labs active.');
  }
  if (j.status === 'waiting' && !j.extensionSeen && Date.now() - t0 > 3 * 60000) {
    await fetch(`${BRIDGE}/jobs/${id}`, {method: 'DELETE'}).catch(() => {});
    console.error('ERREUR : pas d’onglet ChatGPT après 3 min.');
    process.exit(1);
  }
  // an image takes 1 to 3 min: past 4 min of generation (counted from the start of the run, not the queue) the tab
  // is stuck, give up instead of waiting forever
  if (j.status === 'waiting') tRun = 0; // requeued by the bridge (tab reloaded before sending): the clock restarts
  else if (!tRun) tRun = Date.now();
  if (tRun && j.status !== 'done' && Date.now() - tRun > (ask ? 26 : 6) * 60000) {
    await fetch(`${BRIDGE}/jobs/${id}`, {method: 'DELETE'}).catch(() => {});
    console.error('ERREUR : génération bloquée (plus de 6 min), job annulé.');
    process.exit(1);
  }
  if (j.status === 'error') {
    console.error('ERREUR :', j.error);
    process.exit(1);
  }
  if (j.status === 'done') {
    const b64 = j.image.split(',')[1];
    // guard (2026-11-11): the tab once returned our own reference image as the result
    const refHit = refs.find((r) => r.data.split(',')[1] === b64);
    if (refHit && !grab) {
      console.error(`ERREUR : le résultat est la référence ${refHit.name} elle-même (pas une image générée). Récupère la vraie image avec --grab si elle est dans la conversation.`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(path.resolve(out)), {recursive: true});
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    finished = true;
    log(ask ? 'réponse enregistrée :' : 'image enregistrée :', out, j.chatUrl ? `(conversation ${j.chatUrl})` : '');
    break;
  }
}
