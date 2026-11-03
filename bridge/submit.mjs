#!/usr/bin/env node
/**
 * Sends one image job to the bridge and waits for the result.
 *   node bridge/submit.mjs <jobDir> <out.png> [--topic <name>]
 * <jobDir> holds prompt.txt and refs/ (attached in name order). Starts the bridge if it is not running.
 * Guard: if no ChatGPT tab answers, it says so (open Dia / Chrome with a chatgpt.com tab and the extension).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const BRIDGE = 'http://127.0.0.1:3777';
const argv = process.argv.slice(2);
const ti = argv.indexOf('--topic');
const topic = ti >= 0 ? argv[ti + 1] : null;
if (ti >= 0) argv.splice(ti, 2);
const [jobDir, out] = argv;
if (!jobDir || !out) {
  console.log('usage: node bridge/submit.mjs <jobDir> <out.png> [--topic <name>]');
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

const prompt = fs.readFileSync(path.join(jobDir, 'prompt.txt'), 'utf8').trim();
const refDir = path.join(jobDir, 'refs');
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'};
const refs = fs.existsSync(refDir)
  ? fs.readdirSync(refDir).filter((f) => MIME[path.extname(f).toLowerCase()]).sort().map((f) => ({name: f, data: `data:${MIME[path.extname(f).toLowerCase()]};base64,${fs.readFileSync(path.join(refDir, f)).toString('base64')}`}))
  : [];
const {id} = await (await fetch(`${BRIDGE}/jobs`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({prompt, refs, topic})})).json();
log('job', id, topic ? `topic « ${topic} »` : '(new conversation)', `${refs.length} refs`);

let last = '';
let warned = false;
const t0 = Date.now();
for (;;) {
  await sleep(2000);
  const j = await (await fetch(`${BRIDGE}/jobs/${id}`)).json();
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
  if (j.status === 'error') {
    console.error('ERREUR :', j.error);
    process.exit(1);
  }
  if (j.status === 'done') {
    const b64 = j.image.split(',')[1];
    fs.mkdirSync(path.dirname(path.resolve(out)), {recursive: true});
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    log('image enregistrée :', out, j.chatUrl ? `(conversation ${j.chatUrl})` : '');
    break;
  }
}
