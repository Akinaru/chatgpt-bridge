#!/usr/bin/env node
/**
 * ChatGPT tabs seen by the extension, and the one that does the work.
 *   node bridge/tabs.mjs            list the tabs (★ = chosen)
 *   node bridge/tabs.mjs use <id>   make that tab do the work
 *   node bridge/tabs.mjs none       no tab (jobs wait)
 */
const BRIDGE = 'http://127.0.0.1:3777';
const [cmd, id] = process.argv.slice(2);
if (cmd === 'use' || cmd === 'none') {
  const r = await (await fetch(`${BRIDGE}/worker`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({tab: cmd === 'use' ? Number(id) : null})})).json();
  console.log('onglet de travail :', r.worker ?? 'aucun');
} else {
  const s = await (await fetch(`${BRIDGE}/ext/status`)).json();
  if (!s.tabs.length) console.log('aucun onglet ChatGPT vu (extension active ? onglet chatgpt.com ouvert ?)');
  for (const t of s.tabs) console.log(`${t.id === s.worker ? '★' : ' '} ${t.id}\t${t.title}\t${t.url}`);
}
