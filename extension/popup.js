fetch('http://127.0.0.1:3777/ext/status')
  .then((r) => r.json())
  .then((s) => {
    document.getElementById('s').innerHTML = `<span class="ok">Pont local connecté.</span><br>En attente : ${s.waiting} · en cours : ${s.running ? s.running.id + ' (' + (s.running.step || '…') + ')' : 'aucune'}`;
  })
  .catch(() => (document.getElementById('s').innerHTML = '<span class="ko">Pont local éteint.</span><br>Lance : <code>node bridge/server.mjs</code>'));
